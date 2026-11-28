import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import type { CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { RetrievalCacheContext, RetrievalResult } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import { cachedAnswer, SCOPE_SINGLE } from './fixtures';

const QUESTION = 'What does the sample widget report to the operator?';
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: 'b'.repeat(64),
  webSearch: false,
  mcpTools: false,
  chatId: null,
};
const RETRIEVAL_STAGES = ['embed', 'search', 'exact_id_lookup', 'fuse', 'dedupe', 'rerank', 'refusal', 'expand_parents', 'compress', 'injection_check', 'assemble'];

/** A backend that answers every check with the same entry. */
function alwaysHit(answer: CachedAnswer) {
  const checks: CacheQuery[] = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      return { entryId: 'entry-1', distance: 0.02, answer };
    },
    async store() {},
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, checks };
}

async function run(cache: SemanticCache, envOver: Record<string, string> = {}) {
  resetActiveChunkingProfilesForTests();
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  const embedded: string[] = [];
  installDeps({
    embedder: async (text) => {
      embedded.push(text);
      return [0.1, 0.2, 0.3];
    },
    adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    semanticCache: () => cache,
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      RAG_QUERY_LAYER: 'true',
      RAG_SEMANTIC_CACHE: 'pgvector',
      ...envOver,
    }),
  });
  const seen = { searches: 0 };
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search() {
      seen.searches += 1;
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
  return { result, seen, embedded, stages: collector.stages() };
}

describe('cache-hit short-circuit (D-32, D-36, A-2)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  it('a hit skips search, rank and context and returns ok, cache_hit, the cached answer and the query plan', async () => {
    const answer = cachedAnswer();
    const { cache, checks } = alwaysHit(answer);
    const { result, seen, stages, embedded } = await run(cache);

    expect(checks).toHaveLength(1);
    expect(seen.searches).toBe(0);
    expect(embedded).toEqual([QUESTION]);
    expect(stages.map((row) => row.name).filter((name) => RETRIEVAL_STAGES.includes(name))).toEqual([]);
    expect(stages.find((row) => row.name === 'semantic_cache')).toMatchObject({ status: 'ok', detail: 'hit distance=0.0200' });
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('cache_hit');
    expect(result.cacheHit).toEqual({ entryId: 'entry-1', distance: 0.02, answer });
    expect(result.queryPlan?.original).toBe(QUESTION);
    expect(result.context).toBe('');
    expect(result.candidates).toEqual([]);
    expect(result.refusal).toBeNull();
    expect(result.cacheTicket).toBeUndefined();
  });

  it('a cached refusal hit carries is_refusal so the route can render the localized refusal', async () => {
    const { cache } = alwaysHit(cachedAnswer({ is_refusal: true }));
    const { result, seen } = await run(cache);
    expect(seen.searches).toBe(0);
    expect(result.reason).toBe('cache_hit');
    expect(result.cacheHit?.answer.is_refusal).toBe(true);
  });

  it('a hit never happens when the layer is off: no check, normal retrieval', async () => {
    const { cache, checks } = alwaysHit(cachedAnswer());
    const { result, seen, stages } = await run(cache, { RAG_QUERY_LAYER: 'false' });
    expect(checks).toEqual([]);
    expect(seen.searches).toBeGreaterThan(0);
    expect(result.reason).not.toBe('cache_hit');
    expect(result.cacheHit).toBeUndefined();
    expect(result.cacheTicket).toBeUndefined();
    expect(stages.some((row) => row.name === 'semantic_cache')).toBe(false);
  });
});
