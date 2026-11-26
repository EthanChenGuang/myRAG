import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import { TerminologyParamsSchema } from '@/lib/rag-eval/contracts.generated';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { storeBypassReason, type StoreTurnFacts } from '@/lib/rag/cache/bypass';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheKeyParts, CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { RetrievalCacheContext, RetrievalResult } from '@/lib/rag/types';
import { computeRetrievalConfigHash, terminologyHashBlock, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import { cachedAnswer, SCOPE_SINGLE } from './fixtures';

/** The fake dictionary: its version, or null to make the load fail (the stage then records skipped). */
const dictionaryState: { version: string | null } = { version: 's1' };

vi.mock('@/lib/rag/terminology/load', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/terminology/load')>();
  return {
    ...original,
    terminologyMatcherFor: async () => {
      if (dictionaryState.version === null) throw new original.TerminologyLoadError('fixture load failure');
      return {
        dictionary: { tenantKey: 's:default', entries: [], sharedVersion: 1, workspaceVersion: 0, version: dictionaryState.version },
        matcher: { match: () => [] },
      };
    },
  };
});

const QUESTION = 'What does the sample widget report to the operator?';
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: 'b'.repeat(64),
  webSearch: false,
  mcpTools: false,
  chatId: null,
};

const KEY_BASE: Omit<CacheKeyParts, 'retrievalConfigHash'> = {
  answerLanguage: 'en',
  ragMode: 'strict',
  generatorModel: 'provider/model-a',
  queryFramework: 'llamaindex',
  entryProfile: 'chat',
  systemPromptHash: 'b'.repeat(64),
};

function literalHashInput(): RetrievalConfigHashInput {
  return {
    backendId: 'pgvector',
    embeddingProfileId: 'openai-3-small-1536',
    lexicalVersion: 1,
    rerankTextVersion: 1,
    params: { candidate_pool_size: 75, final_top_k: 8, rrf_k: 60, schema_version: 1 } as RetrievalConfigHashInput['params'],
    reranker: { id: 'none', model: 'none' },
    thresholdsConfigHash: null,
    activeChunkingProfiles: { general: 'legacy' },
    switches: {
      lexicalSearch: true,
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
}

function keyFor(version: string | null): string {
  const block = terminologyHashBlock({ enabled: true, version }, TerminologyParamsSchema.parse({}), false);
  return computeCacheKeyHash({ ...KEY_BASE, retrievalConfigHash: computeRetrievalConfigHash({ ...literalHashInput(), terminology: block }) });
}

describe('the semantic-cache key follows the terminology version (04.1.1-16, key level)', () => {
  it('keys built with s1.w0 and s2.w0 differ, and terminology:unavailable differs from both', () => {
    const s1 = keyFor('s1');
    const s2 = keyFor('s2');
    const unavailable = keyFor(null);
    expect(new Set([s1, s2, unavailable]).size).toBe(3);
  });

  it('a workspace version bump changes the key too', () => {
    expect(keyFor('s1.w1')).not.toBe(keyFor('s1.w2'));
  });

  it('with the stage disabled the key equals the key without terminology', () => {
    const none = computeCacheKeyHash({ ...KEY_BASE, retrievalConfigHash: computeRetrievalConfigHash(literalHashInput()) });
    const disabled = terminologyHashBlock({ enabled: false }, TerminologyParamsSchema.parse({}), false);
    expect(disabled).toBeUndefined();
    expect(computeCacheKeyHash({ ...KEY_BASE, retrievalConfigHash: computeRetrievalConfigHash({ ...literalHashInput(), terminology: disabled }) })).toBe(none);
  });
});

/** A cache that hits only for a retrievalConfigHash it holds an entry under. */
function keyedCache() {
  const stored = new Set<string>();
  const checks: CacheQuery[] = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      return stored.has(q.retrievalConfigHash) ? { entryId: 'entry-1', distance: 0.01, answer: cachedAnswer() } : null;
    },
    async store() {},
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, checks, stored };
}

async function run(cache: SemanticCache, envOver: Record<string, string> = {}) {
  resetRagConfigForTests();
  resetActiveChunkingProfilesForTests();
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  installDeps({
    embedder: async () => [0.1, 0.2, 0.3],
    adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    semanticCache: () => cache,
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      RAG_QUERY_LAYER: 'true',
      RAG_SEMANTIC_CACHE: 'pgvector',
      RAG_TERMINOLOGY: 'true',
      ...envOver,
    }),
  });
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search() {
      return { dense: [hit('chunk-1', { rank: 1, similarity: 0.9, documentId: DOC, chunkIndex: 0 })], lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
  await verifyV2Startup();
  const collector = createTraceCollector({ profile: 'chat', tenantKey: scopeKey(SCOPE_SINGLE) });
  const result: RetrievalResult = await runRetrieval({
    scope: SCOPE_SINGLE,
    query: QUESTION,
    profile: 'chat',
    options: { ragMode: 'strict', webSearchEnabled: false, maxResults: 25 },
    signal: new AbortController().signal,
    trace: collector,
    cacheContext: CONTEXT,
  });
  return { result, stages: collector.stages() };
}

describe('the semantic_cache stage misses after a dictionary edit (04.1.1-16, stage level, D-40 present)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetV2StartupForTests();
    dictionaryState.version = 's1';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('the terminology stage runs before semantic_cache and its version is in the looked-up key', async () => {
    const { cache, checks } = keyedCache();
    const { result, stages } = await run(cache);
    const names = stages.map((row) => row.name);
    expect(names.indexOf('terminology')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('terminology')).toBeLessThan(names.indexOf('semantic_cache'));
    expect(checks).toHaveLength(1);
    expect(result.cacheTicket?.key.retrievalConfigHash).toBe(checks[0]!.retrievalConfigHash);
    expect(result.retrievalConfigHash).toBe(checks[0]!.retrievalConfigHash);
  });

  it('an entry stored under s1 is found under s1 and not found after a shared-layer bump to s2', async () => {
    const { cache, checks, stored } = keyedCache();
    const first = await run(cache);
    expect(first.result.reason).not.toBe('cache_hit');
    stored.add(checks[0]!.retrievalConfigHash);

    const again = await run(cache);
    expect(again.result.reason).toBe('cache_hit');

    dictionaryState.version = 's2';
    const edited = await run(cache);
    expect(checks[2]!.retrievalConfigHash).not.toBe(checks[0]!.retrievalConfigHash);
    expect(edited.result.reason).not.toBe('cache_hit');
    expect(edited.result.cacheHit).toBeUndefined();
  });

  it('a skipped terminology stage degrades the request, looks up under terminology:unavailable, misses and is not stored', async () => {
    const { cache, checks, stored } = keyedCache();
    await run(cache);
    stored.add(checks[0]!.retrievalConfigHash);

    dictionaryState.version = null;
    const { result, stages } = await run(cache);
    expect(stages.find((row) => row.name === 'terminology')?.status).toBe('skipped');
    expect(result.status).toBe('degraded');
    expect(result.reason).not.toBe('cache_hit');
    expect(checks[1]!.retrievalConfigHash).not.toBe(checks[0]!.retrievalConfigHash);

    const facts = { ...result.cacheTicket!.turn, chatId: null, sourceImages: false, retrievalStatus: result.status, groundednessLabel: null, embedStore: false, answerText: 'A neutral placeholder answer.' } satisfies StoreTurnFacts;
    expect(storeBypassReason(facts)).toBe('retrieval_status');
  });

  it('with RAG_TERMINOLOGY=false the looked-up key equals the key of a run without terminology code', async () => {
    const on = keyedCache();
    await run(on.cache);
    const off = keyedCache();
    const { stages } = await run(off.cache, { RAG_TERMINOLOGY: 'false' });
    expect(stages.find((row) => row.name === 'terminology')?.status).toBe('disabled');
    expect(off.checks[0]!.retrievalConfigHash).not.toBe(on.checks[0]!.retrievalConfigHash);
    const disabledByRequest = keyedCache();
    await run(disabledByRequest.cache, { RAG_DISABLED_STAGES: 'terminology' });
    expect(disabledByRequest.checks[0]!.retrievalConfigHash).toBe(off.checks[0]!.retrievalConfigHash);
  });
});
