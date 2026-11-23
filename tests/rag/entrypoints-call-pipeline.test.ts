import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { chatRequest, createChatRouteHarness, installChatPipeline, readSse } from '../helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'RAG_EVAL_ALLOWED_SCOPES',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'NODE_ENV',
] as const;
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;

describe('entry point: eval route calls the pipeline', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.NODE_ENV = 'test';
    env.RAG_EVAL_SECRET = SECRET;
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.doUnmock('@/lib/rag');
    vi.resetModules();
  });

  async function callEvalRoute(deploymentMode: string, body: Record<string, unknown>) {
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = deploymentMode;
    vi.resetModules();
    const retrievalSpy = vi.fn();
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return {
        ...actual,
        runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
          retrievalSpy(input);
          return actual.runRetrieval(input);
        },
      };
    });
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({
      embedder: async () => [0.1, 0.2, 0.3],
      adminClient: () => {
        const request = {
          abortSignal: () => request,
          then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
        };
        return { rpc: () => request } as never;
      },
    });
    const route = await import('@/app/api/internal/rag/run/route');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await route.POST(
        new NextRequest('http://localhost/api/internal/rag/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
          body: JSON.stringify({ schema_version: 1, query: 'What is the refund window?', rag_mode: 'strict', ...body }),
        }),
      );
      return { status: res.status, retrievalSpy, deps };
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      deps.resetRagDepsForTests();
    }
  }

  test('single-tenant: runRetrieval is called with profile eval and a minted single scope', async () => {
    const { status, retrievalSpy } = await callEvalRoute('single-tenant', {});
    expect(status).toBe(200);
    expect(retrievalSpy).toHaveBeenCalledTimes(1);
    const input = retrievalSpy.mock.calls[0][0];
    expect(input.profile).toBe('eval');
    expect(input.options).toMatchObject({ webSearchEnabled: false, ragMode: 'strict' });
    const scope = await import('@/lib/rag/tenant/scope');
    expect(scope.isTenantScope(input.scope)).toBe(true);
    expect(scope.scopeKey(input.scope)).toBe('s:default');
  });

  test('multi-tenant: the scope is the allow-listed workspace minted through evalScope', async () => {
    env.RAG_EVAL_ALLOWED_SCOPES = `org:${ORG}`;
    const { status, retrievalSpy } = await callEvalRoute('multi-tenant', { options: { organization_id: ORG, user_id: USER } });
    expect(status).toBe(200);
    expect(retrievalSpy).toHaveBeenCalledTimes(1);
    const input = retrievalSpy.mock.calls[0][0];
    expect(input.profile).toBe('eval');
    const scope = await import('@/lib/rag/tenant/scope');
    expect(scope.isTenantScope(input.scope)).toBe(true);
    expect(scope.scopeKey(input.scope)).toBe(`o:${ORG}`);
  });

  test('a scope outside the allow-list never reaches runRetrieval', async () => {
    env.RAG_EVAL_ALLOWED_SCOPES = `org:${ORG}`;
    const { status, retrievalSpy } = await callEvalRoute('multi-tenant', {
      options: { organization_id: '22222222-2222-4222-8222-222222222222', user_id: USER },
    });
    expect(status).toBe(403);
    expect(retrievalSpy).not.toHaveBeenCalled();
  });
});

describe('entry point: chat route calls the pipeline', () => {
  const MODE_NAME = 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE';
  const CHAT_ORG = '44444444-4444-4444-8444-444444444444';
  const savedMode = env[MODE_NAME];

  afterEach(() => {
    for (const name of ['ai', '@/lib/supabase', '@/lib/supabase/server', '@openrouter/ai-sdk-provider', 'exa-js', '@/lib/document-processor', '@/lib/rag']) {
      vi.doUnmock(name);
    }
    if (savedMode === undefined) delete env[MODE_NAME];
    else env[MODE_NAME] = savedMode;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function callChatRoute(deploymentMode: string, data: Record<string, unknown>) {
    env[MODE_NAME] = deploymentMode;
    const h = createChatRouteHarness();
    const retrievalSpy = vi.fn();
    h.retrieval.mockResolvedValue({ chunks: [] });
    vi.resetModules();
    vi.doMock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), streamText: h.capture.streamText }));
    vi.doMock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
    vi.doMock('@/lib/supabase', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/supabase')>()),
      getSupabaseAdmin: () => h.supabase.client,
      searchSimilarChunks: vi.fn(async () => []),
    }));
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
    vi.doMock('@openrouter/ai-sdk-provider', () => ({
      createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
    }));
    vi.doMock('exa-js', () => ({ default: h.exa.Exa }));
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return {
        ...actual,
        runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
          retrievalSpy(input);
          return actual.runRetrieval(input);
        },
      };
    });
    await installChatPipeline(h);
    const route = await import('@/app/api/chat/route');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await route.POST(
      chatRequest({
        messages: [{ role: 'user', content: 'What is the refund window?' }],
        data: { ragMode: 'strict', settings: { webSearch: false }, ...data },
      }),
    );
    await readSse(response);
    return { status: response.status, retrievalSpy, h };
  }

  test('single-tenant: runRetrieval is called with profile chat and a minted single scope', async () => {
    const { status, retrievalSpy, h } = await callChatRoute('single-tenant', {});
    expect(status).toBe(200);
    expect(retrievalSpy).toHaveBeenCalledTimes(1);
    const input = retrievalSpy.mock.calls[0][0];
    expect(input.profile).toBe('chat');
    expect(input.options).toMatchObject({ webSearchEnabled: false, ragMode: 'strict' });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    const scope = await import('@/lib/rag/tenant/scope');
    expect(scope.isTenantScope(input.scope)).toBe(true);
    expect(scope.scopeKey(input.scope)).toBe('s:default');
    expect(h.retrieval).toHaveBeenCalled();
  });

  test('multi-tenant: a body organization without a membership never reaches runRetrieval', async () => {
    const { status, retrievalSpy, h } = await callChatRoute('multi-tenant', { organizationId: CHAT_ORG });
    expect(status).toBe(403);
    expect(retrievalSpy).not.toHaveBeenCalled();
    expect(h.retrieval).not.toHaveBeenCalled();
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });
});

describe('entry point: embed route calls the pipeline', () => {
  const EMBED_ENV = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'NEXT_PUBLIC_EMBED_ENABLED', 'RAG_EMBED_TENANT'] as const;
  const EMBED_ORG = '55555555-5555-4555-8555-555555555555';
  let embedSaved: Record<string, string | undefined>;

  beforeEach(() => {
    embedSaved = Object.fromEntries(EMBED_ENV.map((name) => [name, env[name]]));
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    delete env.RAG_EMBED_TENANT;
  });

  afterEach(() => {
    for (const name of EMBED_ENV) {
      if (embedSaved[name] === undefined) delete env[name];
      else env[name] = embedSaved[name];
    }
    for (const name of ['ai', '@openrouter/ai-sdk-provider', '@/lib/rag']) vi.doUnmock(name);
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function callEmbedRoute(deploymentMode: string, extraBody: Record<string, unknown> = {}) {
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = deploymentMode;
    vi.resetModules();
    const retrievalSpy = vi.fn();
    const streamSpy = vi.fn();
    vi.doMock('ai', async (importOriginal) => ({
      ...(await importOriginal<typeof import('ai')>()),
      streamText: async (params: unknown) => {
        streamSpy(params);
        return { toUIMessageStreamResponse: () => new Response('model stream') };
      },
    }));
    vi.doMock('@openrouter/ai-sdk-provider', () => ({
      createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
    }));
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return {
        ...actual,
        runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
          retrievalSpy(input);
          return actual.runRetrieval(input);
        },
      };
    });
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({
      embedder: async () => [0.1, 0.2, 0.3],
      adminClient: () =>
        ({
          rpc: () => {
            const request = {
              abortSignal: () => request,
              then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
            };
            return request;
          },
          from: () => {
            const query = {
              select: () => query,
              eq: () => query,
              abortSignal: () => query,
              maybeSingle: () => Promise.resolve({ data: { id: EMBED_ORG }, error: null }),
            };
            return query;
          },
        }) as never,
    });
    const route = await import('@/app/api/embed/chat/route');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await route.POST(
        new NextRequest('http://localhost/api/embed/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'What is the refund window?' }], ...extraBody }),
        }),
      );
      await res.text();
      return { status: res.status, retrievalSpy, streamSpy };
    } finally {
      deps.resetRagDepsForTests();
    }
  }

  test('single-tenant: runRetrieval is called with profile embed and a minted single scope', async () => {
    const { status, retrievalSpy, streamSpy } = await callEmbedRoute('single-tenant');
    expect(status).toBe(200);
    expect(retrievalSpy).toHaveBeenCalledTimes(1);
    const input = retrievalSpy.mock.calls[0][0];
    expect(input.profile).toBe('embed');
    expect(input.options).toMatchObject({ webSearchEnabled: false });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    const scope = await import('@/lib/rag/tenant/scope');
    expect(scope.isTenantScope(input.scope)).toBe(true);
    expect(scope.scopeKey(input.scope)).toBe('s:default');
    expect(streamSpy).toHaveBeenCalledTimes(1);
  });

  test('multi-tenant: the scope is the configured organization, not anything in the body', async () => {
    env.RAG_EMBED_TENANT = `o:${EMBED_ORG}`;
    const { status, retrievalSpy } = await callEmbedRoute('multi-tenant', { organizationId: EMBED_ORG });
    expect(status).toBe(200);
    expect(retrievalSpy).toHaveBeenCalledTimes(1);
    const scope = await import('@/lib/rag/tenant/scope');
    expect(scope.scopeKey(retrievalSpy.mock.calls[0][0].scope)).toBe(`o:${EMBED_ORG}`);
  });

  test('a body naming another workspace never reaches runRetrieval', async () => {
    env.RAG_EMBED_TENANT = `o:${EMBED_ORG}`;
    const { status, retrievalSpy, streamSpy } = await callEmbedRoute('multi-tenant', {
      organizationId: '66666666-6666-4666-8666-666666666666',
    });
    expect(status).toBe(403);
    expect(retrievalSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });
});
