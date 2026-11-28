import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../eval/harness/fake-query-llm.mts';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import type { AnswerGroundedness } from '@/lib/rag/generation/groundedness';
import type { RunRetrievalInput } from '@/lib/rag/types';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../helpers/chat-route-fakes';
import { hit } from './fusion/helpers';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const real = { on: false, deltas: ['ok'] as string[], calls: 0 };
  /** A real AI SDK model so the citation stream transform runs (the capture fake skips transforms). */
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async () => {
        real.calls += 1;
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't1' },
            ...real.deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
            { type: 'text-end' as const, id: 't1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    });
  return {
    ...fakes.createChatRouteHarness(),
    real,
    model,
    scope: { current: null as unknown },
    runRetrieval: vi.fn(),
    answerFinish: vi.fn(),
    renamed: { name: 'placeholder-renamed.md', version: 2 },
    denseRows: vi.fn<() => string[]>(() => []),
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (params: Parameters<typeof actual.streamText>[0]) =>
      h.real.on ? actual.streamText(params) : h.capture.streamText(params as unknown as Record<string, unknown>),
  };
});
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => (h.real.on ? h.model(modelId) : { specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const QUESTION = 'What does the placeholder section describe?';
const DOC_X = '00000000-0000-4000-8000-0000000036d1';
const DOC_Y = '00000000-0000-4000-8000-0000000036d2';
const CHAT_ID = '00000000-0000-4000-8000-0000000036c1';
const ORG_1 = '00000000-0000-4000-8000-0000000036e1';
const ORG_2 = '00000000-0000-4000-8000-0000000036e2';
/** Scopes are minted inside the freshly loaded rag module (minting is per module instance), from these descriptions. */
interface ScopeDesc {
  kind: 'single' | 'org';
  userId: string | null;
  organizationId: string | null;
}
const COLLEAGUE_A: ScopeDesc = { kind: 'org', userId: '00000000-0000-4000-8000-0000000036a1', organizationId: ORG_1 };
const COLLEAGUE_B: ScopeDesc = { kind: 'org', userId: '00000000-0000-4000-8000-0000000036a2', organizationId: ORG_1 };
const OTHER_TENANT: ScopeDesc = { kind: 'org', userId: '00000000-0000-4000-8000-0000000036a3', organizationId: ORG_2 };
const SINGLE: ScopeDesc = { kind: 'single', userId: null, organizationId: null };

function scopeKey(scope: ScopeDesc | { kind: string; userId: string | null; organizationId: string | null }): string {
  if (scope.kind === 'single') return 's:default';
  if (scope.kind === 'org') return `o:${scope.organizationId}`;
  return `u:${scope.userId}`;
}

const CACHE_ON = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'none',
  RAG_QUERY_LAYER: 'true',
  RAG_SEMANTIC_CACHE: 'pgvector',
};
const CACHE_OFF = { ...CACHE_ON, RAG_SEMANTIC_CACHE: 'off' };

interface Entry {
  tenant: string;
  keyHash: string;
  profile: string;
  standalone: string;
  answer: CachedAnswer;
}

/** In-memory backend keyed by scope key, key hash, embedding profile and the exact standalone text (the fake embedder is constant). */
function memoryCache() {
  const entries: Entry[] = [];
  const checks: CacheQuery[] = [];
  const stores: Array<{ q: CacheQuery; answer: CachedAnswer }> = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      const index = entries.findIndex(
        (entry) =>
          entry.tenant === scopeKey(q.scope as unknown as ScopeDesc) && entry.keyHash === computeCacheKeyHash(q) && entry.profile === q.embeddingProfileId && entry.standalone === q.standalone,
      );
      return index < 0 ? null : { entryId: `entry-${index}`, distance: 0, answer: entries[index].answer };
    },
    async store(q, answer) {
      stores.push({ q, answer });
      entries.push({ tenant: scopeKey(q.scope as unknown as ScopeDesc), keyHash: computeCacheKeyHash(q), profile: q.embeddingProfileId, standalone: q.standalone, answer });
    },
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, entries, checks, stores };
}

let memory = memoryCache();

function seedDocuments() {
  h.supabase.store.documents = [DOC_X, DOC_Y].map((id, index) => ({
    id,
    filename: `placeholder-${index}.md`,
    created_at: '2026-01-01T00:00:00.000Z',
    content: 'A neutral placeholder sentence about the section.',
    metadata: {},
  }));
  h.supabase.store.document_chunks = [DOC_X, DOC_Y].map((id) => ({ id: `${id.slice(0, 30)}c0`, document_id: id, metadata: null }));
}

async function loadRoute(ragEnv: Record<string, string>) {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    h.runRetrieval.mockImplementation(actual.runRetrieval);
    return {
      ...actual,
      runRetrieval: h.runRetrieval,
      resolveTenantScope: async () => {
        const desc = (h.scope.current as ScopeDesc | null) ?? SINGLE;
        return { ok: true, scope: mintScope(desc.kind, desc.userId, desc.organizationId) };
      },
      scheduleAnswerFinish: h.answerFinish,
    };
  });
  await installChatPipeline(h);
  const deps = await import('@/lib/rag/deps');
  const installed = deps.getRagDeps().adminClient;
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  deps.setRagDepsForTests({
    ragEnv: () => ragEnv,
    queryLlm: () => fake,
    semanticCache: () => memory.cache,
    adminClient: (() => {
      const base = installed() as { rpc: (fn: string, args: Record<string, unknown>) => unknown };
      const rpc = (fn: string, args: Record<string, unknown>) => {
        if (fn !== 'rag_cache_resolve_sources') return base.rpc(fn, args);
        const rows = ((args.p_document_ids as string[]) ?? []).map((id) => ({ document_id: id, name: h.renamed.name, version: h.renamed.version }));
        const request = { abortSignal: () => request, then: (ok: (value: unknown) => unknown, ko?: (reason: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, ko) };
        return request;
      };
      return new Proxy(base as object, { get: (target, key) => (key === 'rpc' ? rpc : Reflect.get(target, key)) });
    }) as never,
  });
  const registry = await import('@/lib/rag/backend/registry');
  registry.setRetrievalBackendForTests({
    id: 'pgvector',
    async search() {
      const rows = h.denseRows();
      return {
        dense: rows.map((documentId, index) =>
          hit(`${documentId.slice(0, 30)}c${index}`, {
            rank: index + 1,
            similarity: 0.92,
            documentId,
            chunkIndex: 0,
            content: 'A neutral placeholder sentence about the section.',
            document: { filename: 'placeholder.md', createdAt: '2026-01-01T00:00:00.000Z', metadata: {}, contentPreview: '' },
          }),
        ),
        lexical: [],
      };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  } as never);
  const startup = await import('@/lib/rag/v2/startup');
  await startup.verifyV2Startup();
  return import('@/app/api/chat/route');
}

type Route = Awaited<ReturnType<typeof loadRoute>>;

function ask(route: Route, options: { content?: unknown; data?: Record<string, unknown>; messages?: unknown[] } = {}) {
  const content = options.content ?? QUESTION;
  return route.POST(
    chatRequest({
      messages: options.messages ?? [{ role: 'user', content }],
      data: { ragMode: 'strict', settings: { webSearch: false }, ...options.data },
    }),
  );
}

function withDocument(documentId: string) {
  return [
    { type: 'text', text: 'summarize this' },
    { type: 'document', document: { id: documentId, name: 'placeholder.md' } },
  ];
}

function events(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function startMetadata(body: string): Record<string, unknown> | undefined {
  return events(body).find((event) => event.type === 'start')?.messageMetadata as Record<string, unknown> | undefined;
}

function lastInput(): RunRetrievalInput {
  const calls = h.runRetrieval.mock.calls;
  return calls[calls.length - 1][0] as RunRetrievalInput;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function stored(count: number) {
  await vi.waitFor(() => expect(memory.stores).toHaveLength(count), { timeout: 2000, interval: 10 });
}

const VERIFIED: AnswerGroundedness = {
  status: 'scored',
  label: 'verified',
  scorer: 'hhem_2_1_open',
  score: 0.9,
  threshold: 0.5,
  thresholdSource: 'default',
  reason: null,
  truncated: false,
  latencyMs: 20,
  checkedAt: '2026-11-25T00:00:01.000Z',
};

describe('chat route semantic cache (CACHE-01, D-32, D-33, A-3)', () => {
  const savedEnv = { RAG_CITATIONS: process.env.RAG_CITATIONS, RAG_GROUNDEDNESS: process.env.RAG_GROUNDEDNESS };

  beforeEach(() => {
    memory = memoryCache();
    h.scope.current = SINGLE;
    h.capture.reset();
    h.capture.setDeltas(['A neutral placeholder answer.']);
    h.real.on = false;
    h.real.calls = 0;
    h.retrieval.mockReset();
    h.retrieval.mockImplementation(async () => retrievalWith([]));
    h.denseRows.mockReset();
    h.denseRows.mockImplementation(() => [DOC_X]);
    h.runRetrieval.mockClear();
    h.answerFinish.mockReset();
    h.answerFinish.mockResolvedValue(null);
    h.renamed = { name: 'placeholder-renamed.md', version: 2 };
    h.supabase.store.reset();
    seedDocuments();
    delete process.env.RAG_CITATIONS;
    delete process.env.RAG_GROUNDEDNESS;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock('@/lib/rag');
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it('cache off: no cacheContext is passed, nothing is checked or stored, and the stream is today\'s', async () => {
    const route = await loadRoute(CACHE_OFF);
    const body = await readSse(await ask(route));
    await settle();
    expect(lastInput().cacheContext).toBeUndefined();
    expect(memory.checks).toEqual([]);
    expect(memory.stores).toEqual([]);
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(body.replace(/"ragTraceId":"[^"]+"/g, '"ragTraceId":"<trace>"').replace(/"messageId":"[^"]+"/g, '"messageId":"<id>"')).toMatchSnapshot();
  });

  it('cache on: passes the cache context (model, prompt hash, tools, chat id) with no entry profile', async () => {
    const route = await loadRoute(CACHE_ON);
    await readSse(await ask(route, { data: { chatId: CHAT_ID } }));
    const context = lastInput().cacheContext;
    expect(context).toMatchObject({ webSearch: false, mcpTools: false, chatId: CHAT_ID });
    expect(context?.generatorModel).toEqual(expect.any(String));
    expect(context?.systemPromptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(context ?? {})).not.toContain('entryProfile');
  });

  it('a miss stores once after the response; the same question then streams the cached answer with no model call and no second retrieval', async () => {
    const route = await loadRoute(CACHE_ON);
    const first = await readSse(await ask(route));
    expect(startMetadata(first)?.cache).toBeUndefined();
    await stored(1);
    expect(scopeKey(memory.stores[0].q.scope as unknown as ScopeDesc)).toBe(scopeKey(SINGLE));
    expect(memory.stores[0].q.entryProfile).toBe('chat');
    expect(memory.stores[0].answer).toMatchObject({ answer_text: 'A neutral placeholder answer.', is_refusal: false });
    const originalTrace = memory.stores[0].answer.trace_id;

    h.capture.reset();
    h.runRetrieval.mockClear();
    const second = await readSse(await ask(route));
    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(h.runRetrieval).toHaveBeenCalledTimes(1);
    expect(startMetadata(second)).toMatchObject({ ragTraceId: originalTrace, cache: 'hit' });
    const text = events(second).filter((event) => event.type === 'text-delta').map((event) => event.delta).join('');
    expect(text).toBe('A neutral placeholder answer.');
    expect(events(second).some((event) => event.type === 'metadata')).toBe(true);
    await settle();
    expect(memory.stores).toHaveLength(1);
  });

  it('a strict refusal is stored as a refusal and a hit streams the stored localized refusal', async () => {
    h.denseRows.mockImplementation(() => []);
    const route = await loadRoute(CACHE_ON);
    const first = await readSse(await ask(route));
    expect(first).toContain('Information Not Available');
    await stored(1);
    expect(memory.stores[0].answer).toMatchObject({ is_refusal: true, citations: [], sources: [] });

    h.runRetrieval.mockClear();
    const second = await readSse(await ask(route));
    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(startMetadata(second)).toMatchObject({ cache: 'hit', refusal: true });
    const text = events(second).filter((event) => event.type === 'text-delta').map((event) => event.delta).join('');
    expect(text).toBe(memory.stores[0].answer.answer_text);
  });

  it('a ghost- chat checks but never stores', async () => {
    const route = await loadRoute(CACHE_ON);
    await readSse(await ask(route, { data: { chatId: 'ghost-36' } }));
    await settle();
    expect(memory.checks).toHaveLength(1);
    expect(memory.stores).toEqual([]);
  });

  it('a turn with history never stores', async () => {
    const route = await loadRoute(CACHE_ON);
    await readSse(
      await ask(route, {
        messages: [
          { role: 'user', content: 'Which section is the placeholder in?' },
          { role: 'assistant', content: 'It is in the second section.' },
          { role: 'user', content: QUESTION },
        ],
      }),
    );
    await settle();
    expect(memory.stores).toEqual([]);
  });

  it('two tenants: tenant A\'s stored answer is a miss for tenant B, and B stores its own entry under B', async () => {
    const route = await loadRoute(CACHE_ON);
    h.scope.current = COLLEAGUE_A;
    await readSse(await ask(route));
    await stored(1);

    h.scope.current = OTHER_TENANT;
    h.capture.reset();
    const body = await readSse(await ask(route));
    expect(startMetadata(body)?.cache).toBeUndefined();
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(scopeKey(memory.checks[memory.checks.length - 1].scope as unknown as ScopeDesc)).toBe(scopeKey(OTHER_TENANT));
    await stored(2);
    expect(memory.stores.map((entry) => scopeKey(entry.q.scope as unknown as ScopeDesc))).toEqual([scopeKey(COLLEAGUE_A), scopeKey(OTHER_TENANT)]);
  });

  it('same tenant colleagues: an attached document is neither stored nor checked; a plain question is stored and hits (positive control)', async () => {
    const route = await loadRoute(CACHE_ON);
    h.scope.current = COLLEAGUE_A;
    await readSse(await ask(route, { content: withDocument(DOC_X) }));
    await settle();
    expect(memory.stores).toEqual([]);

    h.scope.current = COLLEAGUE_B;
    const checksBefore = memory.checks.length;
    h.capture.reset();
    const body = await readSse(await ask(route, { content: withDocument(DOC_Y) }));
    expect(memory.checks).toHaveLength(checksBefore);
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(startMetadata(body)?.cache).toBeUndefined();
    await settle();
    expect(memory.stores).toEqual([]);

    h.scope.current = COLLEAGUE_A;
    await readSse(await ask(route));
    await stored(1);
    h.scope.current = COLLEAGUE_B;
    h.capture.reset();
    const hit = await readSse(await ask(route));
    expect(startMetadata(hit)?.cache).toBe('hit');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('two tenants: the same attachment pair never shares an answer, with a positive control per tenant', async () => {
    const route = await loadRoute(CACHE_ON);
    for (const scope of [COLLEAGUE_A, OTHER_TENANT]) {
      h.scope.current = scope;
      await readSse(await ask(route, { content: withDocument(scope === COLLEAGUE_A ? DOC_X : DOC_Y) }));
    }
    await settle();
    expect(memory.stores).toEqual([]);
    expect(memory.checks).toEqual([]);

    for (const scope of [COLLEAGUE_A, OTHER_TENANT]) {
      h.scope.current = scope;
      await readSse(await ask(route));
    }
    await stored(2);
    for (const scope of [COLLEAGUE_A, OTHER_TENANT]) {
      h.scope.current = scope;
      h.capture.reset();
      const body = await readSse(await ask(route));
      expect(startMetadata(body)?.cache).toBe('hit');
      expect(h.capture.streamText).not.toHaveBeenCalled();
    }
  });

  it('non-default retrieval options never check: an overview turn reaches the model, and a non-default maxResults misses (positive control hits)', async () => {
    const route = await loadRoute(CACHE_ON);
    await readSse(await ask(route));
    await stored(1);

    const checksBefore = memory.checks.length;
    h.capture.reset();
    await readSse(await ask(route, { content: '', data: { ragMode: 'balanced' } }));
    expect(lastInput().options?.generalOverview).toBe(true);
    expect(memory.checks).toHaveLength(checksBefore);
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);

    const { runRetrieval } = await import('@/lib/rag');
    const { createTraceCollector } = await import('@/lib/rag/trace/collector');
    const base = { ...lastInputOf(0), signal: new AbortController().signal };
    const off = await runRetrieval({ ...base, options: { ...base.options, maxResults: 7 }, trace: createTraceCollector({ profile: 'chat', tenantKey: scopeKey(SINGLE) }) });
    expect(off.cacheHit).toBeUndefined();
    expect(memory.checks).toHaveLength(checksBefore);
    const control = await runRetrieval({ ...base, trace: createTraceCollector({ profile: 'chat', tenantKey: scopeKey(SINGLE) }) });
    expect(control.cacheHit).toBeDefined();
  });

  it('groundedness on: the store waits for the Phase 5 label of the same request; possibly_unreliable is not stored', async () => {
    process.env.RAG_CITATIONS = 'true';
    process.env.RAG_GROUNDEDNESS = 'true';
    let resolveLabel: (value: AnswerGroundedness) => void = () => undefined;
    h.answerFinish.mockImplementation(() => new Promise<AnswerGroundedness>((resolve) => (resolveLabel = resolve)));
    const route = await loadRoute(CACHE_ON);
    await readSse(await ask(route, { data: { chatId: CHAT_ID, capabilities: { citations: true } } }));
    await settle();
    expect(h.answerFinish).toHaveBeenCalledTimes(1);
    expect(memory.stores).toEqual([]);
    resolveLabel({ ...VERIFIED, label: 'possibly_unreliable', score: 0.1 });
    await settle();
    expect(memory.stores).toEqual([]);

    h.answerFinish.mockImplementation(() => Promise.resolve(VERIFIED));
    await readSse(await ask(route, { data: { chatId: CHAT_ID, capabilities: { citations: true } } }));
    await stored(1);
    expect(memory.stores[0].answer.groundedness).toEqual(VERIFIED);
  });

  it('a hit writes the Phase 5 answer record: answerId in the start metadata, the cached text, current document names and the cached groundedness', async () => {
    process.env.RAG_CITATIONS = 'true';
    h.real.on = true;
    h.real.deltas = ['A neutral placeholder answer [S1].'];
    h.answerFinish.mockImplementation(() => Promise.resolve({ status: 'not_checked', label: 'not_checked', reason: 'disabled' }));
    const route = await loadRoute(CACHE_ON);
    const data = { chatId: CHAT_ID, capabilities: { citations: true } };
    await readSse(await ask(route, { data }));
    expect(h.real.calls).toBe(1);
    await stored(1);
    expect(memory.stores[0].answer.citations?.length).toBeGreaterThan(0);
    const cachedGroundedness = memory.stores[0].answer.groundedness;

    h.answerFinish.mockClear();
    h.renamed = { name: 'placeholder-renamed-again.md', version: 2 };
    const body = await readSse(await ask(route, { data }));
    expect(h.real.calls).toBe(1);
    const start = startMetadata(body);
    expect(start).toMatchObject({ cache: 'hit', answerId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await vi.waitFor(() => expect(h.answerFinish).toHaveBeenCalledTimes(1));
    const record = h.answerFinish.mock.calls[0][0] as Record<string, unknown> & { citations: Array<{ documentName: string }> };
    expect(record.answerId).toBe(start?.answerId);
    expect(record.answerText).toBe('A neutral placeholder answer [S1].');
    expect(record.citations.map((citation) => citation.documentName)).toEqual(['placeholder-renamed-again.md']);
    expect(record.groundedness).toEqual(cachedGroundedness);
    const finish = events(body).find((event) => event.type === 'finish')?.messageMetadata as Record<string, unknown> | undefined;
    expect(finish).toMatchObject({ cache: 'hit', citationStrategy: 'chunk-alias' });

    h.answerFinish.mockClear();
    const ghost = await readSse(await ask(route, { data: { chatId: 'ghost-36', capabilities: { citations: true } } }));
    expect(startMetadata(ghost)?.cache).toBe('hit');
    expect(startMetadata(ghost)?.answerId).toBeUndefined();
    await settle();
    expect(h.answerFinish).not.toHaveBeenCalled();
  });
});

function lastInputOf(index: number): RunRetrievalInput {
  return h.runRetrieval.mock.calls[index][0] as RunRetrievalInput;
}
