import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatImageContext, formatVideoContext } from '@/lib/rag/context/media';
import { fakeEmbedder, installDeps, uninstallDeps } from './helpers/pipeline-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const ORG_X = '00000000-0000-4000-8000-0000000000d1';

const state = vi.hoisted(() => {
  process.env.FAL_API_KEY = 'test-fal-key-placeholder';
  delete process.env.USE_OPENAI_IMAGE;
  delete process.env.USE_REPLICATE_PROVIDER;
  delete process.env.REPLICATE_API_TOKEN;
  return {
    mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
    user: null as { id: string } | null,
    imageInputs: [] as Array<{ prompt: string }>,
    videoInputs: [] as Array<{ prompt: string }>,
    rewriteMessages: [] as string[],
  };
});

vi.mock('@/lib/deployment-mode', () => ({
  getDeploymentMode: () => state.mode,
  isMultiTenant: () => state.mode === 'multi-tenant',
  isSingleTenant: () => state.mode === 'single-tenant',
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));

vi.mock('@supabase/supabase-js', () => {
  const storage = {
    listBuckets: async () => ({ data: [{ name: 'chat-videos' }, { name: 'chat-images' }], error: null }),
    createBucket: async () => ({ data: {}, error: null }),
    from: () => ({
      list: async () => ({ data: [], error: null }),
      upload: async () => ({ data: {}, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'http://storage.invalid/object' } }),
    }),
  };
  return { createClient: () => ({ storage }) };
});

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: () => undefined,
    subscribe: async (_model: string, options: { input: { prompt: string } }) => {
      state.imageInputs.push(options.input);
      return { data: { images: [] } };
    },
    queue: {
      submit: async (_model: string, options: { input: { prompt: string } }) => {
        state.videoInputs.push(options.input);
        throw new Error('provider stopped by test');
      },
    },
  },
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        create: async (args: { messages: Array<{ role: string; content: string }> }) => {
          state.rewriteMessages.push(args.messages[args.messages.length - 1].content);
          return { choices: [{ message: { content: 'rewritten prompt' } }] };
        },
      },
    };
  },
}));

const imageRoute = await import('@/app/api/generate-image/route');
const videoRoute = await import('@/app/api/generate-video/route');

interface OwnedRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: null;
  user_id: string | null;
  organization_id: string | null;
}

const ROWS: OwnedRow[] = [
  { id: 'c1', document_id: 'doc-a', content: 'ALPHA-ONLY plan costs 10 dollars', similarity: 0.9, metadata: null, user_id: USER_A, organization_id: null },
  { id: 'c2', document_id: 'doc-b', content: 'BRAVO-ONLY plan costs 20 dollars', similarity: 0.8, metadata: null, user_id: USER_B, organization_id: null },
  { id: 'c3', document_id: 'doc-o', content: 'ORG-ONLY plan costs 30 dollars', similarity: 0.7, metadata: null, user_id: USER_A, organization_id: ORG_O },
];

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeAdmin(options: { members?: Array<{ organization_id: string; user_id: string }>; rpcError?: boolean } = {}) {
  const calls: RpcCall[] = [];
  const members = options.members ?? [];
  const admin = {
    from() {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq(column: string, value: string) {
          filters[column] = value;
          return query;
        },
        abortSignal: () => query,
        maybeSingle() {
          const row = members.find((m) => m.organization_id === filters.organization_id && m.user_id === filters.user_id);
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      let data: unknown[];
      if (fn === 'match_document_chunks') {
        data = ROWS.map((row) => ({ chunk_id: row.id, document_id: row.document_id, content: row.content, similarity: row.similarity, metadata: null }));
      } else {
        data = ROWS.filter((row) =>
          args.p_org_id ? row.organization_id === args.p_org_id : row.user_id === args.p_user_id && row.organization_id === null,
        ).map((row) => ({ id: row.id, document_id: row.document_id, content: row.content, similarity: row.similarity, metadata: null }));
      }
      const response = options.rpcError ? { data: null, error: { message: 'boom', code: '57P01' } } : { data, error: null };
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { admin, calls };
}

function install(options: Parameters<typeof makeAdmin>[0] = {}) {
  const fake = makeAdmin(options);
  installDeps({ adminClient: () => fake.admin as never, embedder: fakeEmbedder().embedder });
  return fake;
}

function post(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const imagePost = (body: Record<string, unknown>) => imageRoute.POST(post('/api/generate-image', body));
const videoPost = (body: Record<string, unknown>) => videoRoute.POST(post('/api/generate-video', body));

function imagePromptFor(context: string, prompt: string): string {
  return `IMPORTANT: Use the exact information from this document context when creating the image. Include actual product names, prices, and features mentioned below:

---
Document Context:
${context}
---

Now create this image: ${prompt}

Remember: Use the exact prices, product names, and details from the context above - do not make up numbers.`;
}

beforeEach(() => {
  uninstallDeps();
  state.mode = 'single-tenant';
  state.user = { id: USER_A };
  state.imageInputs.length = 0;
  state.videoInputs.length = 0;
  state.rewriteMessages.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('generate-image', () => {
  test('single-tenant: the provider prompt carries exactly the context the old inline code built', async () => {
    const fake = install();
    const response = await imagePost({ prompt: 'a poster of our plans', useContext: true });
    expect(response.status).toBe(200);
    const oldRows = ROWS.map((row) => ({ document_id: row.document_id, content: row.content, similarity: row.similarity }));
    expect(state.imageInputs).toHaveLength(1);
    expect(state.imageInputs[0].prompt).toBe(imagePromptFor(formatImageContext(oldRows), 'a poster of our plans'));
    expect(fake.calls).toEqual([
      { fn: 'match_document_chunks', args: { query_embedding: [0.1, 0.2, 0.3], match_count: 10, similarity_threshold: 0.3 } },
    ]);
    expect((await response.json()).rag_status).toBe('ok');
  });

  test('multi-tenant: a user only gets their own workspace context and never the single-tenant RPC', async () => {
    state.mode = 'multi-tenant';
    state.user = { id: USER_A };
    const fake = install();
    await imagePost({ prompt: 'a poster of our plans', useContext: true });
    const prompt = state.imageInputs[0].prompt;
    expect(prompt).toContain('ALPHA-ONLY');
    expect(prompt).not.toContain('BRAVO-ONLY');
    expect(prompt).not.toContain('ORG-ONLY');
    expect(fake.calls.map((call) => call.fn)).toEqual(['match_documents_by_workspace']);
    expect(fake.calls[0].args).toMatchObject({ p_org_id: null, p_user_id: USER_A });
  });

  test('multi-tenant: the other user gets only their phrase', async () => {
    state.mode = 'multi-tenant';
    state.user = { id: USER_B };
    install();
    await imagePost({ prompt: 'a poster of our plans', useContext: true });
    expect(state.imageInputs[0].prompt).toContain('BRAVO-ONLY');
    expect(state.imageInputs[0].prompt).not.toContain('ALPHA-ONLY');
  });

  test('multi-tenant member of an organization searches that organization', async () => {
    state.mode = 'multi-tenant';
    state.user = { id: USER_A };
    const fake = install({ members: [{ organization_id: ORG_O, user_id: USER_A }] });
    await imagePost({ prompt: 'a poster of our plans', useContext: true, organizationId: ORG_O });
    expect(state.imageInputs[0].prompt).toContain('ORG-ONLY');
    expect(state.imageInputs[0].prompt).not.toContain('ALPHA-ONLY');
    expect(fake.calls[0].args).toMatchObject({ p_org_id: ORG_O });
  });

  test('multi-tenant without a session: 401 before any retrieval or generation', async () => {
    state.mode = 'multi-tenant';
    state.user = null;
    const fake = install();
    const response = await imagePost({ prompt: 'a poster of our plans', useContext: true });
    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
    expect(state.imageInputs).toEqual([]);
  });

  test('a non-member organizationId gets 403 before any generation or retrieval', async () => {
    state.mode = 'multi-tenant';
    state.user = { id: USER_A };
    const fake = install({ members: [{ organization_id: ORG_O, user_id: USER_A }] });
    const response = await imagePost({ prompt: 'a poster of our plans', useContext: true, organizationId: ORG_X });
    expect(response.status).toBe(403);
    expect(state.imageInputs).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test('a retrieval error is logged under [Document Search] and generation continues without context', async () => {
    install({ rpcError: true });
    const response = await imagePost({ prompt: 'a poster of our plans', useContext: true });
    expect(response.status).toBe(200);
    expect(state.imageInputs[0].prompt).toBe('a poster of our plans');
    expect((await response.json()).rag_status).toBe('error');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Document Search]'), expect.objectContaining({ status: 'error' }));
  });

  test('without useContext nothing is retrieved and rag_status is absent', async () => {
    const fake = install();
    const response = await imagePost({ prompt: 'a poster of our plans' });
    expect(fake.calls).toEqual([]);
    expect(state.imageInputs[0].prompt).toBe('a poster of our plans');
    expect((await response.json()).rag_status).toBeUndefined();
  });
});

describe('generate-video', () => {
  test('single-tenant: the rewrite receives exactly the context the old inline code built', async () => {
    const fake = install();
    await videoPost({ prompt: 'a video about our plans', useContext: true });
    const oldRows = ROWS.map((row) => ({ document_id: row.document_id, content: row.content, similarity: row.similarity }));
    expect(state.rewriteMessages).toHaveLength(1);
    expect(state.rewriteMessages[0]).toContain(`Knowledge base context with accurate information:\n${formatVideoContext(oldRows)}\n`);
    expect(state.videoInputs[0].prompt).toBe('rewritten prompt');
    expect(fake.calls).toEqual([
      { fn: 'match_document_chunks', args: { query_embedding: [0.1, 0.2, 0.3], match_count: 10, similarity_threshold: 0.3 } },
    ]);
  });

  test('multi-tenant: only the caller workspace reaches the rewrite', async () => {
    state.mode = 'multi-tenant';
    state.user = { id: USER_B };
    const fake = install();
    await videoPost({ prompt: 'a video about our plans', useContext: true });
    expect(state.rewriteMessages[0]).toContain('BRAVO-ONLY');
    expect(state.rewriteMessages[0]).not.toContain('ALPHA-ONLY');
    expect(fake.calls.map((call) => call.fn)).toEqual(['match_documents_by_workspace']);
  });

  test('multi-tenant without a session: 401 before any retrieval or generation', async () => {
    state.mode = 'multi-tenant';
    state.user = null;
    const fake = install();
    const response = await videoPost({ prompt: 'a video about our plans', useContext: true });
    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
    expect(state.rewriteMessages).toEqual([]);
    expect(state.videoInputs).toEqual([]);
  });

  test('a non-member organizationId gets 403 before any generation', async () => {
    state.mode = 'multi-tenant';
    state.user = { id: USER_A };
    const fake = install({ members: [] });
    const response = await videoPost({ prompt: 'a video about our plans', useContext: true, organizationId: ORG_O });
    expect(response.status).toBe(403);
    expect(state.videoInputs).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test('a retrieval error is logged under [Document Search] and the original prompt is used', async () => {
    install({ rpcError: true });
    await videoPost({ prompt: 'a video about our plans', useContext: true });
    expect(state.rewriteMessages).toEqual([]);
    expect(state.videoInputs[0].prompt).toBe('a video about our plans');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Document Search]'), expect.objectContaining({ status: 'error' }));
  });
});
