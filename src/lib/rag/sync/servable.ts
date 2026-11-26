import type { VectorPoint } from './stores/types';

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

export interface PageRange {
  after: string | null;
  through: string | null;
}

export function toPoint(_row: SyncRow): VectorPoint {
  throw new Error('not implemented');
}

export function planDocumentSync(_tenantKey: string, _rows: SyncRow[], _storeIds: string[], _range?: PageRange): SyncPlan {
  return { upserts: [], deletes: [] };
}

export function planChunkSync(_tenantKey: string, _row: SyncRow | null, _chunkId: string): SyncPlan {
  return { upserts: [], deletes: [] };
}
