import type { GraphSourceChange } from './delta';

export interface DriveSelection {
    sites: Array<{ id: string; name: string }>;
    drives: Array<{ id: string; name: string }>;
    folders: Array<{ id: string; name: string; driveId: string }>;
}

export type ParentMap = ReadonlyMap<string, string | null>;

export function parentMapOf(_changes: GraphSourceChange[], _stored?: ParentMap, _rootIds?: Iterable<string>): Map<string, string | null> {
    return new Map();
}

export function scopeOf(_item: { fileId: string; parentId?: string; driveId?: string; siteId?: string }, _selection: DriveSelection, _parents: ParentMap): 'in' | 'out' | 'unknown' {
    return 'in';
}

export function inScope(_item: { fileId: string; parentId?: string; driveId?: string; siteId?: string }, _selection: DriveSelection, _parents: ParentMap): boolean {
    return true;
}

export function scopeRemovals(
    _previouslySynced: Iterable<{ fileId: string; driveId?: string; siteId?: string; parentId?: string }>,
    _changes: GraphSourceChange[],
    _selection: DriveSelection,
    _parents: ParentMap,
): string[] {
    return [];
}
