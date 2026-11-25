import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { detectLanguage } from '@/lib/rag/lang/detect';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { adminWithRpc } from '../helpers/pipeline-fakes';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { INTERNAL_API_KEY, startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

interface StoredRow extends Record<string, unknown> {
  tenant_key: string | null;
}

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const session: { userId: string | null } = { userId: null };
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    session,
    ssr: {
      auth: {
        getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }),
      },
    },
    tasks: [] as Array<() => Promise<void>>,
    stored: [] as StoredRow[],
    finishText: undefined as string | undefined,
  };
});

/** The generated column of 0532 (multi-tenant): o:<organization_id> for an organization row, u:<user_id> otherwise. */
function generatedTenantKey(row: Record<string, unknown>): string | null {
  if (typeof row.organization_id === 'string') return `o:${row.organization_id}`;
  if (typeof row.user_id === 'string') return `u:${row.user_id}`;
  return null;
}

function logClient() {
  const deleted: Array<[string, unknown]> = [];
  return {
    from(table: string) {
      if (table === 'rag_tenant_feedback_settings') {
        // No tenant row: the tenant inherits RAG_RETRIEVAL_LOG (05.1.1-08).
        const settings = {
          select: () => settings,
          eq: () => settings,
          abortSignal: () => settings,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return settings;
      }
      if (table !== 'rag_retrieval_log') throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          const stored: StoredRow = { ...row, id: crypto.randomUUID(), tenant_key: generatedTenantKey(row) };
          h.stored.push(stored);
          const chain = {
            select: () => chain,
            abortSignal: () => chain,
            single: async () => ({ data: { id: stored.id, tenant_key: stored.tenant_key }, error: null }),
          };
          return chain;
        },
        delete() {
          const chain = {
            eq: (column: string, value: unknown) => {
              deleted.push([column, value]);
              h.stored.splice(0, h.stored.length, ...h.stored.filter((row) => row[column] !== value));
              return chain;
            },
            abortSignal: async () => ({ data: null, error: null }),
          };
          return chain;
        },
      };
    },
  };
}

vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));

vi.mock('@/lib/rag/feedback-loop/retrieval-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/feedback-loop/retrieval-log')>();
  return {
    ...actual,
    writeRetrievalLog: (row: Parameters<typeof actual.writeRetrievalLog>[0], options: Parameters<typeof actual.writeRetrievalLog>[1]) =>
      actual.writeRetrievalLog(row, { ...options, client: logClient() as never }),
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, any>) => {
    const result = await h.capture.streamText(params);
    return {
      ...result,
      toUIMessageStream: (options?: Parameters<typeof result.toUIMessageStream>[0]) =>
        result.toUIMessageStream(options).pipeThrough(
          new TransformStream({
            async transform(chunk: { type?: string }, controller) {
              if (chunk.type === 'finish' && h.finishText !== undefined) await params.onFinish?.({ text: h.finishText });
              controller.enqueue(chunk);
            },
          }),
        ),
      toUIMessageStreamResponse: () => {
        if (h.finishText !== undefined) params.onFinish?.({ text: h.finishText });
        return new Response('model stream');
      },
    };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const { userA, userB, orgO } = TWO_TENANT_IDS;
const QUESTION = 'Two tenant isolation canary phrase: alpha personal notes bravo personal notes organization shared handbook';
const CHAT_ID = '55555555-5555-4555-8555-555555555555';
const ANSWER_EN = 'The notes describe the sample phrase and list the shared handbook entries for this workspace.';
const VOICE_SECRET = crypto.randomBytes(24).toString('hex');
const EVAL_SECRET = crypto.randomBytes(24).toString('hex');
const processEnv = process.env as Record<string, string | undefined>;

function configuredModelId(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  return models.map((model) => model.id).find((candidate) => !/gpt-4|o1|chatgpt/.test(candidate) && !candidate.includes('claude')) as string;
}

type Post = { POST: (request: NextRequest) => Promise<Response> };

describe('retrieval log rows from the chat, embed, voice and eval routes keep tenants apart (multi-tenant, ids)', () => {
  let fixture: RouteFixture;
  const model = configuredModelId();

  beforeAll(async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'multi-tenant',
      twoTenant: true,
      env: {
        RAG_RETRIEVAL_LOG: 'ids',
        RAG_VOICE_TOKEN_SECRET: VOICE_SECRET,
        RAG_EVAL_SECRET: EVAL_SECRET,
        RAG_EVAL_ENDPOINT_ENABLED: 'true',
        RAG_EVAL_ALLOWED_SCOPES: `user:${userA}`,
      },
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.session.userId = null;
    h.tasks.length = 0;
    h.stored.length = 0;
    h.finishText = ANSWER_EN;
    delete processEnv.RAG_EMBED_TENANT;
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(async () => {
    const deps = await import('@/lib/rag/deps');
    deps.resetRagDepsForTests();
    vi.restoreAllMocks();
  });

  async function drain(): Promise<StoredRow[]> {
    while (h.tasks.length > 0) await h.tasks.shift()!();
    return [...h.stored];
  }

  async function chat(userId: string, organizationId: string | null, chatId = CHAT_ID) {
    h.session.userId = userId;
    const { POST } = await fixture.loadRoute<Post>('chat');
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: QUESTION }],
        data: { ragMode: 'balanced', chatId, organizationId, settings: { webSearch: false, model } },
      }),
    );
    await response.text();
  }

  async function embed(tenant: string, headers: Record<string, string> = {}, afterLoad?: () => Promise<void>) {
    processEnv.RAG_EMBED_TENANT = tenant;
    const { POST } = await fixture.loadRoute<Post>('embed/chat');
    if (afterLoad) await afterLoad();
    const response = await POST(
      new NextRequest('http://localhost/api/embed/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers },
        body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }] }),
      }),
    );
    await response.text();
  }

  async function voice(scope: TenantScope) {
    const { POST } = await fixture.loadRoute<Post>('internal/voice-rag');
    const minted = mintVoiceToken({ scope, secret: VOICE_SECRET, ttlSeconds: 600 });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    const response = await POST(
      new NextRequest('http://localhost/api/internal/voice-rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': minted.token },
        body: JSON.stringify({ query: QUESTION, matchCount: 5 }),
      }),
    );
    return response;
  }

  function failingRpc() {
    const request = {
      abortSignal: () => request,
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: 'rpc down' } }).then(onFulfilled, onRejected),
    };
    return { rpc: () => request } as never;
  }

  it('chat as A, chat in organization O, embed for B and voice for A each give one row keyed by their own scope', async () => {
    const expected: string[] = [];

    await chat(userA, null);
    expected.push(scopeKey(mintScope('personal', userA, null)));
    await chat(userA, orgO);
    expected.push(scopeKey(mintScope('org', userA, orgO)));
    await embed(`u:${userB}`);
    expected.push(scopeKey(mintScope('personal', userB, null)));
    const voiceScope = mintScope('personal', userA, null);
    expect((await voice(voiceScope)).status).toBe(200);
    expected.push(scopeKey(voiceScope));

    const stored = await drain();
    expect(stored.map((row) => row.channel)).toEqual(['chat', 'chat', 'embed', 'voice']);
    expect(stored.map((row) => row.tenant_key)).toEqual(expected);
    expect(stored[0]).toMatchObject({ user_id: userA, organization_id: null, chat_id: CHAT_ID, outcome: 'answered', rag_mode: 'balanced' });
    expect(stored[1]).toMatchObject({ user_id: userA, organization_id: orgO, outcome: 'answered' });
    expect(stored[2]).toMatchObject({ user_id: userB, organization_id: null, rag_mode: 'balanced', outcome: 'answered' });
    expect(stored[3]).toMatchObject({ user_id: userA, organization_id: null, outcome: 'answered', answer_language: null });
    for (const [index, row] of stored.entries()) {
      for (const other of expected.filter((key) => key !== expected[index])) expect(JSON.stringify(row)).not.toContain(other);
    }
  });

  it('answer language: chat and embed rows carry the detected code, the voice row carries none', async () => {
    await chat(userA, null);
    await embed(`o:${orgO}`);
    await voice(mintScope('org', userA, orgO));
    const stored = await drain();
    expect(stored.map((row) => row.answer_language)).toEqual([detectLanguage(ANSWER_EN), detectLanguage(ANSWER_EN), null]);
    expect(stored.map((row) => row.tenant_key)).toEqual([`u:${userA}`, `o:${orgO}`, `o:${orgO}`]);
  });

  it.each([
    { header: 'it-IT,it;q=0.9', rendered: 'it' },
    { header: 'zh', rendered: 'zh' },
    { header: 'fr-FR', rendered: 'en' },
    { header: '<script>alert(1)</script>', rendered: 'en' },
  ])('an embed retrieval failure gives kb_unavailable in the rendered language $rendered for Accept-Language $header', async ({ header, rendered }) => {
    await embed(`u:${userB}`, { 'accept-language': header }, async () => {
      const deps = await import('@/lib/rag/deps');
      deps.setRagDepsForTests({ adminClient: adminWithRpc(failingRpc(), deps.getRagDeps().adminClient) });
    });
    const stored = await drain();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ channel: 'embed', outcome: 'kb_unavailable', answer_language: rendered, tenant_key: `u:${userB}` });
  });

  it('a voice retrieval failure gives kb_unavailable with no answer language', async () => {
    const { POST } = await fixture.loadRoute<Post>('internal/voice-rag');
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({ adminClient: adminWithRpc(failingRpc(), deps.getRagDeps().adminClient) });
    const minted = mintVoiceToken({ scope: mintScope('personal', userB, null), secret: VOICE_SECRET, ttlSeconds: 600 });
    if (!minted.ok) throw new Error('mint failed');
    const response = await POST(
      new NextRequest('http://localhost/api/internal/voice-rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': minted.token },
        body: JSON.stringify({ query: QUESTION, matchCount: 5 }),
      }),
    );
    expect(response.status).toBe(503);
    const stored = await drain();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ channel: 'voice', outcome: 'kb_unavailable', answer_language: null, tenant_key: `u:${userB}` });
  });

  it('a ghost chat and the eval route write no row', async () => {
    await chat(userA, null, 'ghost-abc');
    const { POST } = await fixture.loadRoute<Post>('internal/rag/run');
    const response = await POST(
      new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': EVAL_SECRET },
        body: JSON.stringify({ schema_version: 1, query: QUESTION, rag_mode: 'strict', item_id: 'en-test-001', options: { user_id: userA } }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await drain()).toHaveLength(0);
  });
});
