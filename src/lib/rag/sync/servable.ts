import type { VectorPoint } from './stores/types';

/** One servable row as rag_vector_sync_document_rows / rag_vector_sync_chunk_row (0705) return it. */
export interface SyncRow {
  chunk_id: string;
  document_id: string;
  tenant_key: string;
  vector: number[] | string;
  lexical_text: string | null;
  lexical_version: number | null;
  content_hash: string | null;
  doc_type: string | null;
  doc_date: string | null;
  language: string | null;
  source: string | null;
  chunking_profile_id: string | null;
  parent_id: string | null;
}

export interface SyncPlan {
  upserts: VectorPoint[];
  deletes: string[];
}

/**
 * The chunk-id range one page of a document covers: ids greater than `after` (open when null) up to and including `through`
 * (open when null). Consecutive pages partition the id space, so every store id is judged by exactly one page.
 */
export interface PageRange {
  after: string | null;
  through: string | null;
}

const FULL_RANGE: PageRange = { after: null, through: null };

function toVector(value: number[] | string): number[] {
  if (Array.isArray(value)) return value.map(Number);
  return String(value)
    .replace(/^[{[]|[}\]]$/g, '')
    .split(',')
    .filter((x) => x.length > 0)
    .map(Number);
}

/** D-03: the payload is built field by field, so content or a document name can never ride along. */
export function toPoint(row: SyncRow): VectorPoint {
  return {
    id: String(row.chunk_id),
    vector: toVector(row.vector),
    payload: {
      tenant_key: row.tenant_key,
      document_id: String(row.document_id),
      doc_type: row.doc_type,
      doc_date: row.doc_date,
      language: row.language,
      source: row.source,
      chunking_profile_id: row.chunking_profile_id,
      parent_id: row.parent_id ? String(row.parent_id) : null,
      lexical_text: row.lexical_text,
      content_hash: row.content_hash,
      lexical_version: row.lexical_version,
    },
  };
}

function inRange(id: string, range: PageRange): boolean {
  if (range.after !== null && id <= range.after) return false;
  if (range.through !== null && id > range.through) return false;
  return true;
}

/**
 * D-02: what one page of a document re-sync writes and deletes. Rows are Supabase's current servable rows for the outbox tenant;
 * a row of any other tenant is never upserted under it. Every store id inside the page range that is not upserted is deleted.
 */
export function planDocumentSync(tenantKey: string, rows: SyncRow[], storeIds: string[], range: PageRange = FULL_RANGE): SyncPlan {
  const upserts = rows.filter((row) => row.tenant_key === tenantKey && inRange(String(row.chunk_id), range)).map(toPoint);
  const keep = new Set(upserts.map((point) => point.id));
  const deletes = [...new Set(storeIds)].filter((id) => inRange(id, range) && !keep.has(id));
  return { upserts, deletes };
}

/** D-02 for one chunk (reconcile repairs): upsert when servable under the outbox tenant, delete otherwise. */
export function planChunkSync(tenantKey: string, row: SyncRow | null, chunkId: string): SyncPlan {
  if (row && row.tenant_key === tenantKey && String(row.chunk_id) === chunkId) return { upserts: [toPoint(row)], deletes: [] };
  return { upserts: [], deletes: [chunkId] };
}
