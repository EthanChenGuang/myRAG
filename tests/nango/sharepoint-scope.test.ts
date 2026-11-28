import { describe, expect, it } from 'vitest';
import { inScope, parentMapOf, scopeOf, scopeRemovals, type DriveSelection } from '@/lib/nango/sharepoint/scope';
import type { GraphSourceChange } from '@/lib/nango/sharepoint/delta';

const file = (fileId: string, parentId: string | undefined, driveId = 'drive-a', siteId = 'site-a'): GraphSourceChange => ({
    fileId,
    deleted: false,
    kind: 'file',
    name: `${fileId}.pdf`,
    ...(parentId ? { parentId } : {}),
    driveId,
    siteId,
});
const folder = (fileId: string, parentId: string, driveId = 'drive-a'): GraphSourceChange => ({
    fileId,
    deleted: false,
    kind: 'folder',
    name: fileId,
    parentId,
    driveId,
});

const folderSelection: DriveSelection = { sites: [], drives: [], folders: [{ id: 'F1', name: 'Folder 1', driveId: 'drive-a' }] };

describe('inScope (D-22)', () => {
    const changes = [folder('F1', 'root-a'), folder('F1-sub', 'F1'), folder('F2', 'root-a'), file('in-sub', 'F1-sub'), file('sibling', 'root-a')];
    const parents = parentMapOf(changes);

    it('a file whose parent chain reaches the selected folder is in scope', () => {
        expect(inScope(file('in-sub', 'F1-sub'), folderSelection, parents)).toBe(true);
        expect(inScope(file('direct', 'F1'), folderSelection, parents)).toBe(true);
    });

    it('a sibling under the root and a file in another folder are out of scope', () => {
        expect(inScope(file('sibling', 'root-a'), folderSelection, parents)).toBe(false);
        expect(inScope(file('other', 'F2'), folderSelection, parents)).toBe(false);
        expect(inScope(file('orphan', undefined), folderSelection, parents)).toBe(false);
    });

    it('a file under a selected library root is in scope; a file of another drive is not', () => {
        const library: DriveSelection = { sites: [], drives: [{ id: 'drive-a', name: 'Library 1' }], folders: [] };
        expect(inScope(file('top', 'root-a'), library, parents)).toBe(true);
        expect(inScope(file('elsewhere', 'root-b', 'drive-b'), library, parents)).toBe(false);
        const site: DriveSelection = { sites: [{ id: 'site-a', name: 'Site A' }], drives: [], folders: [] };
        expect(inScope(file('top', 'root-a'), site, parents)).toBe(true);
        expect(inScope(file('elsewhere', 'root-b', 'drive-b', 'site-b'), site, parents)).toBe(false);
    });

    it('a parent unknown in this response set is resolved from the stored parent map', () => {
        const fresh = parentMapOf([file('late', 'F1-sub')]);
        expect(inScope(file('late', 'F1-sub'), folderSelection, fresh)).toBe(false);
        const stored = new Map<string, string | null>([
            ['F1-sub', 'F1'],
            ['F1', 'root-a'],
        ]);
        expect(inScope(file('late', 'F1-sub'), folderSelection, parentMapOf([file('late', 'F1-sub')], stored))).toBe(true);
    });

    it('a folder of the same id in another drive does not count, and a parent cycle stops', () => {
        expect(inScope(file('cross', 'F1', 'drive-b'), folderSelection, parents)).toBe(false);
        const cyclic = new Map<string, string | null>([
            ['L1', 'L2'],
            ['L2', 'L1'],
        ]);
        expect(inScope(file('loop', 'L1'), folderSelection, cyclic)).toBe(false);
    });

    it('newer parent information in the changes overrides the stored map', () => {
        const stored = new Map<string, string | null>([['F1-sub', 'F1']]);
        const moved = parentMapOf([folder('F1-sub', 'F2')], stored);
        expect(moved.get('F1-sub')).toBe('F2');
    });
});

describe('scopeRemovals (Pitfall 15)', () => {
    it('reports a synced file that moved from the selected folder to an unselected one', () => {
        const changes = [file('moved', 'F2'), file('stayed', 'F1'), file('new-outside', 'F2')];
        const parents = parentMapOf(changes, new Map([['F1', 'root-a'], ['F2', 'root-a']]), ['root-a']);
        const synced = [
            { fileId: 'moved', driveId: 'drive-a' },
            { fileId: 'stayed', driveId: 'drive-a' },
        ];
        expect(scopeOf(file('moved', 'F2'), folderSelection, parents)).toBe('out');
        expect(scopeRemovals(synced, changes, folderSelection, parents)).toEqual(['moved']);
    });

    it('reports synced files under a folder that moved out, even when the files are not in the changes', () => {
        const changes = [folder('F1-sub', 'F2')];
        const stored = new Map<string, string | null>([
            ['child-1', 'F1-sub'],
            ['child-2', 'F1'],
            ['F1', 'root-a'],
            ['F2', 'root-a'],
            ['F1-sub', 'F1'],
            ['root-a', null],
        ]);
        const parents = parentMapOf(changes, stored);
        const synced = [
            { fileId: 'child-1', driveId: 'drive-a' },
            { fileId: 'child-2', driveId: 'drive-a' },
        ];
        expect(scopeRemovals(synced, changes, folderSelection, parents)).toEqual(['child-1']);
    });

    it('ignores deleted items (the deletion path handles them) and unsynced out-of-scope items', () => {
        const changes: GraphSourceChange[] = [{ fileId: 'gone', deleted: true, kind: 'file', driveId: 'drive-a' }, file('never-synced', 'F2')];
        const parents = parentMapOf(changes, new Map([['F2', 'root-a']]));
        expect(scopeRemovals([{ fileId: 'gone', driveId: 'drive-a' }], changes, folderSelection, parents)).toEqual([]);
    });

    it('never reports a file whose parent chain is unknown (the full enumeration is the backstop)', () => {
        const changes = [file('drifted', 'F9')];
        const parents = parentMapOf(changes, new Map([['root-a', null]]));
        expect(scopeOf(file('drifted', 'F9'), folderSelection, parents)).toBe('unknown');
        expect(scopeRemovals([{ fileId: 'drifted', driveId: 'drive-a' }], changes, folderSelection, parents)).toEqual([]);
    });

    it('a synced file of a drive that is no longer selected is a removal candidate', () => {
        const library: DriveSelection = { sites: [], drives: [{ id: 'drive-a', name: 'Library 1' }], folders: [] };
        expect(scopeRemovals([{ fileId: 'old', driveId: 'drive-b' }], [], library, new Map())).toEqual(['old']);
    });
});
