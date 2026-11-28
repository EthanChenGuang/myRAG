import { describe, expect, it } from 'vitest';
import { buildRetrievalFilters, effectiveOnFor } from '@/lib/rag/query/filters';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { cacheKeyFilterParts, computeCacheKeyHash } from '@/lib/rag/cache/keys';
import { loadRagConfig } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import { hasNarrowingFilters } from '@/lib/rag/v2/stages/search';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import { RetrievalParamsSchema } from '@/lib/rag-eval/contracts.generated';
import rawCommitted from '../../eval/config/retrieval-params.json';
import type { RpcClient, RpcRequest } from '@/lib/rag/backend/supabase-rpc';
import type { CacheKeyParts } from '@/lib/rag/cache/types';
import type { RetrievalFilters } from '@/lib/rag/backend/types';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const OFF = loadRagConfig({ RAG_PIPELINE: 'v2' });
const ON = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_EFFECTIVE_DATES: 'true' });
const LATE = Date.parse('2026-03-14T23:30:00.000Z');
const EARLY_NEXT = Date.parse('2026-03-15T00:30:00.000Z');

const KEY_BASE: CacheKeyParts = {
  answerLanguage: 'en',
  ragMode: 'strict',
  generatorModel: 'provider/model-a',
  retrievalConfigHash: 'a'.repeat(64),
  queryFramework: 'llamaindex',
  entryProfile: 'chat',
  systemPromptHash: 'b'.repeat(64),
};
const RECORDED_KEY = 'fb53541beaa58b6af99961111e1e40dee4c9cfaaff8589eda0a31ede5985bcf6';

const HASH_BASE: RetrievalConfigHashInput = {
  backendId: 'pgvector',
  embeddingProfileId: 'openai-3-small-1536',
  lexicalVersion: 1,
  rerankTextVersion: 1,
  params: RetrievalParamsSchema.parse(rawCommitted),
  reranker: { id: 'none', model: '' },
  thresholdsConfigHash: null,
  activeChunkingProfiles: { pdf: 'legacy-pdf' },
  switches: {
    lexicalSearch: false,
    refusalThreshold: false,
    edgeOrder: false,
    compression: false,
    tokenBudget: 6000,
    parentChild: false,
    iterativeScan: 'off',
    exactScanCutoff: 0,
    lexicalTranslation: false,
    exactIdLookup: false,
    rerankTierChat: 'quality',
    rerankTierVoice: 'fast',
  },
};

function filtersAt(config: typeof ON, nowMs: number): RetrievalFilters {
  return buildRetrievalFilters({ referencedDocumentIds: [], effectiveOn: effectiveOnFor(config, nowMs) });
}

async function rpcArgs(filters: RetrievalFilters): Promise<Record<string, unknown>> {
  const calls: Record<string, unknown>[] = [];
  const client: RpcClient = {
    rpc(_fn, args) {
      calls.push(args);
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => OFF });
  await backend.search({
    scope: mintScope('personal', USER_A, null),
    embeddingProfileId: 'openai-3-small-1536',
    denseVector: [0.1],
    lexicalTokens: [],
    lexicalLanguages: null,
    filters,
    denseLimit: 5,
    lexicalLimit: 0,
    signal: new AbortController().signal,
  });
  return calls[0]!;
}

describe('RAG_EFFECTIVE_DATES off (D-44)', () => {
  it('no effective date reaches the filters, the request, the cache key or the config hash', async () => {
    const filters = filtersAt(OFF, LATE);
    expect(filters).toEqual({ currentOnly: true });
    expect('p_effective_on' in (await rpcArgs(filters))).toBe(false);
    expect(computeCacheKeyHash({ ...KEY_BASE, ...cacheKeyFilterParts(filters) })).toBe(RECORDED_KEY);
    const plain = computeRetrievalConfigHash(HASH_BASE);
    expect(computeRetrievalConfigHash({ ...HASH_BASE, effectiveOn: filters.effectiveOn ?? null })).toBe(plain);
    expect(computeRetrievalConfigHash({ ...HASH_BASE, effectiveOn: undefined })).toBe(plain);
  });

  it('does not count as a narrowing filter', () => {
    expect(hasNarrowingFilters(filtersAt(OFF, LATE))).toBe(false);
  });
});

describe('RAG_EFFECTIVE_DATES on (D-44)', () => {
  it("passes the injected clock's UTC date as p_effective_on, whatever the local zone", async () => {
    expect(effectiveOnFor(ON, LATE)).toBe('2026-03-14');
    expect(effectiveOnFor(ON, EARLY_NEXT)).toBe('2026-03-15');
    expect((await rpcArgs(filtersAt(ON, LATE))).p_effective_on).toBe('2026-03-14');
    expect((await rpcArgs(filtersAt(ON, EARLY_NEXT))).p_effective_on).toBe('2026-03-15');
  });

  it('the date joins the cache key and the config hash, and two days give two of each', () => {
    const late = filtersAt(ON, LATE);
    const early = filtersAt(ON, EARLY_NEXT);
    const keyLate = computeCacheKeyHash({ ...KEY_BASE, ...cacheKeyFilterParts(late) });
    const keyEarly = computeCacheKeyHash({ ...KEY_BASE, ...cacheKeyFilterParts(early) });
    expect(new Set([RECORDED_KEY, keyLate, keyEarly]).size).toBe(3);

    const plain = computeRetrievalConfigHash(HASH_BASE);
    const hashLate = computeRetrievalConfigHash({ ...HASH_BASE, effectiveOn: late.effectiveOn ?? null });
    const hashEarly = computeRetrievalConfigHash({ ...HASH_BASE, effectiveOn: early.effectiveOn ?? null });
    expect(new Set([plain, hashLate, hashEarly]).size).toBe(3);
  });

  it('an effective date is narrowing, so the exact-id leg (which takes no date) stands down', () => {
    expect(hasNarrowingFilters(filtersAt(ON, LATE))).toBe(true);
  });

  it('the request cannot supply the date: an explicit filter never carries it', () => {
    const smuggled = { languages: ['en'], effectiveOn: '1999-01-01' } as unknown as Parameters<typeof buildRetrievalFilters>[0]['explicit'];
    expect(buildRetrievalFilters({ explicit: smuggled, referencedDocumentIds: [] })).toEqual({ currentOnly: true, languages: ['en'] });
  });
});
