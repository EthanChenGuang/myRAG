import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_USER_ID, chatRequest, installChatPipeline, readSse, retrievalWith } from '../helpers/chat-route-fakes';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const MODE = 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runSpy: vi.fn() };
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

const QUESTION = 'What is the refund policy for annual plans?';
const savedMode = process.env[MODE];

function row(id: string, similarity = 0.9) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `Chunk 1 of 1 about the refund policy ${id}`,
    similarity,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: similarity,
    match_reason: 'similarity',
  };
}

function seedDocuments(ids: string[]) {
  h.supabase.store.documents = ids.map((id) => ({
    id: `doc-${id}`,
    filename: `refund-policy-${id}.md`,
    created_at: '2026-01-01T00:00:00.000Z',
    content: 'refund policy',
    metadata: {},
  }));
  h.supabase.store.document_chunks = ids.map((id) => ({ id: `chunk-${id}`, document_id: `doc-${id}`, metadata: null }));
}

interface LoadOptions {
  mode?: 'single-tenant' | 'multi-tenant';
  adminClient?: () => unknown;
}

async function loadRoute(options: LoadOptions = {}) {
  process.env[MODE] = options.mode ?? 'single-tenant';
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
        h.runSpy(input);
        return actual.runRetrieval(input);
      },
    };
  });
  await installChatPipeline(h);
  if (options.adminClient) {
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({ adminClient: options.adminClient as never });
  }
  return import('@/app/api/chat/route');
}

function post(route: Awaited<ReturnType<typeof loadRoute>>, data: Record<string, unknown> = {}) {
  return route.POST(
    chatRequest({
      messages: [{ role: 'user', content: QUESTION }],
      data: { ragMode: 'strict', settings: { webSearch: false }, ...data },
    }),
  );
}

function flakyAdmin(failuresBeforeSuccess: number) {
  let remaining = failuresBeforeSuccess;
  return () => ({
    from: (table: string) => {
      if (table === 'documents' && remaining > 0) {
        remaining -= 1;
        throw new Error('documents lookup unavailable');
      }
      return h.supabase.client.from(table);
    },
  });
}

describe('chat route status mapping', () => {
  beforeEach(() => {
    h.capture.reset();
    h.runSpy.mockReset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([]));
    h.supabase.store.reset();
    h.supabase.store.documents = [];
    h.supabase.store.document_chunks = [];
    h.supabase.store.organizations = [];
    h.supabase.store.organization_members = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock('@/lib/rag');
    if (savedMode === undefined) delete process.env[MODE];
    else process.env[MODE] = savedMode;
  });

  it('status empty in strict mode with web search off streams the refusal and never calls streamText', async () => {
    const body = await readSse(await post(await loadRoute()));

    expect(h.retrieval).toHaveBeenCalled();
    expect(body).toContain('Information Not Available');
    expect(body).not.toContain('temporarily unavailable');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('status error streams a localized error part instead of the refusal', async () => {
    h.retrieval.mockRejectedValue(new Error('vector backend down'));
    const response = await post(await loadRoute(), { settings: { webSearch: false, language: 'zh' } });
    const body = await readSse(response);

    expect(body).toContain('"type":"error"');
    expect(body).toContain('知识库暂时无法访问');
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('status error logs under [Document Search] without the query text', async () => {
    h.retrieval.mockRejectedValue(new Error('vector backend down'));
    await readSse(await post(await loadRoute()));

    const logged = vi.mocked(console.error).mock.calls.filter((call) => call[0] === '[Document Search] Knowledge base unavailable:');
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).not.toContain(QUESTION);
    expect(logged[0][1]).toMatchObject({ status: 'error' });
  });

  it('degraded with used documents answers normally', async () => {
    seedDocuments(['1']);
    h.retrieval.mockResolvedValue(retrievalWith([row('1')]));
    const body = await readSse(await post(await loadRoute({ adminClient: flakyAdmin(1) })));

    expect(body).not.toContain('"type":"error"');
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.capture.calls[0].messages)).toContain('RELEVANT INFORMATION FROM DOCUMENTS');
  });

  it('degraded without used documents streams the localized error part', async () => {
    seedDocuments(['1']);
    h.retrieval.mockResolvedValue(retrievalWith([row('1')]));
    const body = await readSse(await post(await loadRoute({ adminClient: flakyAdmin(10) }), { settings: { webSearch: false, language: 'it' } }));

    expect(body).toContain('"type":"error"');
    expect(body).toContain('La base di conoscenza non è al momento disponibile');
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('single-tenant retrieves with the single scope and the global vector RPC', async () => {
    await readSse(await post(await loadRoute()));

    expect(h.runSpy).toHaveBeenCalledTimes(1);
    const input = h.runSpy.mock.calls[0][0];
    const { scopeKey } = await import('@/lib/rag/tenant/scope');
    expect(input.profile).toBe('chat');
    expect(scopeKey(input.scope)).toBe('s:default');
    expect(h.retrieval.mock.calls.every((call) => call[0] === 'match_document_chunks')).toBe(true);
  });
});

describe('chat route tenant scope', () => {
  beforeEach(() => {
    h.capture.reset();
    h.runSpy.mockReset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([]));
    h.supabase.store.reset();
    h.supabase.store.documents = [];
    h.supabase.store.document_chunks = [];
    h.supabase.store.organizations = [];
    h.supabase.store.organization_members = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock('@/lib/rag');
    if (savedMode === undefined) delete process.env[MODE];
    else process.env[MODE] = savedMode;
  });

  it('a non-member organizationId gets 403 JSON before any stream and no retrieval runs', async () => {
    h.supabase.store.organizations = [{ id: ORG, owner_id: OTHER_OWNER, settings: null }];
    const response = await post(await loadRoute({ mode: 'multi-tenant' }), { organizationId: ORG });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(h.runSpy).not.toHaveBeenCalled();
    expect(h.retrieval).not.toHaveBeenCalled();
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('a malformed organizationId gets 403 before any retrieval', async () => {
    const response = await post(await loadRoute({ mode: 'multi-tenant' }), { organizationId: 'not-a-uuid' });

    expect(response.status).toBe(403);
    expect(h.runSpy).not.toHaveBeenCalled();
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('a membership query error gets 503 JSON', async () => {
    const failing = () => ({
      from: (table: string) => {
        if (table === 'organization_members') throw new Error('membership unavailable');
        return h.supabase.client.from(table);
      },
    });
    const response = await post(await loadRoute({ mode: 'multi-tenant', adminClient: failing }), { organizationId: ORG });

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(h.runSpy).not.toHaveBeenCalled();
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('an organization owner without an organization_members row still gets a 200 and the org scope', async () => {
    h.supabase.store.organizations = [{ id: ORG, owner_id: FAKE_USER_ID, settings: null }];
    const response = await post(await loadRoute({ mode: 'multi-tenant' }), { organizationId: ORG, ragMode: 'flexible' });
    await readSse(response);

    expect(response.status).toBe(200);
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    const { scopeKey } = await import('@/lib/rag/tenant/scope');
    expect(scopeKey(h.runSpy.mock.calls[0][0].scope)).toBe(`o:${ORG}`);
    expect(h.supabase.store.organization_members).toEqual([{ organization_id: ORG, user_id: FAKE_USER_ID, role: 'owner' }]);
    expect(h.retrieval.mock.calls.every((call) => call[0] === 'match_documents_by_workspace')).toBe(true);
  });

  it('the repair does not admit a non-owner non-member and writes no membership row', async () => {
    h.supabase.store.organizations = [{ id: ORG, owner_id: OTHER_OWNER, settings: null }];
    const response = await post(await loadRoute({ mode: 'multi-tenant' }), { organizationId: ORG, ragMode: 'flexible' });

    expect(response.status).toBe(403);
    expect(h.supabase.store.organization_members).toEqual([]);
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('an existing member is admitted without any membership write', async () => {
    h.supabase.store.organizations = [{ id: ORG, owner_id: OTHER_OWNER, settings: null }];
    h.supabase.store.organization_members = [{ organization_id: ORG, user_id: FAKE_USER_ID, role: 'member' }];
    const response = await post(await loadRoute({ mode: 'multi-tenant' }), { organizationId: ORG, ragMode: 'flexible' });
    await readSse(response);

    expect(response.status).toBe(200);
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(h.supabase.store.organization_members).toHaveLength(1);
  });

  it('the workspace prompt override is read for the verified organization', async () => {
    h.supabase.store.organizations = [
      { id: ORG, owner_id: FAKE_USER_ID, settings: { systemPrompt: { enabled: true, useFullPrompt: true, fullPrompt: 'WORKSPACE-PROMPT {{context}}' } } },
    ];
    await readSse(await post(await loadRoute({ mode: 'multi-tenant' }), { organizationId: ORG, ragMode: 'flexible' }));

    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.capture.calls[0])).toContain('WORKSPACE-PROMPT');
  });

  it('a personal request never reads an organization settings row', async () => {
    h.supabase.store.organizations = [
      { id: ORG, owner_id: FAKE_USER_ID, settings: { systemPrompt: { enabled: true, useFullPrompt: true, fullPrompt: 'WORKSPACE-PROMPT {{context}}' } } },
    ];
    await readSse(await post(await loadRoute({ mode: 'multi-tenant' }), { organizationId: 'null', ragMode: 'flexible' }));

    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.capture.calls[0])).not.toContain('WORKSPACE-PROMPT');
    const organizationReads = (h.supabase.store.calls as Array<{ table?: string }>).filter((call) => call.table === 'organizations');
    expect(organizationReads).toHaveLength(0);
    const { scopeKey } = await import('@/lib/rag/tenant/scope');
    expect(scopeKey(h.runSpy.mock.calls[0][0].scope)).toBe(`u:${FAKE_USER_ID}`);
  });
});
