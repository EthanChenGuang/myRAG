import { z } from 'zod/v3';
import { isGraphId, type SharePointProvider } from './config';
import type { GraphSourceChange } from './delta';

/**
 * Scope of a SharePoint / OneDrive selection (Phase 6.3, D-22, Pitfall 15). Delta responses carry no paths, so an item
 * is placed by walking `parentReference.id` up to a selected folder, through a parent map of item id → parent id that
 * the caller keeps across reads (null marks a drive root). A selected site or drive takes every item in it.
 *
 * `scopeOf` answers `unknown` when the walk meets an id it has no parent for, or a cycle: such an item is not synced
 * (fail closed) and never reported as a removal; the next full enumeration settles it.
 */
export interface DriveSelection {
    sites: Array<{ id: string; name: string; parentId?: string }>;
    drives: Array<{ id: string; name: string; parentId?: string }>;
    folders: Array<{ id: string; name: string; driveId: string; parentId?: string }>;
}

/** Most entries one saved selection may hold, across sites, drives and folders (T-06.3-34). */
export const MAX_SELECTION_ENTRIES = 200;

const graphId = z.string().refine(isGraphId);
const entryName = z.string().min(1).max(512);
const entry = z.object({ id: graphId, name: entryName, parentId: graphId.optional() }).strict();

const selectionSchema = z
    .object({
        sites: z.array(entry).max(MAX_SELECTION_ENTRIES),
        drives: z.array(entry).max(MAX_SELECTION_ENTRIES),
        folders: z.array(entry.extend({ driveId: graphId }).strict()).max(MAX_SELECTION_ENTRIES),
    })
    .strict()
    .refine((value) => value.sites.length + value.drives.length + value.folders.length <= MAX_SELECTION_ENTRIES);

/**
 * The picker's selection as stored in `nango_connections.metadata.source_scope` (D-22), or null when it is malformed,
 * over the cap, or names sites on a OneDrive connection.
 */
export function parseSourceScope(value: unknown, provider: SharePointProvider): DriveSelection | null {
    const parsed = selectionSchema.safeParse(value);
    if (!parsed.success) return null;
    if (provider === 'one-drive' && parsed.data.sites.length > 0) return null;
    return parsed.data;
}

/** Item id → parent item id; null for a drive root. */
export type ParentMap = ReadonlyMap<string, string | null>;

export type ScopeVerdict = 'in' | 'out' | 'unknown';

export interface ScopeItem {
    fileId: string;
    parentId?: string;
    driveId?: string;
    siteId?: string;
}

const MAX_DEPTH = 256;

/** The stored map updated with this read: newer parent ids win, deleted items drop out, root ids map to null. */
export function parentMapOf(changes: GraphSourceChange[], stored?: ParentMap, rootIds?: Iterable<string>): Map<string, string | null> {
    const map = new Map<string, string | null>(stored ?? []);
    for (const rootId of rootIds ?? []) map.set(rootId, null);
    for (const change of changes) {
        if (change.deleted) {
            map.delete(change.fileId);
            continue;
        }
        if (change.parentId) map.set(change.fileId, change.parentId);
    }
    return map;
}

export function scopeOf(item: ScopeItem, selection: DriveSelection, parents: ParentMap): ScopeVerdict {
    const verdict = walkScope(item, selection, parents);
    // A selected site takes all of its drives: without the item's site id, "out" cannot be proven.
    if (verdict === 'out' && selection.sites.length > 0 && !item.siteId) return 'unknown';
    return verdict;
}

function walkScope(item: ScopeItem, selection: DriveSelection, parents: ParentMap): ScopeVerdict {
    if (item.siteId && selection.sites.some((site) => site.id === item.siteId)) return 'in';
    if (item.driveId && selection.drives.some((drive) => drive.id === item.driveId)) return 'in';

    const folderIds = new Set(selection.folders.filter((entry) => entry.driveId === item.driveId).map((entry) => entry.id));
    if (!item.driveId || folderIds.size === 0) return item.driveId ? 'out' : 'unknown';
    if (folderIds.has(item.fileId)) return 'in';

    const visited = new Set<string>([item.fileId]);
    let current: string | null | undefined = item.parentId ?? parents.get(item.fileId);
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        if (current === null) return 'out';
        if (current === undefined || visited.has(current)) return 'unknown';
        if (folderIds.has(current)) return 'in';
        visited.add(current);
        current = parents.get(current);
    }
    return 'unknown';
}

export function inScope(item: ScopeItem, selection: DriveSelection, parents: ParentMap): boolean {
    return scopeOf(item, selection, parents) === 'in';
}

/**
 * Previously synced files that now resolve outside the selection: moved out themselves, under a folder that moved
 * out, or in a site or drive that is no longer selected. Deleted items are left to the deletion path.
 */
export function scopeRemovals(
    previouslySynced: Iterable<ScopeItem>,
    changes: GraphSourceChange[],
    selection: DriveSelection,
    parents: ParentMap,
): string[] {
    const latest = new Map(changes.map((change) => [change.fileId, change]));
    const removals: string[] = [];
    for (const synced of previouslySynced) {
        const change = latest.get(synced.fileId);
        if (change?.deleted) continue;
        const item: ScopeItem = change
            ? { fileId: change.fileId, parentId: change.parentId, driveId: change.driveId ?? synced.driveId, siteId: change.siteId ?? synced.siteId }
            : { ...synced, parentId: parents.get(synced.fileId) ?? synced.parentId };
        if (scopeOf(item, selection, parents) === 'out') removals.push(synced.fileId);
    }
    return removals;
}
