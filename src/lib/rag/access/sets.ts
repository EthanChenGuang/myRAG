/**
 * D-25, A-06: a document whose label set the server could not read is stored with this set: a group key nobody holds, so only an
 * admin of the tenant can read the row (fail closed, never "no restriction").
 */
export const UNKNOWN_ACCESS_SET: readonly string[] = Object.freeze(['g:00000000-0000-0000-0000-000000000000']);

const MAX_SETS = 200;

/**
 * D-25, A-06: one access-key array per document (sorted, deduplicated) for the derived stores, from RetrievalResult.accessLabels.
 * Null while access is off (no labels map), so nothing new is written.
 */
export function accessSetsFor(labels: ReadonlyMap<string, readonly string[]> | undefined | null, documentIds: Iterable<string>): string[][] | null {
  if (!labels) return null;
  const ids = [...new Set([...documentIds].filter((id) => typeof id === 'string' && id.length > 0))].sort();
  return ids.slice(0, MAX_SETS).map((id) => {
    const keys = labels.get(id);
    const clean = keys ? [...new Set(keys.filter((key) => typeof key === 'string' && key.length > 0))].sort() : [];
    return clean.length > 0 ? clean : [...UNKNOWN_ACCESS_SET];
  });
}
