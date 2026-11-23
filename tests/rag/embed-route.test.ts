import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { TraceCollector } from '@/lib/rag';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { startRouteFixture, systemTextOf, type RouteFixture } from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { capture: fakes.createStreamTextCapture() };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => ({
    ...(await h.capture.streamText(params)),
    toUIMessageStreamResponse: () => new Response('model stream'),
  }),
}));
const traced = vi.hoisted(() => ({ finished: [] as TraceCollector[] }));
vi.mock('@/lib/rag/trace/finish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/finish')>();
  return {
    ...actual,
    finishTrace: (...args: Parameters<typeof actual.finishTrace>) => {
      traced.finished.push(args[0]);
      return actual.finishTrace(...args);
    },
  };
});
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));

const { userA, orgO } = TWO_TENANT_IDS;
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c9';

const PHRASE_A = 'alpha personal notes';
const PHRASE_B = 'bravo personal notes';
const PHRASE_O = 'organization shared handbook';
const ALL_PHRASES_QUESTION = `Two tenant isolation canary phrase: ${PHRASE_A} ${PHRASE_B} ${PHRASE_O}`;
const UNAVAILABLE_EN = 'The knowledge base is temporarily unavailable. Please try again in a moment.';

const env = process.env as Record<string, string | undefined>;

function embedRequest(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: ALL_PHRASES_QUESTION }], ...extra }),
  });
}

function errorTextOf(body: string): string | null {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const part = JSON.parse(payload) as { type?: string; errorText?: string };
      if (part.type === 'error' && typeof part.errorText === 'string') return part.errorText;
    } catch {
      continue;
    }
  }
  return null;
}

describe('embed route tenant and status handling', () => {
  let fixture: RouteFixture;
  let savedTenant: string | undefined;

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'multi-tenant', twoTenant: true });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.capture.reset();
    savedTenant = env.RAG_EMBED_TENANT;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (savedTenant === undefined) delete env.RAG_EMBED_TENANT;
    else env.RAG_EMBED_TENANT = savedTenant;
    const deps = await import('@/lib/rag/deps');
    deps.resetRagDepsForTests();
    vi.restoreAllMocks();
  });

  async function post(request: NextRequest, tenant: string | undefined, afterLoad?: () => Promise<void>) {
    if (tenant === undefined) delete env.RAG_EMBED_TENANT;
    else env.RAG_EMBED_TENANT = tenant;
    const { POST } = await fixture.loadRoute('embed/chat');
    if (afterLoad) await afterLoad();
    return POST(request);
  }

  it.each([
    ['organizationId', { organizationId: OTHER_ORG }],
    ['workspaceId', { workspaceId: OTHER_ORG }],
    ['tenant', { tenant: `o:${OTHER_ORG}` }],
    ['personal id as organizationId', { organizationId: userA }],
  ])('a body naming a different workspace (%s) gets 403 JSON before any search', async (_label, extra) => {
    const callsBefore = fixture.edge.calls.length;
    const response = await post(embedRequest(extra), `o:${orgO}`);

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const text = await response.text();
    for (const phrase of [PHRASE_A, PHRASE_B, PHRASE_O]) expect(text).not.toContain(phrase);
    expect(h.capture.calls).toHaveLength(0);
    expect(fixture.edge.calls.slice(callsBefore).filter((call) => call.path.includes('/rpc/'))).toHaveLength(0);
  });

  it('a body naming the configured workspace is accepted and answered from that workspace only', async () => {
    const response = await post(embedRequest({ organizationId: orgO, tenant: `O:${orgO}` }), `o:${orgO}`);
    await response.text();

    expect(response.status).toBe(200);
    expect(h.capture.calls).toHaveLength(1);
    const system = systemTextOf(h.capture.calls[0]);
    expect(system).toContain(PHRASE_O);
    expect(system).not.toContain(PHRASE_A);
    expect(system).not.toContain(PHRASE_B);
  });

  it('finishes the trace only after the model stream ends and records the final answer on it', async () => {
    traced.finished.length = 0;
    const response = await post(embedRequest(), `o:${orgO}`);
    await response.text();

    expect(h.capture.calls).toHaveLength(1);
    expect(traced.finished).toHaveLength(0);
    await (h.capture.calls[0].onFinish as (event: { text: string }) => void)({ text: 'final embed answer' });

    expect(traced.finished).toHaveLength(1);
    const review = traced.finished[0].reviewContent();
    expect(review?.answer).toBe('final embed answer');
    expect(review?.query).toBe(ALL_PHRASES_QUESTION);
    expect(review?.context).toContain(PHRASE_O);
    expect(traced.finished[0].traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the configured organization decides the tenant when the body names none', async () => {
    const response = await post(embedRequest(), `o:${orgO}`);
    await response.text();

    expect(h.capture.calls).toHaveLength(1);
    const system = systemTextOf(h.capture.calls[0]);
    expect(system).toContain(PHRASE_O);
    expect(system).not.toContain(PHRASE_A);
    expect(system).not.toContain(PHRASE_B);
  });

  it('a configured personal workspace sees only that user and never the organization or another user', async () => {
    const response = await post(embedRequest(), `u:${userA}`);
    await response.text();

    expect(h.capture.calls).toHaveLength(1);
    const system = systemTextOf(h.capture.calls[0]);
    expect(system).toContain(PHRASE_A);
    expect(system).not.toContain(PHRASE_B);
    expect(system).not.toContain(PHRASE_O);
  });

  it('multi-tenant with RAG_EMBED_TENANT unset streams the unavailable error and runs no search', async () => {
    const callsBefore = fixture.edge.calls.length;
    const response = await post(embedRequest(), undefined);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(errorTextOf(body)).toBe(UNAVAILABLE_EN);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(h.capture.calls).toHaveLength(0);
    expect(fixture.edge.calls.slice(callsBefore)).toHaveLength(0);
  });

  it('the unavailable message follows the request language', async () => {
    const response = await post(embedRequest({}, { 'accept-language': 'es-ES,es;q=0.9' }), undefined);
    const body = await response.text();

    expect(errorTextOf(body)).toBe('La base de conocimiento no está disponible temporalmente. Inténtalo de nuevo en un momento.');
  });

  it('an unknown configured organization streams the unavailable error without leaking the reason', async () => {
    const response = await post(embedRequest(), `o:${OTHER_ORG}`);
    const body = await response.text();

    expect(errorTextOf(body)).toBe(UNAVAILABLE_EN);
    expect(body).not.toContain('embed_tenant_unknown');
    expect(h.capture.calls).toHaveLength(0);
  });

  it('a retrieval backend failure streams the unavailable error and never reaches the model', async () => {
    const failing = () => {
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: 'rpc down' } }).then(onFulfilled, onRejected),
      };
      return { rpc: () => request } as never;
    };
    const response = await post(embedRequest(), `u:${userA}`, async () => {
      const deps = await import('@/lib/rag/deps');
      deps.setRagDepsForTests({ anonClient: failing });
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(errorTextOf(body)).toBe(UNAVAILABLE_EN);
    expect(body).not.toContain('rpc down');
    expect(h.capture.calls).toHaveLength(0);
  });
});
