import { QDRANT_HNSW, QDRANT_LEXICAL_MODE } from './qdrant/collection';
import { qdrantCollectionName, weaviateCollectionName } from './tenant-key';
import type { BackendId } from './types';

/** The Weaviate collection's index settings; weaviate/collection.ts builds the collection from these values (no SDK import here). */
export const WEAVIATE_INDEX = { lexicalMode: 'bm25_whitespace', m: 64, efConstruction: 200 } as const;

/** D-24: the index parameters of an external backend, as the retrieval config hash records them. */
export interface BackendIndexParams {
  collection: string;
  hnsw_m: number;
  hnsw_ef: number;
  lexical_mode: string;
  quantization: 'none';
}

export const COLLECTION_INVALID = 'collection:invalid';

function collectionOf(build: (profileId: string) => string, profileId: string): string {
  try {
    return build(profileId);
  } catch {
    return COLLECTION_INVALID;
  }
}

/** Null for pgvector, whose hash inputs stay exactly as they were before external backends. */
export function backendIndexParams(backend: BackendId, embeddingProfileId: string): BackendIndexParams | null {
  if (backend === 'qdrant') {
    return {
      collection: collectionOf(qdrantCollectionName, embeddingProfileId),
      hnsw_m: QDRANT_HNSW.m,
      hnsw_ef: QDRANT_HNSW.ef_construct,
      lexical_mode: QDRANT_LEXICAL_MODE,
      quantization: 'none',
    };
  }
  if (backend === 'weaviate') {
    return {
      collection: collectionOf(weaviateCollectionName, embeddingProfileId),
      hnsw_m: WEAVIATE_INDEX.m,
      hnsw_ef: WEAVIATE_INDEX.efConstruction,
      lexical_mode: WEAVIATE_INDEX.lexicalMode,
      quantization: 'none',
    };
  }
  return null;
}
