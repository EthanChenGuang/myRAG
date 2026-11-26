import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { chatRequest, installChatPipeline, readSse } from '../helpers/chat-route-fakes';
import { systemTextOf } from '../helpers/route-fixture';
import { identifierSuggestionMessage, knowledgeBaseUnavailableMessage, noKnowledgeBaseResponse } from '@/lib/rag/generation/messages';

const SECRET = 'b'.repeat(48);
const env = process.env as Record<string, string | undefined>;
const ENV_NAMES = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'NEXT_PUBLIC_EMBED_ENABLED'] as const;

const ASKED = 'QX-4417';
const SUGGESTIONS = ['QX-4471', 'QX-4416'];
const NEAR_MISS_TEXT = 'Synthetic passage that names QX-4471 and nothing else.';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runSpy: vi.fn(), next: { result: null as unknown } };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => {
    const result = await h.capture.streamText(params);
    return { ...result, toUIMessageStreamResponse: () => new Response('model stream') };
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

const QUERY_CONTEXT = {
  isTemporalQuery: false,
  isFinancialQuery: false,
  isSpecificDataQuery: false,
  requiredPrecision: 'low' as const,
  suggestedThreshold: 0.3,
  reasoningText: 'stub',
  financialMetrics: [],
  searchStrategy: 'semantic_only' as const,
};

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'empty' as const,
    reason: 'identifier_not_found',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: true,
    stages: [
      { name: 'identifier_resolve', status: 'ok', startedAt: 0, endedAt: 1, latency_ms: 1, candidates_in: 0, candidates_out: 0, rules: [], detail: 'asked=1 found=0 filtered=true', counts: { asked: 1, found: 0, missing: 1, suggestions: 2 } },
    ],
    traceId: 'trace-stub',
    queryContext: QUERY_CONTEXT,
    retrievalConfigHash: 'e'.repeat(64),
    queryLanguage: 'en',
    refusal: null,
    identifierFilter: { asked: 1, resolved: 0, fallback: false, nearMissDropped: 1 },
    identifierSuggestions: [...SUGGESTIONS],
    ...overrides,
  };
}

async function loadRoute<T>(path: string, options: { embedScope?: boolean } = {}): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    return {
      ...actual,
      runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
        h.runSpy(input);
        return Promise.resolve(h.next.result);
      },
      ...(options.embedScope
        ? { resolveEmbedScope: async () => ({ ok: true as const, scope: mintScope('single', null, null) }) }
        : {}),
    };
  });
  await installChatPipeline(h);
  return (await import(path)) as T;
}

type Post = (request: NextRequest) => Promise<Response>;

function textOf(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim()) as { type?: string; delta?: string };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text += chunk.delta;
    } catch {
      continue;
    }
  }
  return text;
}

function ask(ragMode: string, language = 'en', webSearch = false) {
  return chatRequest({
    messages: [{ role: 'user', content: `What does entry ${ASKED} say?` }],
    data: { ragMode, settings: { webSearch, language } },
  });
}

describe('identifier not found in the routes (04.2-36, D-31, D-51)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    h.capture.reset();
    h.runSpy.mockReset();
    h.next.result = baseResult();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.resetModules();
  });

  it.each(['en', 'es', 'zh', 'it'])('chat strict (%s): the refusal text followed by the suggestion sentence, no model call', async (language) => {
    const { POST } = await loadRoute<{ POST: Post }>('@/app/api/chat/route');
    const body = await readSse(await POST(ask('strict', language)));
    const expected = `${noKnowledgeBaseResponse(language)}\n\n${identifierSuggestionMessage(language, SUGGESTIONS)}`;
    expect(textOf(body)).toBe(expected);
    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(body).not.toContain('"type":"source');
  });

  it('chat strict: identifier_not_found without suggestions streams only the existing text', async () => {
    h.next.result = baseResult({ identifierSuggestions: [] });
    const { POST } = await loadRoute<{ POST: Post }>('@/app/api/chat/route');
    const body = await readSse(await POST(ask('strict')));
    expect(textOf(body)).toBe(noKnowledgeBaseResponse('en'));
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('chat strict: another empty reason never appends suggestions', async () => {
    h.next.result = baseResult({ reason: 'no_relevant_context' });
    const { POST } = await loadRoute<{ POST: Post }>('@/app/api/chat/route');
    const body = await readSse(await POST(ask('strict')));
    expect(textOf(body)).toBe(noKnowledgeBaseResponse('en'));
  });

  it('chat strict: a knowledge-base failure is reported as unavailable, never as not found', async () => {
    h.next.result = baseResult({ status: 'error', reason: 'backend_error' });
    const { POST } = await loadRoute<{ POST: Post }>('@/app/api/chat/route');
    const body = await readSse(await POST(ask('strict')));
    expect(body).toContain(knowledgeBaseUnavailableMessage('en'));
    expect(body).not.toContain('Information Not Available');
    expect(body).not.toContain(SUGGESTIONS[0]);
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('chat strict with web search on calls the model as before', async () => {
    const { POST } = await loadRoute<{ POST: Post }>('@/app/api/chat/route');
    const body = await readSse(await POST(ask('strict', 'en', true)));
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).toHaveBeenCalled();
  });

  it.each(['balanced', 'flexible'])('chat %s: the model is called with the suggestion line and no near-miss chunk', async (ragMode) => {
    const line = identifierSuggestionMessage('en', SUGGESTIONS);
    h.next.result = baseResult({ reason: 'no_relevant_context', refusalCandidate: false, context: line });
    const { POST } = await loadRoute<{ POST: Post }>('@/app/api/chat/route');
    await readSse(await POST(ask(ragMode)));
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    const system = systemTextOf(h.capture.calls[0]);
    expect(system).toContain(line);
    expect(system).not.toContain(NEAR_MISS_TEXT);
    expect(system).not.toContain('Information Not Available');
  });

  it('embed: the suggestion line reaches the model; no suggestions leaves the prompt unchanged', async () => {
    const line = identifierSuggestionMessage('en', SUGGESTIONS);
    const embedRequest = () =>
      new NextRequest('http://localhost/api/embed/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
        body: JSON.stringify({ messages: [{ role: 'user', content: `What does entry ${ASKED} say?` }] }),
      });
    h.next.result = baseResult({ reason: 'no_relevant_context', refusalCandidate: false, context: line });
    const { POST } = await loadRoute<{ POST: Post }>('@/app/api/embed/chat/route', { embedScope: true });
    await (await POST(embedRequest())).text();
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(systemTextOf(h.capture.calls[0])).toContain(line);

    h.capture.reset();
    h.next.result = baseResult({ reason: 'no_relevant_context', refusalCandidate: false, identifierSuggestions: [] });
    await (await POST(embedRequest())).text();
    expect(systemTextOf(h.capture.calls[0])).not.toContain(SUGGESTIONS[0]);
  });

  it('eval: the trace carries identifier_not_found and the identifier block', async () => {
    h.next.result = baseResult({ identifierSuggestions: ['QX-4471', 'QX-4416', 'QX-4407', 'QX-4400'] });
    const route = await loadRoute<{ POST: Post }>('@/app/api/internal/rag/run/route');
    const response = await route.POST(
      new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
        body: JSON.stringify({ schema_version: 1, query: `What does entry ${ASKED} say?`, rag_mode: 'strict' }),
      }),
    );
    expect(response.status).toBe(200);
    const trace = (await response.json()) as Record<string, any>;
    expect(trace.refused).toBe(true);
    expect(trace.refusal_reason).toBe('identifier_not_found');
    expect(trace.identifier).toEqual({
      asked: 1,
      resolved: 0,
      near_miss_dropped: 1,
      fallback: false,
      suggestions: ['QX-4471', 'QX-4416', 'QX-4407'],
    });
  });

  it('eval: no identifier block while the filter did not run', async () => {
    h.next.result = baseResult({ reason: 'no_relevant_context', identifierFilter: undefined, identifierSuggestions: undefined });
    const route = await loadRoute<{ POST: Post }>('@/app/api/internal/rag/run/route');
    const response = await route.POST(
      new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
        body: JSON.stringify({ schema_version: 1, query: 'A neutral question.', rag_mode: 'strict' }),
      }),
    );
    const trace = (await response.json()) as Record<string, any>;
    expect(trace.refusal_reason).toBe('no_relevant_context');
    expect(trace).not.toHaveProperty('identifier');
  });

  it('@/lib/rag exports the suggestion message and the reason constant', async () => {
    const barrel = (await vi.importActual('@/lib/rag')) as Record<string, unknown>;
    expect(typeof barrel.identifierSuggestionMessage).toBe('function');
    expect(barrel.IDENTIFIER_NOT_FOUND).toBe('identifier_not_found');
  });
});
