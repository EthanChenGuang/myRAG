import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { buildHistoryWindow } from '@/lib/rag/query/history';
import type { RunRetrievalInput } from '@/lib/rag/types';
import { emptyRetrieval, installChatPipeline } from '../helpers/chat-route-fakes';
import { systemTextOf } from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

const spies = vi.hoisted(() => ({
  classifyQuery: vi.fn(),
  runRetrieval: vi.fn(),
}));

vi.mock('@/lib/query-classifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/query-classifier')>();
  spies.classifyQuery.mockImplementation(actual.classifyQuery);
  return { ...actual, classifyQuery: spies.classifyQuery };
});
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => ({
    ...(await h.capture.streamText(params)),
    toUIMessageStreamResponse: () => new Response('model stream'),
  }),
}));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));

const LAYER_ON = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true' };
const NEW_FIELDS = ['history', 'classification', 'timeZone'];
const PROCESS_ENV: Record<string, string> = {
  NEXT_PUBLIC_EMBED_ENABLED: 'true',
  NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS: '*',
  NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
  EMBED_RATE_LIMIT: '100000',
};

const PRIOR_TURNS = [
  { role: 'user', content: 'Which option controls the export format?' },
  { role: 'assistant', content: 'It is set in the settings panel 【S2】.\n\n### Sources\n- manual.pdf' },
];

const env = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};

async function loadRoute(ragEnv?: Record<string, string>) {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    spies.runRetrieval.mockImplementation(actual.runRetrieval);
    return { ...actual, runRetrieval: spies.runRetrieval };
  });
  await installChatPipeline(h);
  if (ragEnv) {
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({ ragEnv: () => ragEnv });
    const startup = await import('@/lib/rag/v2/startup');
    await startup.verifyV2Startup();
  }
  return import('@/app/api/embed/chat/route');
}

function embedRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
    body: JSON.stringify(body),
  });
}

function retrievalInput(): RunRetrievalInput {
  return spies.runRetrieval.mock.calls[0][0] as RunRetrievalInput;
}

describe('embed route query-layer inputs (D-09, D-10, D-11, D-16)', () => {
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
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(emptyRetrieval());
    spies.classifyQuery.mockClear();
    spies.runRetrieval.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('layer on: classifies once and passes the classification, the history window and the time zone', async () => {
    const { POST } = await loadRoute(LAYER_ON);
    const messages = [...PRIOR_TURNS, { role: 'user', content: '你好' }];
    const response = await POST(embedRequest({ messages, timeZone: 'Asia/Shanghai' }));
    await response.text();

    expect(spies.classifyQuery).toHaveBeenCalledTimes(1);
    expect(spies.runRetrieval).toHaveBeenCalledTimes(1);
    const input = retrievalInput();
    expect(input.classification).toBe(spies.classifyQuery.mock.results[0].value);
    expect(input.history).toEqual(buildHistoryWindow(messages));
    expect(input.history).toEqual([
      { role: 'user', content: 'Which option controls the export format?' },
      { role: 'assistant', content: 'It is set in the settings panel.' },
    ]);
    expect(input.timeZone).toBe('Asia/Shanghai');
  });

  it('layer on: small talk is answered without knowledge-base context and without a refusal', async () => {
    const { POST } = await loadRoute(LAYER_ON);
    const response = await POST(embedRequest({ messages: [{ role: 'user', content: '你好' }] }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe('model stream');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    const system = systemTextOf(h.capture.streamText.mock.calls[0][0] as Record<string, unknown>);
    expect(system).not.toContain('Context from knowledge base');
    expect(system).not.toContain('{{context}}');
    expect(system).not.toMatch(/Context:\s*$/u);
    const searchCalls = h.retrieval.mock.calls.map((call) => call[0]).filter((fn) => fn !== 'rag_chunking_coverage' && fn !== 'rag_tenant_language_shares');
    expect(searchCalls).toEqual([]);
  });

  it('layer on: rejects a time zone longer than 64 characters with the structured 400', async () => {
    const { POST } = await loadRoute(LAYER_ON);
    for (const timeZone of ['x'.repeat(65), 7]) {
      const response = await POST(embedRequest({ messages: [{ role: 'user', content: '你好' }], timeZone }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { success: boolean; error: string; details: Array<{ path: string }> };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Invalid request data');
      expect(body.details.map((detail) => detail.path)).toEqual(['timeZone']);
    }
    expect(spies.runRetrieval).not.toHaveBeenCalled();

    const ok = await POST(embedRequest({ messages: [{ role: 'user', content: '你好' }], timeZone: 'x'.repeat(64) }));
    expect(ok.status).toBe(200);
    expect(retrievalInput().timeZone).toBe('x'.repeat(64));
  });

  it('layer off: does not classify and keeps today\'s runRetrieval input', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      embedRequest({
        messages: [...PRIOR_TURNS, { role: 'user', content: 'Which option controls the import format?' }],
        timeZone: 'x'.repeat(80),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();

    expect(spies.classifyQuery).not.toHaveBeenCalled();
    const input = retrievalInput() as unknown as Record<string, unknown>;
    for (const field of NEW_FIELDS) expect(input).not.toHaveProperty(field);
    expect(Object.keys(input).sort()).toEqual(['options', 'profile', 'query', 'scope', 'signal', 'trace']);
    expect(input.query).toBe('Which option controls the import format?');
    expect(input.profile).toBe('embed');
    expect(input.options).toEqual({
      maxResults: 25,
      fallbackToLowerThreshold: true,
      isGPTModel: true,
      ragMode: 'balanced',
      webSearchEnabled: false,
    });
  });
});
