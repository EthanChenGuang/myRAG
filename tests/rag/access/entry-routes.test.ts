import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { AccessIdentity, ResolveAccessScopeInput } from '@/lib/rag/tenant/access';
import type { RunRetrievalInput } from '@/lib/rag/types';
import { FAKE_USER_ID, chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';

const GROUP_1 = '00000000-0000-4000-8000-0000000000f1';
const OTHER_GROUP = '00000000-0000-4000-8000-0000000000f9';
const QUESTION = 'What does the synthetic sample note say about the sample topic?';
const UNAVAILABLE_EN = 'The knowledge base is temporarily unavailable';
const MODE = 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE';
const ENV_NAMES = [
  MODE,
  'RAG_DOC_ACCESS_GROUPS',
  'RAG_EMBED_ACCESS_GROUP',
  'NEXT_PUBLIC_EMBED_ENABLED',
  'MYRAG_INTERNAL_API_KEY',
  'RAG_EVAL_SECRET',
] as const;
const INTERNAL_KEY = 'test-internal-api-key-placeholder';
const EVAL_SECRET = 'e'.repeat(48);
const USER_V = '00000000-0000-4000-8000-0000000000a7';
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  process.env.FAL_API_KEY = 'test-fal-key-placeholder';
  delete process.env.USE_OPENAI_IMAGE;
  delete process.env.USE_REPLICATE_PROVIDER;
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
    results: [] as Array<{ status: string; reason?: string }>,
    voiceActor: null as string | null,
    providerPrompts: [] as string[],
    ...fakes.createChatRouteHarness(),
    runInputs: [] as RunRetrievalInput[],
    identities: [] as AccessIdentity[],
    refuse: null as null | 'access_lookup_failed' | 'access_not_ready',
    memberships: new Map<string, string[]>(),
    embedGroups: new Map<string, string>(),
    resolverCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const storage = {
    listBuckets: async () => ({ data: [{ name: 'chat-videos' }, { name: 'chat-images' }], error: null }),
    createBucket: async () => ({ data: {}, error: null }),
    from: () => ({
      list: async () => ({ data: [], error: null }),
      upload: async () => ({ data: {}, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'http://storage.invalid/object' } }),
    }),
  };
  return {
    ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
    createClient: () =>
      new Proxy(h.supabase.client as object, { get: (target, key) => (key === 'storage' ? storage : Reflect.get(target, key)) }),
  };
});
vi.mock('@fal-ai/client', () => ({
  fal: {
    config: () => undefined,
    subscribe: async (_model: string, options: { input: { prompt: string } }) => {
      h.providerPrompts.push(options.input.prompt);
      return { data: { images: [] } };
    },
    queue: {
      submit: async (_model: string, options: { input: { prompt: string } }) => {
        h.providerPrompts.push(options.input.prompt);
        throw new Error('provider stopped by test');
      },
    },
  },
}));
vi.mock('@/lib/title-generator', () => ({ generateTitle: () => 'Voice chat', generateSmartTitle: async () => null }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

/** The resolver RPCs answered from h.memberships and h.embedGroups; every call is recorded. */
function resolverAdmin(): RpcClient {
  return {
    rpc(fn, args) {
      h.resolverCalls.push({ fn, args });
      const respond = (): RpcResponse => {
        if (fn === 'rag_resolve_access_scope') {
          const groups = h.memberships.get(String(args.p_user_id)) ?? [];
          return {
            data: [{ is_admin: false, group_ids: groups, effective_keys: ['all', ...groups.map((id) => `g:${id}`)] }],
            error: null,
          };
        }
        if (fn === 'rag_access_group_by_key') {
          const id = h.embedGroups.get(String(args.p_key));
          return { data: id ? [{ id, labels_current: true }] : [], error: null };
        }
        return { data: [], error: null };
      };
      const request = {
        abortSignal: () => request,
        then: (ok: (value: RpcResponse) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve().then(respond).then(ok, bad),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
}

/**
 * Registered after each vi.resetModules(): the resolver reads the fake RPCs, and runRetrieval inputs are recorded. With stubRetrieval a
 * resolved request retrieves with no scope (no database), while a scope left unresolved runs the real fail-closed check.
 */
function installAccessSpies(options: { stubRetrieval?: boolean } = {}): void {
  vi.doMock('@/lib/rag/tenant/access-startup', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rag/tenant/access-startup')>()),
    accessReadyForResolve: async () => h.refuse !== 'access_not_ready',
  }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      resolveAccessScope: (input: ResolveAccessScopeInput) => {
        h.identities.push(input.identity);
        if (h.refuse === 'access_lookup_failed') return Promise.resolve({ ok: false, status: 503, reason: 'access_lookup_failed' } as const);
        return actual.resolveAccessScope({ ...input, admin: resolverAdmin() });
      },
      resolveEmbedScope: async () => {
        const { mintScope } = await import('@/lib/rag/tenant/scope');
        return { ok: true, scope: mintScope('single', null, null) };
      },
      resolveVoiceScope: async () => {
        const { mintScope } = await import('@/lib/rag/tenant/scope');
        return { ok: true, scope: mintScope('single', null, null), actorUserId: h.voiceActor };
      },
      runRetrieval: async (input: RunRetrievalInput) => {
        h.runInputs.push(input);
        let unresolved = false;
        if (input.scope) {
          try {
            actual.scopeAccessFilter(input.scope);
          } catch {
            unresolved = true;
          }
        }
        const result = await actual.runRetrieval(options.stubRetrieval && !unresolved ? { ...input, scope: null } : input);
        h.results.push({ status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
        return result;
      },
    };
  });
}

async function filterOf(input: RunRetrievalInput | undefined) {
  const rag = await import('@/lib/rag');
  if (!input?.scope) return null;
  try {
    return rag.scopeAccessFilter(input.scope);
  } catch {
    return { mode: 'unresolved' as const };
  }
}

function bodyClaimLogs(): number {
  return vi.mocked(console.warn).mock.calls.filter((call) => call[0] === '[RAG Access] body_group_claim_ignored').length;
}

function row(id: string) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `Chunk 1 of 1 about the sample topic ${id}`,
    similarity: 0.9,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: 0.9,
    match_reason: 'similarity',
  };
}

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  env[MODE] = 'single-tenant';
  delete env.RAG_DOC_ACCESS_GROUPS;
  delete env.RAG_EMBED_ACCESS_GROUP;
  h.runInputs.length = 0;
  h.identities.length = 0;
  h.results.length = 0;
  h.providerPrompts.length = 0;
  h.voiceActor = null;
  h.resolverCalls.length = 0;
  h.refuse = null;
  h.memberships.clear();
  h.embedGroups.clear();
  h.capture.reset();
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(retrievalWith([]));
  h.supabase.store.reset();
  h.supabase.store.documents = [];
  h.supabase.store.document_chunks = [];
  h.ssr.auth.getUser.mockImplementation(async () => ({ data: { user: { id: FAKE_USER_ID } }, error: null }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('@/lib/rag');
  vi.doUnmock('@/lib/rag/tenant/access-startup');
  vi.restoreAllMocks();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete env[name];
    else env[name] = saved[name];
  }
});

describe('chat route access resolution (D-05, D-06, D-10)', () => {
  async function loadChat() {
    vi.resetModules();
    installAccessSpies();
    await installChatPipeline(h);
    return import('@/app/api/chat/route');
  }

  function postChat(route: Awaited<ReturnType<typeof loadChat>>, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
    return route.POST(
      chatRequest({
        messages: [{ role: 'user', content: QUESTION }],
        data: { ragMode: 'strict', settings: { webSearch: false }, ...data },
        ...extra,
      }),
    );
  }

  it('a signed-in member retrieves with the keys the resolver RPC returned for the session user', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    h.memberships.set(FAKE_USER_ID, [GROUP_1]);
    await readSse(await postChat(await loadChat()));

    expect(h.identities).toEqual([{ kind: 'user', userId: FAKE_USER_ID }]);
    expect(h.resolverCalls.map((call) => call.fn)).toEqual(['rag_resolve_access_scope']);
    expect(h.runInputs).toHaveLength(1);
    const filter = await filterOf(h.runInputs[0]);
    expect(filter?.mode).toBe('keys');
    expect(filter && filter.mode === 'keys' ? [...filter.keys].sort() : null).toEqual(['all', `g:${GROUP_1}`, `u:${FAKE_USER_ID}`].sort());
  });

  it('a body group claim yields the same filter and is logged exactly once', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    h.memberships.set(FAKE_USER_ID, [GROUP_1]);
    await readSse(await postChat(await loadChat(), { accessGroups: [`g:${OTHER_GROUP}`], groups: [`g:${OTHER_GROUP}`] }));

    const filter = await filterOf(h.runInputs[0]);
    expect(filter && filter.mode === 'keys' ? [...filter.keys].sort() : null).toEqual(['all', `g:${GROUP_1}`, `u:${FAKE_USER_ID}`].sort());
    expect(JSON.stringify(filter)).not.toContain(OTHER_GROUP);
    expect(bodyClaimLogs()).toBe(1);
  });

  it('a request without a session resolves as anonymous and sees only documents labelled all', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    h.ssr.auth.getUser.mockImplementation(async () => ({ data: { user: null }, error: null }) as never);
    await readSse(await postChat(await loadChat()));

    expect(h.identities).toEqual([{ kind: 'anonymous' }]);
    const filter = await filterOf(h.runInputs[0]);
    expect(filter && filter.mode === 'keys' ? filter.keys : null).toEqual(['all']);
  });

  it.each(['access_lookup_failed', 'access_not_ready'] as const)(
    'a %s refusal in strict mode with web search off streams the unavailable message, never information not available',
    async (reason) => {
      env.RAG_DOC_ACCESS_GROUPS = 'on';
      h.refuse = reason;
      h.retrieval.mockResolvedValue(retrievalWith([row('1')]));
      const body = await readSse(await postChat(await loadChat()));

      expect(body).toContain('"type":"error"');
      expect(body).toContain(UNAVAILABLE_EN);
      expect(body).not.toContain('Information Not Available');
      expect(h.capture.streamText).not.toHaveBeenCalled();
      expect(h.retrieval).not.toHaveBeenCalled();
    },
  );

  it('a refusal in balanced mode answers without knowledge-base context', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    h.refuse = 'access_lookup_failed';
    h.retrieval.mockResolvedValue(retrievalWith([row('1')]));
    const body = await readSse(await postChat(await loadChat(), {}, { ragMode: 'balanced' }));

    expect(body).not.toContain('"type":"error"');
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.capture.calls[0].messages)).not.toContain('RELEVANT INFORMATION FROM DOCUMENTS');
    expect(h.retrieval).not.toHaveBeenCalled();
  });

  it('with the switch off the filter is off, no resolver RPC runs and the search RPC args carry no access argument', async () => {
    await readSse(await postChat(await loadChat(), { accessGroups: [`g:${OTHER_GROUP}`] }));

    expect(h.resolverCalls).toEqual([]);
    expect(await filterOf(h.runInputs[0])).toEqual({ mode: 'off' });
    expect(h.retrieval).toHaveBeenCalled();
    for (const [, args] of h.retrieval.mock.calls) {
      expect(Object.keys(args as Record<string, unknown>).some((key) => key.startsWith('p_access'))).toBe(false);
    }
    expect(bodyClaimLogs()).toBe(1);
  });
});

function jsonPost(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function loadRoute<T>(path: string): Promise<T> {
  vi.resetModules();
  installAccessSpies({ stubRetrieval: true });
  await installChatPipeline(h);
  return (await import(/* @vite-ignore */ path)) as T;
}

type RouteModule = { POST: (req: NextRequest) => Promise<Response> };

async function keysOf(input: RunRetrievalInput | undefined): Promise<string[] | string | null> {
  const filter = await filterOf(input);
  if (!filter) return null;
  return filter.mode === 'keys' && 'keys' in filter ? [...filter.keys].sort() : filter.mode;
}

describe('embed route access resolution (D-07)', () => {
  const load = () => loadRoute<RouteModule>('@/app/api/embed/chat/route');
  const post = (route: RouteModule, extra: Record<string, unknown> = {}) =>
    route.POST(jsonPost('/api/embed/chat', { messages: [{ role: 'user', content: QUESTION }], ...extra }, { 'x-forwarded-for': '203.0.113.7' }));

  beforeEach(() => {
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    env.RAG_DOC_ACCESS_GROUPS = 'on';
  });

  it('without RAG_EMBED_ACCESS_GROUP visitors get keys all and no lookup runs', async () => {
    await (await post(await load())).text();

    expect(h.identities).toEqual([{ kind: 'embed', groupKey: '' }]);
    expect(h.resolverCalls).toEqual([]);
    expect(await keysOf(h.runInputs[0])).toEqual(['all']);
  });

  it('a configured existing group key adds that group', async () => {
    env.RAG_EMBED_ACCESS_GROUP = 'sample-group';
    h.embedGroups.set('sample-group', GROUP_1);
    await (await post(await load())).text();

    expect(h.identities).toEqual([{ kind: 'embed', groupKey: 'sample-group' }]);
    expect(await keysOf(h.runInputs[0])).toEqual(['all', `g:${GROUP_1}`].sort());
  });

  it('an unknown configured key falls back to keys all and logs once', async () => {
    env.RAG_EMBED_ACCESS_GROUP = 'missing-group';
    await (await post(await load())).text();

    expect(await keysOf(h.runInputs[0])).toEqual(['all']);
    expect(vi.mocked(console.warn).mock.calls.filter((call) => call[0] === '[RAG Access] embed_group_not_found')).toHaveLength(1);
  });

  it('a body group claim is ignored and logged once', async () => {
    await (await post(await load(), { accessGroups: [`g:${OTHER_GROUP}`] })).text();

    expect(await keysOf(h.runInputs[0])).toEqual(['all']);
    expect(bodyClaimLogs()).toBe(1);
  });

  it('a refusal answers with the knowledge base unavailable stream', async () => {
    h.refuse = 'access_lookup_failed';
    const body = await (await post(await load())).text();

    expect(body).toContain(UNAVAILABLE_EN);
    expect(body).not.toContain('Information Not Available');
    expect(h.results).toEqual([{ status: 'error', reason: 'access_scope_missing' }]);
  });

  it('with the switch off the filter is off and no lookup runs', async () => {
    delete env.RAG_DOC_ACCESS_GROUPS;
    env.RAG_EMBED_ACCESS_GROUP = 'sample-group';
    await (await post(await load())).text();

    expect(h.resolverCalls).toEqual([]);
    expect(await keysOf(h.runInputs[0])).toBe('off');
  });
});

describe('voice routes access resolution (D-06, D-08)', () => {
  const loadRag = () => loadRoute<RouteModule>('@/app/api/internal/voice-rag/route');
  const postRag = (route: RouteModule, extra: Record<string, unknown> = {}) =>
    route.POST(jsonPost('/api/internal/voice-rag', { query: QUESTION, ...extra }, { 'x-api-key': INTERNAL_KEY }));

  beforeEach(() => {
    env.MYRAG_INTERNAL_API_KEY = INTERNAL_KEY;
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    h.voiceActor = USER_V;
  });

  it('voice-rag resolves the token actor fresh on every turn, so a removed membership is gone on the next one', async () => {
    h.memberships.set(USER_V, [GROUP_1]);
    const route = await loadRag();
    await (await postRag(route)).json();
    h.memberships.set(USER_V, []);
    await (await postRag(route)).json();

    expect(h.identities).toEqual([
      { kind: 'user', userId: USER_V },
      { kind: 'user', userId: USER_V },
    ]);
    expect(h.resolverCalls.filter((call) => call.fn === 'rag_resolve_access_scope')).toHaveLength(2);
    expect(await keysOf(h.runInputs[0])).toEqual(['all', `g:${GROUP_1}`, `u:${USER_V}`].sort());
    expect(await keysOf(h.runInputs[1])).toEqual(['all', `u:${USER_V}`].sort());
  });

  it('voice-rag ignores a body group claim and logs it once', async () => {
    await (await postRag(await loadRag(), { accessGroups: [`g:${OTHER_GROUP}`] })).json();

    expect(await keysOf(h.runInputs[0])).toEqual(['all', `u:${USER_V}`].sort());
    expect(bodyClaimLogs()).toBe(1);
  });

  it('voice-rag without an actor resolves as anonymous', async () => {
    h.voiceActor = null;
    await (await postRag(await loadRag())).json();

    expect(h.identities).toEqual([{ kind: 'anonymous' }]);
    expect(await keysOf(h.runInputs[0])).toEqual(['all']);
  });

  it('a voice-rag refusal answers 503 knowledge_base_unavailable', async () => {
    h.refuse = 'access_lookup_failed';
    const response = await postRag(await loadRag());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'knowledge_base_unavailable', reason: 'access_scope_missing' });
  });

  it('voice-rag with the switch off sends an off filter and runs no lookup', async () => {
    delete env.RAG_DOC_ACCESS_GROUPS;
    await (await postRag(await loadRag())).json();

    expect(h.resolverCalls).toEqual([]);
    expect(await keysOf(h.runInputs[0])).toBe('off');
  });

  it('voice-chat ignores a body group claim, logs it once and looks nothing up', async () => {
    const route = await loadRoute<RouteModule>('@/app/api/internal/voice-chat/route');
    await route.POST(
      jsonPost(
        '/api/internal/voice-chat',
        { messages: [{ role: 'user', content: QUESTION }, { role: 'assistant', content: 'A synthetic reply.' }], groups: [`g:${OTHER_GROUP}`] },
        { 'x-api-key': INTERNAL_KEY },
      ),
    );

    expect(bodyClaimLogs()).toBe(1);
    expect(h.resolverCalls).toEqual([]);
    expect(h.runInputs).toEqual([]);
  });
});

describe('eval run route access resolution (A-15)', () => {
  const load = () => loadRoute<RouteModule>('@/app/api/internal/rag/run/route');
  const post = (route: RouteModule, extra: Record<string, unknown> = {}, options: Record<string, unknown> = { user_id: USER_V }) =>
    route.POST(
      jsonPost('/api/internal/rag/run', { schema_version: 1, query: QUESTION, rag_mode: 'flexible', options, ...extra }, { 'x-rag-eval-secret': EVAL_SECRET }),
    );

  beforeEach(() => {
    env.RAG_EVAL_SECRET = EVAL_SECRET;
    env.RAG_DOC_ACCESS_GROUPS = 'on';
  });

  it('resolves the groups of the user id admitted by the eval scope check', async () => {
    h.memberships.set(USER_V, [GROUP_1]);
    await (await post(await load())).text();

    expect(h.identities).toEqual([{ kind: 'eval', userId: USER_V }]);
    expect(await keysOf(h.runInputs[0])).toEqual(['all', `g:${GROUP_1}`, `u:${USER_V}`].sort());
  });

  it('a run without a user id resolves to keys all', async () => {
    await (await post(await load(), {}, {})).text();

    expect(h.identities).toEqual([{ kind: 'eval', userId: null }]);
    expect(await keysOf(h.runInputs[0])).toEqual(['all']);
  });

  it('a body group claim is logged once and rejected by the strict contract before any retrieval', async () => {
    const response = await post(await load(), { accessGroups: [`g:${OTHER_GROUP}`] });

    expect(response.status).toBe(400);
    expect(bodyClaimLogs()).toBe(1);
    expect(h.runInputs).toEqual([]);
  });

  it('a refusal answers with the existing retrieval failure', async () => {
    h.refuse = 'access_lookup_failed';
    const response = await post(await load());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'retrieval failed', reason: 'access_scope_missing' });
  });
});

describe('media routes access resolution', () => {
  beforeEach(() => {
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    h.memberships.set(FAKE_USER_ID, [GROUP_1]);
  });

  it.each([
    ['generate-image', '/api/generate-image'],
    ['generate-video', '/api/generate-video'],
  ])('%s resolves the session user and ignores a body group claim', async (name, path) => {
    const route = await loadRoute<RouteModule>(`@/app/api/${name}/route`);
    await (await route.POST(jsonPost(path, { prompt: QUESTION, useContext: true, accessGroups: [`g:${OTHER_GROUP}`] }))).text();

    expect(h.identities).toEqual([{ kind: 'user', userId: FAKE_USER_ID }]);
    expect(await keysOf(h.runInputs[0])).toEqual(['all', `g:${GROUP_1}`, `u:${FAKE_USER_ID}`].sort());
    expect(bodyClaimLogs()).toBe(1);
  });

  it.each([
    ['generate-image', '/api/generate-image'],
    ['generate-video', '/api/generate-video'],
  ])('a %s refusal continues without context (status error, never a wider scope)', async (name, path) => {
    h.refuse = 'access_lookup_failed';
    const route = await loadRoute<RouteModule>(`@/app/api/${name}/route`);
    await (await route.POST(jsonPost(path, { prompt: QUESTION, useContext: true }))).text();

    expect(h.results).toEqual([{ status: 'error', reason: 'access_scope_missing' }]);
    expect(h.providerPrompts).toEqual([QUESTION]);
  });
});
