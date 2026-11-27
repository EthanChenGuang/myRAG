import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheHit, SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import type { RagDeps } from '@/lib/rag/deps';
// Loaded up front: the v2 query stage imports it dynamically, which fake timers would stall.
import '@/lib/rag/query/run-layer';
import '@/lib/rag/v2/pipeline';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, RetrievalCacheContext, RetrievalResult, StageRecord } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { cachedAnswer } from '../cache/fixtures';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const gate = vi.hoisted(() => ({ outOfScope: false }));
vi.mock('@/lib/rag/scope/stage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/scope/stage')>();
  return {
    ...actual,
    runScopeGateStage: (input: Parameters<typeof actual.runScopeGateStage>[0]) =>
      gate.outOfScope
        ? { label: 'out_of_scope', reason: 'below_threshold', score: 0.1, negative_score: null, centroid_count: 1, latency_ms: 0 }
        : actual.runScopeGateStage(input),
  };
});

const scope = mintScope('single', null, null);
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONDENSE_MS = 400;
const SEARCH_MS = 600;

const HISTORY: HistoryTurn[] = [
  { role: 'user', content: 'Tell me about the sample gateway service.' },
  { role: 'assistant', content: 'The sample gateway service routes synthetic requests between modules.' },
];
const FOLLOW_UP = 'What changed in it?';
const CONDENSED = 'What changed in the sample gateway service?';

const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: 'b'.repeat(64),
  webSearch: false,
  mcpTools: false,
  chatId: null,
};

/** A distinct vector per text, so each search names the text it was embedded from. */
function vectorFor(text: string): number[] {
  let sum = 0;
  for (const char of text) sum = (sum * 31 + char.charCodeAt(0)) % 9973;
  return [text.length, sum, 1];
}

interface SearchCall {
  at: number;
  vector: number[] | null;
  request: BackendSearchRequest;
}

interface Recorder {
  embeds: Array<{ text: string; at: number }>;
  searches: SearchCall[];
  failFirstSearch: boolean;
}

function embedderFor(rec: Recorder): RagDeps['embedder'] {
  return (text, { signal }) => {
    rec.embeds.push({ text, at: Date.now() });
    if (signal.aborted) return Promise.reject(signal.reason);
    return Promise.resolve(vectorFor(text));
  };
}

function backendFor(rec: Recorder): RetrievalBackend {
  return {
    id: 'pgvector',
    search(req) {
      const call: SearchCall = { at: Date.now(), vector: req.denseVector, request: req };
      rec.searches.push(call);
      const index = rec.searches.length - 1;
      return new Promise<BackendLegs>((resolve, reject) => {
        if (req.signal.aborted) {
          reject(req.signal.reason);
          return;
        }
        const timer = setTimeout(() => {
          if (rec.failFirstSearch && index === 0) {
            reject(new Error('synthetic speculative search failure'));
            return;
          }
          const key = (req.denseVector ?? []).join('-');
          resolve({
            dense: [
              hit(`chunk-${key}-a`, { rank: 1, similarity: 0.82, documentId: DOC, chunkIndex: 0 }),
              hit(`chunk-${key}-b`, { rank: 2, similarity: 0.71, documentId: DOC, chunkIndex: 1 }),
            ],
            lexical: [],
          });
        }, SEARCH_MS);
        req.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(req.signal.reason);
          },
          { once: true },
        );
      });
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function memoryCache() {
  const entries: Array<{ tenant: string; keyHash: string; profile: string; answer: CachedAnswer }> = [];
  const cache: SemanticCache = {
    async check(q) {
      const keyHash = computeCacheKeyHash(q);
      const entry = entries.find((row) => row.tenant === scopeKey(q.scope) && row.keyHash === keyHash && row.profile === q.embeddingProfileId);
      return entry ? ({ entryId: 'entry-1', distance: 0.01, answer: entry.answer } satisfies CacheHit) : null;
    },
    async store(q, answer) {
      entries.push({ tenant: scopeKey(q.scope), keyHash: computeCacheKeyHash(q), profile: q.embeddingProfileId, answer });
    },
    async invalidateTenant() {
      return 0;
    },
  };
  return cache;
}

interface Setup {
  speculative: boolean;
  entries?: FakeQueryLlmEntry[];
  env?: Record<string, string>;
  failFirstSearch?: boolean;
  cache?: SemanticCache;
}

async function install(setup: Setup): Promise<Recorder> {
  resetActiveChunkingProfilesForTests();
  const rec: Recorder = { embeds: [], searches: [], failFirstSearch: setup.failFirstSearch === true };
  const fake = createFakeQueryLlm({ table: { version: 1, entries: setup.entries ?? [] } });
  const rpc = fakeRpcClient();
  installDeps({
    embedder: embedderFor(rec),
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    ...(setup.cache ? { semanticCache: () => setup.cache! } : {}),
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      RAG_QUERY_LAYER: 'true',
      RAG_SPECULATIVE_RETRIEVAL: setup.speculative ? 'true' : 'false',
      ...(setup.cache ? { RAG_SEMANTIC_CACHE: 'pgvector' } : {}),
      ...setup.env,
    }),
  });
  setRetrievalBackendForTests(backendFor(rec));
  await verifyV2Startup();
  vi.useFakeTimers({ now: Date.parse('2026-06-15T12:00:00Z') });
  return rec;
}

async function run(query: string, options: { history?: HistoryTurn[]; cacheContext?: RetrievalCacheContext; ragMode?: 'strict' | 'balanced' } = {}) {
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const pending = runRetrieval({
    scope,
    query,
    profile: 'chat',
    options: { ragMode: options.ragMode ?? 'balanced', webSearchEnabled: false },
    signal: new AbortController().signal,
    trace: collector,
    ...(options.history ? { history: options.history } : {}),
    ...(options.cacheContext ? { cacheContext: options.cacheContext } : {}),
  });
  await vi.advanceTimersByTimeAsync(10_000);
  const result: RetrievalResult = await pending;
  const stages = collector.stages();
  return { result, stages, stage: (name: string) => stages.find((row) => row.name === name), startedAt: collector.startedAt };
}

function fused(result: RetrievalResult): Array<[string, number | undefined]> {
  return result.candidates.map((candidate) => [candidate.chunk_id, candidate.fused_score]);
}

function stageOrder(stages: readonly StageRecord[]): string[] {
  return stages.filter((row) => row.status !== 'disabled').map((row) => row.name);
}

const condenseEntry = (output: string, delay = CONDENSE_MS): FakeQueryLlmEntry => ({
  transform: 'condense',
  query: FOLLOW_UP,
  delay_ms: delay,
  output: { standalone: output, unchanged: false, language: null },
});

describe('speculative original-query retrieval (D-21, P-29)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    uninstallDeps();
    resetV2StartupForTests();
    gate.outOfScope = false;
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    uninstallDeps();
    resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  it('off: no search starts before condense ends, the stage order is the Phase 6 one and the trace has no speculative field', async () => {
    const rec = await install({ speculative: false, entries: [condenseEntry(CONDENSED)] });
    const { result, stages, stage } = await run(FOLLOW_UP, { history: HISTORY });
    const condenseEnd = stage('condense')!.endedAt;
    expect(rec.searches.length).toBeGreaterThan(0);
    expect(rec.searches.every((call) => call.at >= condenseEnd)).toBe(true);
    expect(rec.embeds.every((call) => call.at >= condenseEnd)).toBe(true);
    const order = stageOrder(stages);
    const at = (name: string) => order.indexOf(name);
    expect(at('query_gate')).toBeLessThan(at('condense'));
    expect(at('condense')).toBeLessThan(at('embed'));
    expect(at('embed')).toBeLessThan(at('search'));
    expect(at('search')).toBeLessThan(at('fuse'));
    expect(result.speculative).toBeUndefined();
  });

  it('on: the original is embedded and searched during a 400 ms condense; overlap about 400 ms; fused lists equal the off run', async () => {
    const offRec = await install({ speculative: false, entries: [condenseEntry(CONDENSED)] });
    const off = await run(FOLLOW_UP, { history: HISTORY });
    vi.useRealTimers();
    uninstallDeps();
    resetV2StartupForTests();

    const rec = await install({ speculative: true, entries: [condenseEntry(CONDENSED)] });
    const on = await run(FOLLOW_UP, { history: HISTORY });
    const condense = on.stage('condense')!;
    const original = vectorFor(FOLLOW_UP).join('-');
    const first = rec.searches[0]!;
    expect(first.vector?.join('-')).toBe(original);
    expect(first.at).toBeLessThan(condense.endedAt);
    expect(rec.embeds[0]).toMatchObject({ text: FOLLOW_UP });
    expect(rec.embeds[0]!.at).toBeLessThan(condense.endedAt);

    expect(fused(on.result)).toEqual(fused(off.result));
    expect(fused(on.result).length).toBeGreaterThan(0);
    // Adopted: the original is searched once, so both runs make the same searches and embed calls.
    expect(rec.searches).toHaveLength(offRec.searches.length);
    expect(rec.embeds).toHaveLength(offRec.embeds.length);
    expect(on.result.status).toBe(off.result.status);
    expect(on.result.speculative).toMatchObject({ cancelled_by_cache: false, wasted_searches: 0 });
    expect(on.result.speculative!.overlap_ms).toBeGreaterThanOrEqual(CONDENSE_MS - 5);
    expect(on.result.speculative!.overlap_ms).toBeLessThanOrEqual(CONDENSE_MS + 5);
    expect(on.result.speculative!.started_ms).toBeGreaterThanOrEqual(0);
    expect(on.result.speculative!.started_ms).toBeLessThan(condense.startedAt - on.startedAt + 1);
    expect(unhandled).toEqual([]);
  });

  it('a condense that brings in another relative time changes the date filter: not adopted, the original is searched again, one wasted search', async () => {
    const query = 'What changed last week?';
    const entries: FakeQueryLlmEntry[] = [
      { transform: 'condense', query, delay_ms: CONDENSE_MS, output: { standalone: 'What changed in the sample gateway yesterday?', unchanged: false, language: null } },
    ];
    const offRec = await install({ speculative: false, entries });
    const off = await run(query, { history: HISTORY });
    vi.useRealTimers();
    uninstallDeps();
    resetV2StartupForTests();

    const rec = await install({ speculative: true, entries });
    const on = await run(query, { history: HISTORY });
    const originalSearches = rec.searches.filter((call) => call.vector?.join('-') === vectorFor(query).join('-'));
    expect(originalSearches).toHaveLength(2);
    expect(originalSearches[0]!.request.filters.dateRange).not.toEqual(originalSearches[1]!.request.filters.dateRange);
    expect(rec.searches).toHaveLength(offRec.searches.length + 1);
    expect(on.result.speculative).toMatchObject({ wasted_searches: 1, cancelled_by_cache: false });
    expect(fused(on.result)).toEqual(fused(off.result));
    expect(unhandled).toEqual([]);
  });

  it('a cache hit aborts the in-flight speculative search; cancelled_by_cache is true and nothing is left unhandled', async () => {
    const question = 'What does the sample widget report to the operator?';
    const cache = memoryCache();
    await install({ speculative: true, cache });
    const first = await run(question, { cacheContext: CONTEXT, ragMode: 'strict' });
    const ticket = first.result.cacheTicket!;
    expect(ticket).toBeDefined();
    await cache.store(
      { ...ticket.key, scope, standalone: ticket.standalone, vector: ticket.vector, embeddingProfileId: ticket.embeddingProfileId },
      cachedAnswer(),
    );
    vi.useRealTimers();
    uninstallDeps();
    resetV2StartupForTests();

    const rec = await install({ speculative: true, cache });
    const second = await run(question, { cacheContext: CONTEXT, ragMode: 'strict' });
    expect(second.stage('semantic_cache')?.detail).toMatch(/^hit/);
    expect(rec.searches).toHaveLength(1);
    expect(rec.searches[0]!.request.signal.aborted).toBe(true);
    expect(second.result.speculative).toMatchObject({ cancelled_by_cache: true });
    // The standalone was embedded once, by the speculation; the cache stage reused that vector.
    expect(rec.embeds.filter((call) => call.text === question)).toHaveLength(1);
    expect(second.stages.some((row) => row.status === 'error' || row.status === 'aborted')).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it('a speculative search that throws falls back to the normal search: no error record, status unchanged', async () => {
    const off = await install({ speculative: false, entries: [condenseEntry(CONDENSED)] });
    const offRun = await run(FOLLOW_UP, { history: HISTORY });
    vi.useRealTimers();
    uninstallDeps();
    resetV2StartupForTests();

    const rec = await install({ speculative: true, entries: [condenseEntry(CONDENSED)], failFirstSearch: true });
    const on = await run(FOLLOW_UP, { history: HISTORY });
    expect(rec.searches).toHaveLength(off.searches.length + 1);
    expect(on.stages.some((row) => row.status === 'error')).toBe(false);
    expect(on.result.status).toBe(offRun.result.status);
    expect(fused(on.result)).toEqual(fused(offRun.result));
    expect(on.result.speculative).toMatchObject({ wasted_searches: 1 });
    expect(unhandled).toEqual([]);
  });

  it('an out_of_scope label discards the speculative results and counts them as wasted', async () => {
    gate.outOfScope = true;
    await install({ speculative: true, entries: [condenseEntry(CONDENSED)], env: { RAG_SCOPE_GATE: 'true' } });
    const on = await run(FOLLOW_UP, { history: HISTORY, ragMode: 'strict' });
    expect(on.result.skipReason).toBe('out_of_scope');
    expect(on.result.speculative).toMatchObject({ wasted_searches: 1, cancelled_by_cache: false });
    expect(on.stages.some((row) => row.name === 'search')).toBe(false);
    expect(unhandled).toEqual([]);
  });
});
