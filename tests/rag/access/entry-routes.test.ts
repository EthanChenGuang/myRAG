import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { AccessIdentity, ResolveAccessScopeInput } from '@/lib/rag/tenant/access';
import type { RunRetrievalInput } from '@/lib/rag/types';
import { FAKE_USER_ID, chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';

const GROUP_1 = '00000000-0000-4000-8000-0000000000f1';
const OTHER_GROUP = '00000000-0000-4000-8000-0000000000f9';
const QUESTION = 'What does the synthetic sample note say about the sample topic?';
const UNAVAILABLE_EN = 'The knowledge base is temporarily unavailable';
const MODE = 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE';
const ENV_NAMES = [MODE, 'RAG_DOC_ACCESS_GROUPS', 'RAG_EMBED_ACCESS_GROUP'] as const;
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
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
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: () => h.supabase.client,
}));
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

/** Registered after each vi.resetModules(): the resolver reads the fake RPCs, and runRetrieval inputs are recorded. */
function installAccessSpies(): void {
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
      runRetrieval: (input: RunRetrievalInput) => {
        h.runInputs.push(input);
        return actual.runRetrieval(input);
      },
    };
  });
}

async function filterOf(input: RunRetrievalInput | undefined) {
  const rag = await import('@/lib/rag');
  if (!input?.scope) return null;
  return rag.scopeAccessFilter(input.scope);
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
