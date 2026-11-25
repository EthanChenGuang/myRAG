import { removeVersionObjects } from './artifacts';

const DEFAULT_TIMEOUT_MS = 30_000;

/** The columns of a documents row that name its stored objects. */
export interface DocumentObjectRow {
  id: string;
  lineage_id?: string | null;
  version?: number | null;
  original_path?: string | null;
  processing_state?: unknown;
}

function keysOf(row: DocumentObjectRow): string[] {
  const keys = new Set<string>();
  if (typeof row.original_path === 'string' && row.original_path !== '') keys.add(row.original_path);
  const state = row.processing_state;
  if (typeof state === 'object' && state !== null && !Array.isArray(state)) {
    const artifacts = (state as { artifacts?: unknown }).artifacts;
    if (typeof artifacts === 'object' && artifacts !== null && !Array.isArray(artifacts)) {
      for (const value of Object.values(artifacts)) if (typeof value === 'string' && value !== '') keys.add(value);
    }
  }
  return [...keys];
}

/**
 * Removes the original, parse.md and docling.json of deleted document versions from the private originals bucket (ORIGINALS_BUCKET). Call it after the
 * rows are gone: a storage failure then never leaves a document whose original is missing, and it never changes the answer of the delete.
 * Each key must sit under `<tenant_key>/<lineage_id>/<version>/` of its own row and the tenant key is the caller's verified one, so a key that
 * points at another tenant's path is skipped. Failures are counted and logged by document id only; the keys are not logged.
 */
export async function removeDocumentObjects(input: {
  tenantKey: string;
  rows: DocumentObjectRow[];
  signal?: AbortSignal;
}): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  const signal = input.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  for (const row of input.rows) {
    const keys = keysOf(row);
    if (keys.length === 0) continue;
    let result: { removed: number; failed: number };
    try {
      result = await removeVersionObjects({
        tenantKey: input.tenantKey,
        lineageId: row.lineage_id ?? row.id,
        version: typeof row.version === 'number' ? row.version : 1,
        keys,
        signal,
      });
    } catch {
      result = { removed: 0, failed: keys.length };
    }
    removed += result.removed;
    failed += result.failed;
    if (result.failed > 0) console.error('[Documents] stored objects of a deleted version were not all removed', { documentId: row.id, failed: result.failed });
  }
  return { removed, failed };
}
