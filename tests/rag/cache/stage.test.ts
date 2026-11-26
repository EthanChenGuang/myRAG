import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, RetrievalBackend, RetrievalFilterInput } from '@/lib/rag/backend/types';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheHit, CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { LEGACY_PROFILE } from '@/lib/rag/embeddings/active-profile';
import type { QueryEmbedding } from '@/lib/rag/embeddings/query-embedding';
import { runQueryLayer, type QueryLayerOutcome } from '@/lib/rag/query/run-layer';
import { scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { DocumentRefsInput, Profile, RetrievalCacheContext, RetrievalOptions, RetrievalResult, StageOverrides } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import { fakeRpc } from './fake-rpc';
import { cachedAnswer, DOC_1, SCOPE_A, SCOPE_B, SCOPE_SINGLE } from './fixtures';

const QUESTION = 'What does the sample widget report to the operator?';
const PROTECTED = 'What does the code ERR_SAMPLE_4031 mean for the widget?';
const DOC_2 = '00000000-0000-4000-8000-00000000d002';
const CONFIG_HASH = 'e'.repeat(64);
const VECTOR = [0.1, 0.2, 0.3];

const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: 'b'.repeat(64),
  webSearch: false,
  mcpTools: false,
  chatId: null,
};

interface MemoryEntry {
  id: string;
  tenant: string;
  keyHash: string;
  profile: string;
  answer: CachedAnswer;
}

/** An in-memory backend keyed by scope key, key hash and embedding profile; any vector within the key matches. */
function memoryCache(behaviour: { fail?: boolean; delayMs?: number } = {}) {
  const entries: MemoryEntry[] = [];
  const checks: CacheQuery[] = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      if (behaviour.fail) throw new Error('synthetic cache failure');
      const keyHash = computeCacheKeyHash(q);
      const entry = entries.find((row) => row.tenant === scopeKey(q.scope) && row.keyHash === keyHash && row.profile === q.embeddingProfileId);
      return entry ? ({ entryId: entry.id, distance: 0.01, answer: entry.answer } satisfies CacheHit) : null;
    },
    async store(q, answer) {
      entries.push({ id: `entry-${entries.length + 1}`, tenant: scopeKey(q.scope), keyHash: computeCacheKeyHash(q), profile: q.embeddingProfileId, answer });
    },
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, checks, entries };
}

function citedAnswer(documentId: string, documentName: string): CachedAnswer {
  return cachedAnswer({
    citations: [
      {
        alias: 'S1',
        chunkIds: ['chunk-1'],
        documentId,
        documentName,
        documentVersion: 1,
        n: 1,
        page: null,
        quote: 'A neutral quoted sentence.',
        quoteHash: 'f'.repeat(64),
        sectionPath: null,
        strategy: 'chunk-alias',
      },
    ],
    sources: [{ document_id: documentId, name: documentName, version: 1 }],
    source_versions: [{ document_id: documentId, version: 1 }],
  });
}

function env(over: Record<string, string> = {}) {
  return { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', RAG_SEMANTIC_CACHE: 'pgvector', ...over };
}

interface LayerRun {
  query?: string;
  profile?: Profile;
  scope?: TenantScope;
  ragMode?: RetrievalOptions['ragMode'];
  options?: RetrievalOptions;
  documentRefs?: DocumentRefsInput;
  stageOverrides?: StageOverrides;
  context?: RetrievalCacheContext | null;
  env?: Record<string, string>;
  retrievalFilters?: RetrievalFilterInput;
}

/** Runs the query layer alone with a hand-built cache seam (the pipeline supplies the real one). */
async function runLayer(cache: SemanticCache | null, run: LayerRun = {}, admin?: RpcClient) {
  resetRagConfigForTests();
  const embedded: string[] = [];
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  setRagDepsForTests({
    queryLlm: () => fake,
    semanticCache: () => cache,
    ...(admin ? { adminClient: () => admin as never } : {}),
  });
  const profile = run.profile ?? 'chat';
  const scope = run.scope ?? SCOPE_SINGLE;
  const collector = createTraceCollector({ profile, tenantKey: scopeKey(scope) });
  const signal = new AbortController().signal;
  const context = run.context === undefined ? CONTEXT : run.context;
  const out: QueryLayerOutcome = await runQueryLayer({
    input: {
      scope,
      query: run.query ?? QUESTION,
      profile,
      signal,
      options: { ragMode: run.ragMode ?? 'strict', webSearchEnabled: false, ...run.options },
      ...(run.documentRefs ? { documentRefs: run.documentRefs } : {}),
      ...(run.stageOverrides ? { stageOverrides: run.stageOverrides } : {}),
      ...(run.retrievalFilters ? { retrievalFilters: run.retrievalFilters } : {}),
      ...(context ? { cacheContext: context } : {}),
    },
    config: loadRagConfig(env(run.env)),
    profile,
    signal,
    collector,
    stageOverrides: run.stageOverrides,
    scope,
    cache: {
      embed: async (text: string): Promise<QueryEmbedding> => {
        embedded.push(text);
        return { vector: VECTOR, profile: null };
      },
      retrievalConfigHash: async () => CONFIG_HASH,
    },
  });
  const record = collector.stages().find((row) => row.name === 'semantic_cache');
  return { out, record, embedded };
}

describe('semantic_cache stage in the query layer (D-05, D-32, D-33, D-36)', () => {
  beforeEach(() => {
    uninstallDeps();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    vi.restoreAllMocks();
  });

  it('chat, strict, plain question: checks once with the computed key, the profile id and the scope; records a miss and hands out a ticket', async () => {
    const memory = memoryCache();
    const { out, record, embedded } = await runLayer(memory.cache);
    expect(embedded).toEqual([QUESTION]);
    expect(memory.checks).toHaveLength(1);
    const check = memory.checks[0]!;
    expect(check.scope).toBe(SCOPE_SINGLE);
    expect(check.embeddingProfileId).toBe(LEGACY_PROFILE.id);
    expect(check.vector).toEqual(VECTOR);
    expect(check.standalone).toBe(QUESTION);
    expect(computeCacheKeyHash(check)).toBe(
      computeCacheKeyHash({
        answerLanguage: 'en',
        ragMode: 'strict',
        generatorModel: CONTEXT.generatorModel,
        retrievalConfigHash: CONFIG_HASH,
        queryFramework: 'llamaindex',
        entryProfile: 'chat',
        systemPromptHash: CONTEXT.systemPromptHash,
      }),
    );
    expect(record).toMatchObject({ status: 'ok', detail: 'miss' });
    // D-37: no calibrated entry for the legacy profile, so the check carries RAG_SEMANTIC_CACHE_MAX_DISTANCE.
    expect(check.maxDistance).toBe(0.05);
    expect(out.shortCircuit).toBeNull();
    expect(out.cacheTicket).toMatchObject({ standalone: QUESTION, vector: VECTOR, embeddingProfileId: LEGACY_PROFILE.id });
    expect(out.cacheTicket?.key.entryProfile).toBe('chat');
    expect(out.cacheTicket && 'scope' in out.cacheTicket).toBe(false);
    expect(out.precomputed).toMatchObject({ text: QUESTION, embedding: { vector: VECTOR } });
  });

  it('a protected-token query records bypass protected_tokens, never embeds or checks and gets no ticket', async () => {
    const memory = memoryCache();
    const { out, record, embedded } = await runLayer(memory.cache, { query: PROTECTED });
    expect(record).toMatchObject({ status: 'disabled', detail: 'bypass=protected_tokens' });
    expect(memory.checks).toEqual([]);
    expect(embedded).toEqual([]);
    expect(out.cacheTicket).toBeUndefined();
  });

  it('flexible mode, voice and RAG_SEMANTIC_CACHE=off record the stage disabled and never check', async () => {
    const memory = memoryCache();
    const flexible = await runLayer(memory.cache, { ragMode: 'flexible' });
    expect(flexible.record).toMatchObject({ status: 'disabled', detail: 'bypass=rag_mode' });
    const voice = await runLayer(memory.cache, { profile: 'voice' });
    expect(voice.record?.status).toBe('disabled');
    expect(voice.out.cacheTicket).toBeUndefined();
    const off = await runLayer(memory.cache, { env: { RAG_SEMANTIC_CACHE: 'off' } });
    expect(off.record?.status).toBe('disabled');
    expect(memory.checks).toEqual([]);
    expect([flexible, voice, off].every((run) => run.out.cacheTicket === undefined)).toBe(true);
  });

  it('a backend that throws is skipped as a miss: the request continues and the ticket stays', async () => {
    const memory = memoryCache({ fail: true });
    const { out, record } = await runLayer(memory.cache);
    expect(record).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(out.shortCircuit).toBeNull();
    expect(out.cacheTicket).toBeDefined();
  });

  it('a backend that takes 400 ms is cut at 150 ms and skipped as a miss', async () => {
    const memory = memoryCache({ delayMs: 400 });
    const started = Date.now();
    const { out, record } = await runLayer(memory.cache);
    expect(Date.now() - started).toBeLessThan(380);
    expect(record).toMatchObject({ status: 'skipped', reason: 'timeout' });
    expect(out.shortCircuit).toBeNull();
  });

  it('two tenants: each check carries the request scope, and an entry stored for A is a miss for B with the same text and vector', async () => {
    const memory = memoryCache();
    const first = await runLayer(memory.cache, { scope: SCOPE_A });
    const ticket = first.out.cacheTicket!;
    await memory.cache.store({ ...ticket.key, scope: SCOPE_A, standalone: ticket.standalone, vector: ticket.vector, embeddingProfileId: ticket.embeddingProfileId }, cachedAnswer());

    const forB = await runLayer(memory.cache, { scope: SCOPE_B });
    expect(memory.checks[1]?.scope).toBe(SCOPE_B);
    expect(forB.record?.detail).toBe('miss');
    expect(forB.out.cacheHit).toBeUndefined();

    const forA = await runLayer(memory.cache, { scope: SCOPE_A });
    expect(memory.checks[2]?.scope).toBe(SCOPE_A);
    expect(forA.out.shortCircuit).toEqual({ kind: 'cache_hit' });
    expect(forA.out.cacheHit?.entryId).toBe('entry-1');
  });

  it('the eval profile runs the stage only with stageOverrides.queryLayer.semanticCache set', async () => {
    const memory = memoryCache();
    const without = await runLayer(memory.cache, { profile: 'eval' });
    expect(without.record?.status).toBe('disabled');
    expect(memory.checks).toEqual([]);
    const withOverride = await runLayer(memory.cache, { profile: 'eval', stageOverrides: { queryLayer: { semanticCache: 'pgvector' } } });
    expect(withOverride.record).toMatchObject({ status: 'ok', detail: 'miss' });
    expect(memory.checks).toHaveLength(1);
    expect(withOverride.out.cacheTicket?.key.entryProfile).toBe('eval');
  });

  it('document references bypass with document_refs: never checked, no ticket', async () => {
    const memory = memoryCache();
    const parts = await runLayer(memory.cache, { documentRefs: { mentions: [], documentParts: [{ id: DOC_1, name: 'Synthetic part' }] } });
    const mentions = await runLayer(memory.cache, { documentRefs: { mentions: ['@Policy'], documentParts: [] } });
    for (const run of [parts, mentions]) {
      expect(run.record).toMatchObject({ status: 'disabled', detail: 'bypass=document_refs' });
      expect(run.out.cacheTicket).toBeUndefined();
    }
    expect(memory.checks).toEqual([]);
  });

  it('an effective version scope other than current bypasses with version_scope; an ignored one checks normally (D-14)', async () => {
    const memory = memoryCache();
    const on = { RAG_LEXICAL_SEARCH: 'true', RAG_VERSION_SCOPE: 'true' };
    const history = await runLayer(memory.cache, { env: on, retrievalFilters: { versionScope: 'all' } });
    const range = await runLayer(memory.cache, { env: on, retrievalFilters: { versionScope: { from: '2026-01-01' } } });
    for (const run of [history, range]) {
      expect(run.record).toMatchObject({ status: 'disabled', detail: 'bypass=version_scope' });
      expect(run.out.cacheTicket).toBeUndefined();
    }
    expect(memory.checks).toEqual([]);

    const ignored = await runLayer(memory.cache, { retrievalFilters: { versionScope: 'all' } });
    expect(ignored.record).toMatchObject({ status: 'ok', detail: 'miss' });
    expect(ignored.out.cacheTicket?.turn.versionScope).toBeUndefined();
  });

  it('non-default retrieval options bypass with retrieval_options; the configured count checks normally', async () => {
    const memory = memoryCache();
    const runs = await Promise.all([
      runLayer(memory.cache, { options: { maxResults: 10 } }),
      runLayer(memory.cache, { options: { generalOverview: true } }),
      runLayer(memory.cache, { options: { mediaKind: 'image' } }),
    ]);
    for (const run of runs) {
      expect(run.record).toMatchObject({ status: 'disabled', detail: 'bypass=retrieval_options' });
      expect(run.out.cacheTicket).toBeUndefined();
    }
    expect(memory.checks).toEqual([]);
    const configured = await runLayer(memory.cache, { options: { maxResults: 25 } });
    expect(configured.record?.detail).toBe('miss');
    expect(memory.checks).toHaveLength(1);
  });

  it('single tenant: an entry stored under the eval profile is a miss for chat, and the eval re-check hits', async () => {
    const memory = memoryCache();
    const evalOverrides: StageOverrides = { queryLayer: { semanticCache: 'pgvector' } };
    const seeded = await runLayer(memory.cache, { profile: 'eval', stageOverrides: evalOverrides });
    const ticket = seeded.out.cacheTicket!;
    await memory.cache.store({ ...ticket.key, scope: SCOPE_SINGLE, standalone: ticket.standalone, vector: ticket.vector, embeddingProfileId: ticket.embeddingProfileId }, cachedAnswer());

    const chat = await runLayer(memory.cache, { profile: 'chat' });
    expect(chat.record?.detail).toBe('miss');
    expect(chat.out.cacheHit).toBeUndefined();

    const again = await runLayer(memory.cache, { profile: 'eval', stageOverrides: evalOverrides });
    expect(again.out.shortCircuit).toEqual({ kind: 'cache_hit' });
  });

  it('a hit re-resolves cited documents under the request scope and returns the current names', async () => {
    const memory = memoryCache();
    const seed = await runLayer(memory.cache, { scope: SCOPE_A });
    const ticket = seed.out.cacheTicket!;
    await memory.cache.store({ ...ticket.key, scope: SCOPE_A, standalone: ticket.standalone, vector: ticket.vector, embeddingProfileId: ticket.embeddingProfileId }, citedAnswer(DOC_1, 'old-name.md'));
    const rpc = fakeRpc((fn) => (fn === 'rag_cache_resolve_sources' ? { data: [{ document_id: DOC_1, name: 'current-name.md', version: 2 }], error: null } : { data: [], error: null }));

    const { out, record } = await runLayer(memory.cache, { scope: SCOPE_A }, rpc.client);
    const resolves = rpc.calls.filter((call) => call.fn === 'rag_cache_resolve_sources');
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({ fn: 'rag_cache_resolve_sources', args: { p_tenant_key: scopeKey(SCOPE_A), p_document_ids: [DOC_1] } });
    expect(out.shortCircuit).toEqual({ kind: 'cache_hit' });
    expect(out.cacheHit?.answer.citations?.[0]).toMatchObject({ documentId: DOC_1, documentName: 'current-name.md', documentVersion: 2 });
    expect(record?.detail).toMatch(/^hit distance=/);
  });

  it('a hit whose cited document no longer resolves becomes a miss with citations_unresolved and continues', async () => {
    const memory = memoryCache();
    const seed = await runLayer(memory.cache);
    const ticket = seed.out.cacheTicket!;
    await memory.cache.store({ ...ticket.key, scope: SCOPE_SINGLE, standalone: ticket.standalone, vector: ticket.vector, embeddingProfileId: ticket.embeddingProfileId }, citedAnswer(DOC_2, 'gone.md'));
    const rpc = fakeRpc(() => ({ data: [], error: null }));

    const { out, record } = await runLayer(memory.cache, {}, rpc.client);
    expect(rpc.calls.filter((call) => call.fn === 'rag_cache_resolve_sources')).toHaveLength(1);
    expect(out.shortCircuit).toBeNull();
    expect(out.cacheHit).toBeUndefined();
    expect(record).toMatchObject({ status: 'ok', detail: 'miss citations_unresolved' });
    expect(out.cacheTicket).toBeDefined();
  });

  it('a hit without citations makes no resolve call', async () => {
    const memory = memoryCache();
    const seed = await runLayer(memory.cache);
    const ticket = seed.out.cacheTicket!;
    await memory.cache.store({ ...ticket.key, scope: SCOPE_SINGLE, standalone: ticket.standalone, vector: ticket.vector, embeddingProfileId: ticket.embeddingProfileId }, cachedAnswer());
    const rpc = fakeRpc(() => ({ data: [], error: null }));

    const { out } = await runLayer(memory.cache, {}, rpc.client);
    expect(rpc.calls.filter((call) => call.fn === 'rag_cache_resolve_sources')).toEqual([]);
    expect(out.shortCircuit).toEqual({ kind: 'cache_hit' });
  });

  it('without the entry point cache context the stage stands down', async () => {
    const memory = memoryCache();
    const { out, record } = await runLayer(memory.cache, { context: null });
    expect(record).toMatchObject({ status: 'disabled', detail: 'no_cache_context' });
    expect(memory.checks).toEqual([]);
    expect(out.cacheTicket).toBeUndefined();
  });
});

const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function backend(seen: { searches: number }): RetrievalBackend {
  return {
    id: 'pgvector',
    async search() {
      seen.searches += 1;
      const dense = Array.from({ length: 3 }, (_, index) =>
        hit(`chunk-${index + 1}`, { rank: index + 1, similarity: 0.9 - index * 0.01, documentId: DOC, chunkIndex: index }),
      );
      return { dense, lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

async function runPipeline(cache: SemanticCache | null, options: { env?: Record<string, string>; fail?: boolean } = {}) {
  resetActiveChunkingProfilesForTests();
  const embedded: string[] = [];
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  installDeps({
    embedder: async (text) => {
      embedded.push(text);
      return VECTOR;
    },
    adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    semanticCache: () => cache,
    ragEnv: () => env(options.env),
  });
  const seen = { searches: 0 };
  setRetrievalBackendForTests(backend(seen));
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
  return { result, embedded, seen, stages: collector.stages() };
}

describe('semantic_cache stage in the v2 pipeline', () => {
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

  it('embeds the standalone once: the embed batch skips it, so the request makes one embed call less', async () => {
    const off = await runPipeline(null, { env: { RAG_SEMANTIC_CACHE: 'off' } });
    const memory = memoryCache();
    const on = await runPipeline(memory.cache);
    expect(on.embedded.filter((text) => text === QUESTION)).toHaveLength(1);
    expect(on.embedded).toHaveLength(off.embedded.length);
    expect(on.stages.find((row) => row.name === 'embed')?.status).toBe('ok');
    expect(on.seen.searches).toBe(off.seen.searches);
  });

  it('the check key carries the same retrieval-config hash the result reports, and the miss result carries the ticket', async () => {
    const memory = memoryCache();
    const { result } = await runPipeline(memory.cache);
    expect(memory.checks).toHaveLength(1);
    expect(memory.checks[0]!.retrievalConfigHash).toBe(result.retrievalConfigHash);
    expect(result.cacheTicket?.key.retrievalConfigHash).toBe(result.retrievalConfigHash);
    expect(result.cacheTicket?.standalone).toBe(QUESTION);
    expect(result.status).toBe('ok');
  });

  it('a failing backend never changes the status and the request still searches', async () => {
    const off = await runPipeline(null, { env: { RAG_SEMANTIC_CACHE: 'off' } });
    const failing = await runPipeline(memoryCache({ fail: true }).cache);
    expect(failing.stages.find((row) => row.name === 'semantic_cache')?.status).toBe('skipped');
    expect(failing.result.status).toBe(off.result.status);
    expect(failing.seen.searches).toBeGreaterThan(0);
  });

  it('with the query layer on and the cache off, the retrieval-config hash differs from the layer-off hash', async () => {
    const layerOff = await runPipeline(null, { env: { RAG_SEMANTIC_CACHE: 'off', RAG_QUERY_LAYER: 'false' } });
    const layerOn = await runPipeline(null, { env: { RAG_SEMANTIC_CACHE: 'off' } });
    expect(layerOff.result.retrievalConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(layerOn.result.retrievalConfigHash).not.toBe(layerOff.result.retrievalConfigHash);
  });
});
