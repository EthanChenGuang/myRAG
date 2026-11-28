import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeQueryLlm } from '../../eval/harness/fake-query-llm.mts';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import type { RunRetrievalInput } from '@/lib/rag/types';
import { chatRequest, installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';
import { hit } from './fusion/helpers';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    scope: { current: null as unknown },
    runRetrieval: vi.fn(),
    embedAnswer: { text: 'A neutral placeholder answer.' },
  };
});

// The embed route builds its response from toUIMessageStream, as toUIMessageStreamResponse does; this marks the model's answer
function modelStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'model' });
      controller.enqueue({ type: 'text-delta', id: 'model', delta: 'model stream' });
      controller.enqueue({ type: 'text-end', id: 'model' });
      controller.close();
    },
  });
}

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => {
    const result = await h.capture.streamText(params);
    const embed = params.maxOutputTokens === 2000 && params.tools === undefined;
    if (embed) (params.onFinish as ((event: { text: string }) => void) | undefined)?.({ text: h.embedAnswer.text });
    return embed ? { ...result, toUIMessageStream: () => modelStream() } : result;
  },
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const QUESTION = 'What does the placeholder section describe?';
const DOC_X = '00000000-0000-4000-8000-0000000036f1';

interface ScopeDesc {
  kind: 'single' | 'org';
  userId: string | null;
  organizationId: string | null;
}
const SINGLE: ScopeDesc = { kind: 'single', userId: null, organizationId: null };
const TENANT_A: ScopeDesc = { kind: 'org', userId: '00000000-0000-4000-8000-0000000036b1', organizationId: '00000000-0000-4000-8000-0000000036b2' };
const TENANT_B: ScopeDesc = { kind: 'org', userId: '00000000-0000-4000-8000-0000000036b3', organizationId: '00000000-0000-4000-8000-0000000036b4' };

function scopeKey(scope: { kind: string; userId: string | null; organizationId: string | null }): string {
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

const PROCESS_ENV: Record<string, string> = {
  NEXT_PUBLIC_EMBED_ENABLED: 'true',
  NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS: '*',
  NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
  EMBED_RATE_LIMIT: '100000',
};

function memoryCache() {
  const entries: Array<{ tenant: string; keyHash: string; profile: string; standalone: string; answer: CachedAnswer }> = [];
  const checks: CacheQuery[] = [];
  const stores: Array<{ q: CacheQuery; answer: CachedAnswer }> = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      const tenant = scopeKey(q.scope as unknown as ScopeDesc);
      const found = entries.find(
        (entry) => entry.tenant === tenant && entry.keyHash === computeCacheKeyHash(q) && entry.profile === q.embeddingProfileId && entry.standalone === q.standalone,
      );
      return found ? { entryId: 'entry-1', distance: 0, answer: found.answer } : null;
    },
    async store(q, answer) {
      stores.push({ q, answer });
      entries.push({ tenant: scopeKey(q.scope as unknown as ScopeDesc), keyHash: computeCacheKeyHash(q), profile: q.embeddingProfileId, standalone: q.standalone, answer });
    },
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, checks, stores };
}

let memory = memoryCache();

async function loadRoutes(ragEnv: Record<string, string>) {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const current = () => {
      const desc = (h.scope.current as ScopeDesc | null) ?? SINGLE;
      return mintScope(desc.kind, desc.userId, desc.organizationId);
    };
    h.runRetrieval.mockImplementation(actual.runRetrieval);
    return {
      ...actual,
      runRetrieval: h.runRetrieval,
      resolveTenantScope: async () => ({ ok: true, scope: current() }),
      resolveEmbedScope: async () => ({ ok: true, scope: current() }),
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
        const rows = ((args.p_document_ids as string[]) ?? []).map((id) => ({ document_id: id, name: 'placeholder.md', version: 1 }));
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
      return {
        dense: [
          hit(`${DOC_X.slice(0, 30)}c0`, {
            rank: 1,
            similarity: 0.92,
            documentId: DOC_X,
            chunkIndex: 0,
            content: 'A neutral placeholder sentence about the section.',
            document: { filename: 'placeholder.md', createdAt: '2026-01-01T00:00:00.000Z', metadata: {}, contentPreview: '' },
          }),
        ],
        lexical: [],
      };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  } as never);
  const startup = await import('@/lib/rag/v2/startup');
  await startup.verifyV2Startup();
  const embed = await import('@/app/api/embed/chat/route');
  const chat = await import('@/app/api/chat/route');
  return { embed, chat };
}

type Routes = Awaited<ReturnType<typeof loadRoutes>>;

function askEmbed(routes: Routes): Promise<Response> {
  return routes.embed.POST(
    new NextRequest('http://localhost/api/embed/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.36' },
      body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }] }),
    }),
  );
}

function askChat(routes: Routes): Promise<Response> {
  return routes.chat.POST(chatRequest({ messages: [{ role: 'user', content: QUESTION }], data: { ragMode: 'balanced', settings: { webSearch: false } } }));
}

function startMetadata(body: string): Record<string, unknown> | undefined {
  const start = body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .find((event) => event.type === 'start');
  return start?.messageMetadata as Record<string, unknown> | undefined;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const stored = (count: number) => vi.waitFor(() => expect(memory.stores).toHaveLength(count), { timeout: 2000, interval: 10 });

describe('embed route semantic cache (CACHE-01, D-32, A-3)', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [name, value] of Object.entries(PROCESS_ENV)) {
      saved[name] = env[name];
      env[name] = value;
    }
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  });

  beforeEach(() => {
    memory = memoryCache();
    h.scope.current = SINGLE;
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockImplementation(async () => retrievalWith([]));
    h.runRetrieval.mockClear();
    h.supabase.store.reset();
    h.supabase.store.documents = [{ id: DOC_X, filename: 'placeholder.md', created_at: '2026-01-01T00:00:00.000Z', content: 'x', metadata: {} }];
    h.supabase.store.document_chunks = [{ id: `${DOC_X.slice(0, 30)}c0`, document_id: DOC_X, metadata: null }];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock('@/lib/rag');
    vi.restoreAllMocks();
  });

  it('passes an embed cache context with the embed prompt hash and no tools', async () => {
    const routes = await loadRoutes(CACHE_ON);
    await (await askEmbed(routes)).text();
    const input = h.runRetrieval.mock.calls[0][0] as RunRetrievalInput;
    expect(input.profile).toBe('embed');
    expect(input.cacheContext).toMatchObject({ webSearch: false, mcpTools: false, chatId: null });
    expect(input.cacheContext?.systemPromptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(memory.checks.map((q) => q.entryProfile)).toEqual(['embed']);
  });

  it('check-only by default: an embed miss schedules no store', async () => {
    const routes = await loadRoutes(CACHE_ON);
    expect(await (await askEmbed(routes)).text()).toContain('"delta":"model stream"');
    await settle();
    expect(memory.checks).toHaveLength(1);
    expect(memory.stores).toEqual([]);
  });

  it('RAG_SEMANTIC_CACHE_EMBED_STORE=true: stores under the embed profile and a repeat streams the hit with cache: hit and no model call', async () => {
    const routes = await loadRoutes({ ...CACHE_ON, RAG_SEMANTIC_CACHE_EMBED_STORE: 'true' });
    await (await askEmbed(routes)).text();
    await stored(1);
    expect(memory.stores[0].q.entryProfile).toBe('embed');
    expect(memory.stores[0].answer.answer_text).toBe('A neutral placeholder answer.');

    h.capture.reset();
    const response = await askEmbed(routes);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const body = await response.text();
    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(startMetadata(body)).toMatchObject({ cache: 'hit', ragTraceId: memory.stores[0].answer.trace_id });
    expect(body).toContain('A neutral placeholder answer.');
  });

  it('a chat entry never hits in embed, and an embed entry never hits in chat', async () => {
    const routes = await loadRoutes({ ...CACHE_ON, RAG_SEMANTIC_CACHE_EMBED_STORE: 'true' });
    await (await askChat(routes)).text();
    await stored(1);
    expect(memory.stores[0].q.entryProfile).toBe('chat');

    h.capture.reset();
    const embedBody = await (await askEmbed(routes)).text();
    expect(embedBody).toContain('"delta":"model stream"');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    await stored(2);
    expect(memory.stores[1].q.entryProfile).toBe('embed');
    expect(computeCacheKeyHash(memory.stores[0].q)).not.toBe(computeCacheKeyHash(memory.stores[1].q));

    memory.stores.length = 0;
    h.capture.reset();
    const chatBody = await (await askChat(routes)).text();
    expect(startMetadata(chatBody)?.cache).toBe('hit');
    h.capture.reset();
    const embedAgain = await (await askEmbed(routes)).text();
    expect(startMetadata(embedAgain)?.cache).toBe('hit');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('two tenants: an embed scope of tenant B never receives tenant A\'s entry, with the store switch on', async () => {
    const routes = await loadRoutes({ ...CACHE_ON, RAG_SEMANTIC_CACHE_EMBED_STORE: 'true' });
    h.scope.current = TENANT_A;
    await (await askEmbed(routes)).text();
    await stored(1);

    h.scope.current = TENANT_B;
    h.capture.reset();
    const body = await (await askEmbed(routes)).text();
    expect(body).toContain('"delta":"model stream"');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(scopeKey(memory.checks[memory.checks.length - 1].scope as unknown as ScopeDesc)).toBe(scopeKey(TENANT_B));
    await stored(2);
    expect(memory.stores.map((entry) => scopeKey(entry.q.scope as unknown as ScopeDesc))).toEqual([scopeKey(TENANT_A), scopeKey(TENANT_B)]);

    h.scope.current = TENANT_A;
    h.capture.reset();
    const control = await (await askEmbed(routes)).text();
    expect(startMetadata(control)?.cache).toBe('hit');
  });

  it('cache off: no cacheContext, no check, the model stream as today', async () => {
    const routes = await loadRoutes({ ...CACHE_ON, RAG_SEMANTIC_CACHE: 'off' });
    expect(await (await askEmbed(routes)).text()).toContain('"delta":"model stream"');
    expect((h.runRetrieval.mock.calls[0][0] as RunRetrievalInput).cacheContext).toBeUndefined();
    expect(memory.checks).toEqual([]);
  });
});
