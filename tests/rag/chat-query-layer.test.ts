import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRelativeDates } from '@/lib/rag/query/dates';
import { buildHistoryWindow } from '@/lib/rag/query/history';
import type { RunRetrievalInput } from '@/lib/rag/types';
import { chatRequest, emptyRetrieval, installChatPipeline, readSse } from '../helpers/chat-route-fakes';
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
  streamText: h.capture.streamText,
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

const LAYER_ON = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true' };
const NEW_FIELDS = ['history', 'classification', 'timeZone'] as const;

const PRIOR_TURNS = [
  { role: 'user', content: 'Which option controls the export format?' },
  { role: 'assistant', content: 'The export format is set in the settings panel [S1].\n\nSources:\n- manual.pdf' },
];

async function loadRoute(ragEnv?: Record<string, string>) {
  vi.resetModules();
  // A vi.mock factory result survives resetModules, so the spy is re-registered per load to bind fresh rag deps
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
  return import('@/app/api/chat/route');
}

function retrievalInput(call = 0): RunRetrievalInput {
  return spies.runRetrieval.mock.calls[call][0] as RunRetrievalInput;
}

describe('chat route query-layer inputs (D-09, D-11, D-16)', () => {
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

  it('layer on: classifies once and passes that classification, the history window and the time zone', async () => {
    const { POST } = await loadRoute(LAYER_ON);
    const messages = [...PRIOR_TURNS, { role: 'user', content: '你好' }];
    const response = await POST(
      chatRequest({ messages, timeZone: 'Europe/Rome', data: { ragMode: 'strict', settings: { webSearch: false } } }),
    );
    await readSse(response);

    expect(spies.classifyQuery).toHaveBeenCalledTimes(1);
    expect(spies.runRetrieval).toHaveBeenCalledTimes(1);
    const input = retrievalInput();
    expect(input.classification).toBe(spies.classifyQuery.mock.results[0].value);
    expect(input.history).toEqual(buildHistoryWindow(messages));
    expect(input.history).toEqual([
      { role: 'user', content: 'Which option controls the export format?' },
      { role: 'assistant', content: 'The export format is set in the settings panel.' },
    ]);
    expect(input.timeZone).toBe('Europe/Rome');
  });

  it('passes an invalid time zone through without a 400; the pipeline resolves it to UTC', async () => {
    const { POST } = await loadRoute(LAYER_ON);
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: '你好' }],
        timeZone: 'Not/A_Zone',
        data: { ragMode: 'strict', settings: { webSearch: false } },
      }),
    );
    expect(response.status).toBe(200);
    await readSse(response);
    expect(retrievalInput().timeZone).toBe('Not/A_Zone');
    expect(normalizeRelativeDates('yesterday', { now: new Date('2026-01-15T12:00:00Z'), timeZone: 'Not/A_Zone' }).timeZone).toBe('UTC');
  });

  it('drops an oversized or non-string time zone instead of passing it on', async () => {
    const { POST } = await loadRoute(LAYER_ON);
    for (const timeZone of ['x'.repeat(65), 42]) {
      spies.runRetrieval.mockClear();
      const response = await POST(
        chatRequest({ messages: [{ role: 'user', content: '你好' }], timeZone, data: { ragMode: 'balanced' } }),
      );
      expect(response.status).toBe(200);
      await readSse(response);
      expect(retrievalInput().timeZone).toBeUndefined();
    }
  });

  it('layer on: small talk is answered conversationally without context and without the strict refusal', async () => {
    const { POST } = await loadRoute(LAYER_ON);
    const response = await POST(
      chatRequest({ messages: [{ role: 'user', content: '你好' }], data: { ragMode: 'strict', settings: { webSearch: false } } }),
    );
    const body = await readSse(response);

    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    const system = systemTextOf(h.capture.streamText.mock.calls[0][0] as Record<string, unknown>);
    expect(system).not.toContain('Context from knowledge base');
    expect(system).not.toContain('No relevant context found');
    expect(system).not.toContain('{{context}}');
    const searchCalls = h.retrieval.mock.calls.map((call) => call[0]).filter((fn) => fn !== 'rag_chunking_coverage');
    expect(searchCalls).toEqual([]);
  });

  it('layer off: the same small-talk input keeps today\'s strict refusal', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      chatRequest({ messages: [{ role: 'user', content: '你好' }], data: { ragMode: 'strict', settings: { webSearch: false } } }),
    );
    const body = await readSse(response);

    expect(body).toContain('Information Not Available');
    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(spies.classifyQuery).toHaveBeenCalledTimes(1);
  });

  it('layer off: the runRetrieval input equals today\'s apart from the new optional fields', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      chatRequest({
        messages: [...PRIOR_TURNS, { role: 'user', content: 'Which option controls the import format?' }],
        timeZone: 'Europe/Rome',
        data: { ragMode: 'balanced', settings: { webSearch: false } },
      }),
    );
    await readSse(response);

    const input = retrievalInput() as unknown as Record<string, unknown>;
    const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !(NEW_FIELDS as readonly string[]).includes(key)));
    expect(Object.keys(rest).sort()).toEqual(['documentRefs', 'options', 'profile', 'query', 'scope', 'signal', 'trace']);
    expect(rest.query).toBe('Which option controls the import format?');
    expect(rest.profile).toBe('chat');
    expect(rest.documentRefs).toEqual({ mentions: [], documentParts: [] });
    expect(rest.options).toEqual({
      maxResults: 25,
      fallbackToLowerThreshold: true,
      isGPTModel: true,
      ragMode: 'balanced',
      webSearchEnabled: false,
    });
  });
});
