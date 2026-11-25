import { describe, expect, test } from 'vitest';
import {
  RETRIEVAL_BACKEND_IDS,
  type BackendLegs,
  type BackendSearchRequest,
  type RetrievalBackend,
  type RetrievalFilters,
} from '@/lib/rag/backend/types';
import type { RefusalRecord } from '@/lib/rag/refusal/types';
import { RERANK_TEXT_VERSION, type Reranker } from '@/lib/rag/rerank/types';
import type { RetrievalOverrides } from '@/lib/rag/types';
import { mintScope } from '@/lib/rag/tenant/scope';

describe('v2 contract literals type-check', () => {
  test('RETRIEVAL_BACKEND_IDS and RERANK_TEXT_VERSION', () => {
    expect(RETRIEVAL_BACKEND_IDS).toEqual(['pgvector', 'weaviate', 'qdrant']);
    expect(RERANK_TEXT_VERSION).toBe(1);
  });

  test('RetrievalBackend, BackendSearchRequest, RefusalRecord, RetrievalOverrides literals', async () => {
    const scope = mintScope('single', null, null);
    const filters: RetrievalFilters = {
      currentOnly: true,
      languages: ['en'],
    };
    const searchReq: BackendSearchRequest = {
      scope,
      embeddingProfileId: 'default',
      denseVector: null,
      lexicalTokens: ['hello'],
      lexicalLanguages: null,
      filters,
      denseLimit: 0,
      lexicalLimit: 10,
      signal: new AbortController().signal,
    };
    const legs: BackendLegs = { dense: [], lexical: [] };
    const backend: RetrievalBackend = {
      id: 'pgvector',
      async search() {
        return legs;
      },
      async health() {
        return { ok: true };
      },
      async isReady() {
        return true;
      },
    };
    const searchOut = await backend.search(searchReq);
    expect(searchOut).toEqual(legs);

    const refusal: RefusalRecord = {
      decision: 'not_applied',
      basis: 'none',
      reason: 'switch_off',
      topScore: null,
      threshold: null,
      cellKey: null,
    };
    expect(refusal.decision).toBe('not_applied');

    const overrides: RetrievalOverrides = {
      reranker: 'cohere',
      switches: { lexicalSearch: true },
    };
    expect(overrides.rrfK).toBeUndefined();
  });

  test('Reranker contract shape', () => {
    const reranker: Reranker = {
      id: 'local_bm25',
      model: 'bm25-pool',
      scoreSemantics: 'relative',
      supportedLanguages: [],
      async rerank() {
        return { scores: [{ index: 0, score: 1 }] };
      },
    };
    expect(reranker.scoreSemantics).toBe('relative');
  });
});