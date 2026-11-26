import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { RetrievalBackendError } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheKeyParts, CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { resetRagConfigForTests } from '@/lib/rag/config';
import type { AttributeResolution } from '@/lib/rag/retrieval/attributes';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { RetrievalCacheContext, RetrievalResult, RunRetrievalInput } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import { SCOPE_SINGLE } from '../cache/fixtures';

const DOC = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PLANTED_VALUE = 'zeta-17';
const QUERY = `Which part of the record concerns ${PLANTED_VALUE}?`;

type ResolverMode = 'nothing' | 'hard' | 'soft_only' | 'ambiguous' | 'too_broad' | 'explicit' | 'explicit_too_broad' | 'unknown' | 'fail' | 'hang';

const resolverState: { mode: ResolverMode; queries: string[]; digest: string; calls: number } = {
  mode: 'nothing',
  queries: [],
  digest: 'a'.repeat(64),
  calls: 0,
};

function resolution(over: Partial<AttributeResolution>): AttributeResolution {
  return {
    explicitIds: null,
    explicitCappedIds: null,
    hardIds: null,
    softIds: [],
    counts: { explicitKeys: 0, matchedKeys: 0, aliasMatches: 0, ambiguous: 0, softKeys: 0 },
    tooBroad: false,
    lexiconTruncated: false,
    lexiconUnavailable: false,
    aliasUnavailable: false,
    stateDigest: null,
    ...over,
  };
}

vi.mock('@/lib/rag/retrieval/attributes', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/retrieval/attributes')>();
  return {
    ...original,
    resolveAttributeFilter: async (_scope: unknown, query: string, _explicit: unknown, options: { signal?: AbortSignal }) => {
      resolverState.calls += 1;
      resolverState.queries.push(query);
      const digest = resolverState.digest;
      switch (resolverState.mode) {
        case 'nothing':
          return resolution({});
        case 'hard':
          return resolution({ hardIds: [DOC(1), DOC(2)], counts: { explicitKeys: 0, matchedKeys: 1, aliasMatches: 0, ambiguous: 0, softKeys: 0 }, stateDigest: digest });
        case 'soft_only':
          return resolution({ softIds: [DOC(3)], counts: { explicitKeys: 0, matchedKeys: 1, aliasMatches: 0, ambiguous: 0, softKeys: 1 }, stateDigest: digest });
        case 'ambiguous':
          return resolution({ softIds: [DOC(4)], counts: { explicitKeys: 0, matchedKeys: 0, aliasMatches: 0, ambiguous: 1, softKeys: 0 }, stateDigest: digest });
        case 'too_broad':
          return resolution({ softIds: [DOC(5), DOC(6)], tooBroad: true, counts: { explicitKeys: 0, matchedKeys: 1, aliasMatches: 0, ambiguous: 0, softKeys: 0 }, stateDigest: digest });
        case 'explicit':
          return resolution({ explicitIds: [DOC(1), DOC(7)], hardIds: [DOC(1), DOC(2)], counts: { explicitKeys: 1, matchedKeys: 1, aliasMatches: 0, ambiguous: 0, softKeys: 0 }, stateDigest: digest });
        case 'explicit_too_broad':
          return resolution({ explicitCappedIds: [DOC(8), DOC(9)], softIds: [DOC(8), DOC(9)], tooBroad: true, counts: { explicitKeys: 1, matchedKeys: 0, aliasMatches: 0, ambiguous: 0, softKeys: 0 }, stateDigest: digest });
        case 'unknown':
          throw new original.AttributeFilterError('unknown_attribute', 400, 'an attribute key is not a filterable attribute');
        case 'fail':
          throw new RetrievalBackendError('rag_attribute_documents', 'XX000');
        case 'hang':
          return new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          });
      }
    },
  };
});

const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: 'b'.repeat(64),
  webSearch: false,
  mcpTools: false,
  chatId: null,
};

function keyedCache() {
  const checks: CacheQuery[] = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      return null;
    },
    async store() {},
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, checks };
}

interface RunOptions {
  env?: Record<string, string>;
  filter?: 'hard' | 'soft' | 'off' | null;
  explicit?: Record<string, string[]>;
  queryLayer?: boolean;
  cache?: SemanticCache;
  profile?: RunRetrievalInput['profile'];
  stageOverrides?: RunRetrievalInput['stageOverrides'];
}

async function run(options: RunOptions = {}) {
  resetRagConfigForTests();
  resetActiveChunkingProfilesForTests();
  resetV2StartupForTests();
  const requests: BackendSearchRequest[] = [];
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  const filter = options.filter === undefined ? 'hard' : options.filter;
  installDeps({
    embedder: async () => [0.1, 0.2, 0.3],
    adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
    ...(options.queryLayer ? { queryLlm: () => fake } : {}),
    ...(options.cache ? { semanticCache: () => options.cache! } : {}),
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      ...(filter ? { RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_FILTER: filter } : {}),
      ...(options.queryLayer ? { RAG_QUERY_LAYER: 'true', RAG_TERMINOLOGY: 'true' } : {}),
      ...(options.cache ? { RAG_SEMANTIC_CACHE: 'pgvector' } : {}),
      ...options.env,
    }),
  });
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search(req) {
      requests.push(req);
      return { dense: [hit('chunk-1', { rank: 1, similarity: 0.9, documentId: DOC(1), chunkIndex: 0 })], lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
  await verifyV2Startup();
  const profile = options.profile ?? 'chat';
  const collector = createTraceCollector({ profile, tenantKey: scopeKey(SCOPE_SINGLE) });
  const result: RetrievalResult = await runRetrieval({
    scope: SCOPE_SINGLE,
    query: QUERY,
    profile,
    options: { ragMode: 'strict', webSearchEnabled: false, maxResults: 25 },
    signal: new AbortController().signal,
    trace: collector,
    ...(options.cache ? { cacheContext: CONTEXT } : {}),
    ...(options.explicit ? { retrievalFilters: { attributes: options.explicit } } : {}),
    ...(options.stageOverrides ? { stageOverrides: options.stageOverrides } : {}),
  });
  const stages = collector.stages();
  return { result, stages, requests, record: stages.find((row) => row.name === 'attribute_resolve') };
}

function filtersOf(requests: BackendSearchRequest[]) {
  return requests.map((req) => req.filters);
}

describe('attribute_resolve stage (03.3-19, D-29, D-30)', () => {
  beforeEach(() => {
    uninstallDeps();
    resolverState.mode = 'nothing';
    resolverState.queries = [];
    resolverState.digest = 'a'.repeat(64);
    resolverState.calls = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('off: the resolver is never called, the record is disabled, filters and hash equal a run without the switch', async () => {
    resolverState.mode = 'hard';
    const without = await run({ filter: null });
    const off = await run({ filter: 'off' });
    expect(resolverState.calls).toBe(0);
    expect(off.record?.status).toBe('disabled');
    expect(filtersOf(off.requests)).toEqual(filtersOf(without.requests));
    expect(off.result.retrievalConfigHash).toBe(without.result.retrievalConfigHash);
    expect(without.requests[0]!.filters).toEqual({ currentOnly: true });
  });

  it('on with nothing named: ok with zero counts, same filters as off, only the hash differs', async () => {
    const off = await run({ filter: 'off' });
    const on = await run({ filter: 'hard' });
    expect(on.record?.status).toBe('ok');
    expect(on.record?.counts).toEqual({
      explicit_keys: 0,
      matched_keys: 0,
      alias_matches: 0,
      ambiguous: 0,
      hard_ids: 0,
      soft_ids: 0,
      too_broad: 0,
      lexicon_truncated: 0,
      explicit_rejected: 0,
    });
    expect(filtersOf(on.requests)).toEqual(filtersOf(off.requests));
    expect(on.result.retrievalConfigHash).not.toBe(off.result.retrievalConfigHash);
  });

  it('runs after terminology and before semantic_cache and embed, on the standalone query', async () => {
    const { cache, checks } = keyedCache();
    const { stages, result } = await run({ queryLayer: true, cache });
    const names = stages.map((row) => row.name);
    expect(names.indexOf('attribute_resolve')).toBeGreaterThan(names.indexOf('terminology'));
    expect(names.indexOf('attribute_resolve')).toBeLessThan(names.indexOf('semantic_cache'));
    expect(names.indexOf('attribute_resolve')).toBeLessThan(names.indexOf('embed'));
    expect(resolverState.queries).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(result.retrievalConfigHash).toBe(checks[0]!.retrievalConfigHash);
  });

  it('without the query layer it runs once on the request query', async () => {
    const { stages } = await run();
    expect(resolverState.queries).toEqual([QUERY]);
    const names = stages.map((row) => row.name);
    expect(names.indexOf('attribute_resolve')).toBeLessThan(names.indexOf('embed'));
  });

  it('hard: the automatic ids narrow every request', async () => {
    resolverState.mode = 'hard';
    const { requests, record } = await run();
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) expect(req.filters.documentIds).toEqual([DOC(1), DOC(2)]);
    expect(record?.counts).toMatchObject({ matched_keys: 1, hard_ids: 2, soft_ids: 0 });
  });

  it('soft: no automatic id is intersected; the hard-eligible ids become soft ids', async () => {
    resolverState.mode = 'hard';
    const { requests, record } = await run({ filter: 'soft' });
    expect(requests[0]!.filters.documentIds).toBeUndefined();
    expect(record?.counts).toMatchObject({ hard_ids: 2, soft_ids: 2 });
  });

  it('explicit ids narrow in both modes; hard intersects the automatic ids too', async () => {
    resolverState.mode = 'explicit';
    const hard = await run({ explicit: { alpha_code: ['zeta-17'] } });
    expect(hard.requests[0]!.filters.documentIds).toEqual([DOC(1)]);
    const soft = await run({ filter: 'soft', explicit: { alpha_code: ['zeta-17'] } });
    expect(soft.requests[0]!.filters.documentIds).toEqual([DOC(1), DOC(7)]);
  });

  it('an explicit filter above the cap still narrows to its capped ids', async () => {
    resolverState.mode = 'explicit_too_broad';
    const { requests, record } = await run({ explicit: { alpha_code: ['zeta-17'] } });
    expect(requests[0]!.filters.documentIds).toEqual([DOC(8), DOC(9)]);
    expect(record?.counts?.too_broad).toBe(1);
  });

  it('too broad: nothing is intersected, the ids are soft and the detail carries the code', async () => {
    resolverState.mode = 'too_broad';
    const { requests, record } = await run();
    expect(requests[0]!.filters.documentIds).toBeUndefined();
    expect(record?.counts).toMatchObject({ too_broad: 1, soft_ids: 2 });
    expect(record?.detail).toContain('attribute_filter_too_broad');
  });

  it('an unknown explicit key matches nothing: the no-document sentinel, explicit_rejected 1', async () => {
    resolverState.mode = 'unknown';
    const { requests, record } = await run({ explicit: { missing_key: ['x1'] } });
    expect(record?.status).toBe('ok');
    expect(record?.counts?.explicit_rejected).toBe(1);
    expect(requests[0]!.filters.documentIds).toEqual(['00000000-0000-0000-0000-000000000000']);
  });

  it('a failure without an explicit filter skips the stage: filters as off and the result degraded', async () => {
    const off = await run({ filter: 'off' });
    resolverState.mode = 'fail';
    const failed = await run();
    expect(failed.record?.status).toBe('skipped');
    expect(filtersOf(failed.requests)).toEqual(filtersOf(off.requests));
    expect(failed.result.status).toBe('degraded');
  });

  it('a failure with an explicit filter fails the request; the search never runs wider', async () => {
    resolverState.mode = 'fail';
    const { result, requests } = await run({ explicit: { alpha_code: ['zeta-17'] } });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('attribute_resolve_failed');
    expect(requests).toHaveLength(0);
  });

  it('voice uses its own timeout; on timeout the voice request equals the off run', async () => {
    const off = await run({ filter: 'off', profile: 'voice' });
    resolverState.mode = 'hang';
    const hung = await run({ profile: 'voice' });
    expect(hung.record?.status).toBe('skipped');
    expect(hung.record?.reason).toBe('timeout');
    expect(hung.record!.endedAt - hung.record!.startedAt).toBeLessThan(1000);
    expect(filtersOf(hung.requests)).toEqual(filtersOf(off.requests));
    expect(hung.result.voice?.results.map((row) => row.chunk_id)).toEqual(off.result.voice?.results.map((row) => row.chunk_id));
  });

  it('detail and counts never carry the query or a value', async () => {
    for (const mode of ['hard', 'too_broad', 'ambiguous', 'soft_only'] as const) {
      resolverState.mode = mode;
      const { record } = await run();
      const text = JSON.stringify(record);
      expect(text).not.toContain(PLANTED_VALUE);
      expect(text).not.toContain('record concerns');
    }
  });

  it('hash: differs between two resolved states, equal for the same state, disabled by request equals off', async () => {
    resolverState.mode = 'hard';
    const one = await run();
    resolverState.digest = 'c'.repeat(64);
    const two = await run();
    const twoAgain = await run();
    expect(one.result.retrievalConfigHash).not.toBe(two.result.retrievalConfigHash);
    expect(two.result.retrievalConfigHash).toBe(twoAgain.result.retrievalConfigHash);
    const off = await run({ filter: 'off', profile: 'eval' });
    const disabled = await run({ profile: 'eval', stageOverrides: { disabledStages: ['attribute_resolve'] } });
    expect(disabled.result.retrievalConfigHash).toBe(off.result.retrievalConfigHash);
  });

  it('cache key: the hash at check time equals the result hash, and different filters key differently', async () => {
    resolverState.mode = 'hard';
    const first = keyedCache();
    const a = await run({ queryLayer: true, cache: first.cache });
    resolverState.digest = 'd'.repeat(64);
    const second = keyedCache();
    const b = await run({ queryLayer: true, cache: second.cache });
    expect(a.result.retrievalConfigHash).toBe(first.checks[0]!.retrievalConfigHash);
    expect(b.result.retrievalConfigHash).toBe(second.checks[0]!.retrievalConfigHash);
    const base: Omit<CacheKeyParts, 'retrievalConfigHash'> = {
      answerLanguage: 'en',
      ragMode: 'strict',
      generatorModel: 'provider/model-a',
      queryFramework: 'llamaindex',
      entryProfile: 'chat',
      systemPromptHash: 'b'.repeat(64),
    };
    expect(computeCacheKeyHash({ ...base, retrievalConfigHash: first.checks[0]!.retrievalConfigHash })).not.toBe(
      computeCacheKeyHash({ ...base, retrievalConfigHash: second.checks[0]!.retrievalConfigHash }),
    );
  });
});
