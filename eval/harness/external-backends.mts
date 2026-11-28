import type { RunBackendSnapshot } from '../../src/lib/rag-eval/contracts.generated.ts';

export type ExternalBackendId = 'weaviate' | 'qdrant';

export const PGVECTOR_SNAPSHOT: RunBackendSnapshot = {
  backend: 'pgvector',
  backend_impl: 'real',
  collection: null,
  hnsw_m: 64,
  hnsw_ef_construction: 200,
  lexical_mode: 'postgres_fts',
  quantization: 'none',
};

export async function prepareExternalBackends(_options: unknown): Promise<{ snapshot: RunBackendSnapshot; close(): Promise<void> }> {
  return { snapshot: PGVECTOR_SNAPSHOT, close: async () => undefined };
}
