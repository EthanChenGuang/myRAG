import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fromDBMessages,
  fromUIMessage,
  toDBMessages,
  toMessage,
  type ContentPart,
  type DBMessage,
  type ExtendedMessage,
} from '@/types/chat';
import type { TraceCollector } from '@/lib/rag';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from './helpers/chat-route-fakes';

const h = await vi.hoisted(async () => {
  const fakes = await import('./helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), finished: [] as TraceCollector[] };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/rag/trace/finish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/finish')>();
  return {
    ...actual,
    finishTrace: (...args: Parameters<typeof actual.finishTrace>) => {
      h.finished.push(args[0]);
      return actual.finishTrace(...args);
    },
  };
});
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
vi.mock('@/lib/thinking-rag-enhancer', () => ({
  enhanceQueryWithReasoning: vi.fn(),
  intelligentSearch: vi.fn(),
  shouldUseEnhancedRAG: () => true,
}));

const TRACE_ID = /^[0-9a-f]{32}$/;
const FINAL_ANSWER = 'The handbook says refunds are accepted within 30 days.';

const SOURCE_IMAGES = [
  { name: 'diagram.png', size: 0, type: 'image/jpeg', url: 'https://example.com/fixtures/diagram.png' },
  { name: 'chart.png', size: 0, type: 'image/jpeg', url: 'https://example.com/fixtures/chart.png' },
];

function assistantMessage(content: ExtendedMessage['content']): ExtendedMessage {
  return { id: 'assistant-1', role: 'assistant', content, createdAt: new Date('2026-01-01T00:00:00.000Z') };
}

describe('chat message persistence round trip', () => {
  it('keeps a source_images content part unchanged through toDBMessages and fromDBMessages', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'ok' },
      { type: 'source_images', source_images: SOURCE_IMAGES },
    ];

    const [restored] = fromDBMessages(toDBMessages([assistantMessage(parts)]));

    expect(restored.content).toEqual(parts);
    expect(Array.isArray(restored.content) && restored.content[1]).toEqual({
      type: 'source_images',
      source_images: SOURCE_IMAGES,
    });
  });

  it('copies content as-is into the database shape', () => {
    const parts: ContentPart[] = [{ type: 'source_images', source_images: SOURCE_IMAGES }];
    const message = assistantMessage(parts);

    const [stored] = toDBMessages([message]);

    expect(stored.content).toBe(message.content);
    expect(stored.id).toBe('assistant-1');
    expect(stored.role).toBe('assistant');
  });

  it('keeps plain string content and maps the system role to data and back', () => {
    const stored = toDBMessages([
      { id: 's-1', role: 'system', content: 'be brief' },
      { id: 'u-1', role: 'user', content: 'hello' },
    ]);

    expect(stored.map((message) => message.role)).toEqual(['data', 'user']);
    expect(stored.map((message) => message.content)).toEqual(['be brief', 'hello']);

    const restored = fromDBMessages(stored);
    expect(restored.map((message) => message.role)).toEqual(['system', 'user']);
    expect(restored.map((message) => message.content)).toEqual(['be brief', 'hello']);
  });
});

function seedTextDocument() {
  h.supabase.store.documents = [
    { id: 'doc-text-1', filename: 'handbook.md', created_at: '2026-01-01T00:00:00.000Z', content: 'Refund handbook', metadata: {} },
  ];
  h.supabase.store.document_chunks = [{ id: 'chunk-text-1', document_id: 'doc-text-1', metadata: {} }];
  h.retrieval.mockResolvedValue(
    retrievalWith([
      {
        chunk_id: 'chunk-text-1',
        document_id: 'doc-text-1',
        content: 'Refunds are accepted within 30 days of purchase.',
        similarity: 0.6,
        metadata: {},
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.6,
        match_reason: 'similarity',
      },
    ]),
  );
}

async function postChat(query: string) {
  vi.resetModules();
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/chat/route');
  return POST(chatRequest({ messages: [{ role: 'user', content: query }], data: { ragMode: 'strict', settings: { webSearch: false } } }));
}

function streamMetadata(body: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { messageMetadata?: Record<string, unknown> };
      if (chunk.messageMetadata) found.push(chunk.messageMetadata);
    } catch {
      continue;
    }
  }
  return found;
}

describe('chat trace linkage', () => {
  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.finished.length = 0;
    h.supabase.store.documents = [];
    h.supabase.store.document_chunks = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedTextDocument();
  });

  it('streams the request trace id in the assistant message metadata and keeps it through UI, extended and database shapes', async () => {
    const body = await readSse(await postChat('how long is the refund window'));

    expect(h.finished).toHaveLength(1);
    const traceId = h.finished[0].traceId;
    expect(traceId).toMatch(TRACE_ID);
    const carried = streamMetadata(body).filter((metadata) => metadata.ragTraceId === traceId);
    expect(carried.length).toBeGreaterThan(0);

    const ui: Parameters<typeof fromUIMessage>[0] = { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], metadata: carried[0] };
    const extended = fromUIMessage(ui);
    expect(extended.metadata?.ragTraceId).toBe(traceId);

    const stored = JSON.parse(JSON.stringify(toDBMessages([extended]))) as DBMessage[];
    expect(stored[0].metadata?.ragTraceId).toBe(traceId);

    const [restored] = fromDBMessages(stored);
    expect(restored.metadata?.ragTraceId).toBe(traceId);
    expect(toMessage(restored).metadata).toMatchObject({ ragTraceId: traceId });
  });

  it('keeps messages without a trace id free of metadata in the database shape', () => {
    const [stored] = toDBMessages([{ id: 'u-1', role: 'user', content: 'hello' }]);

    expect(stored).not.toHaveProperty('metadata');
  });

  it('records the query, final answer, context and model on the trace before the export runs', async () => {
    const response = await postChat('how long is the refund window');
    await h.capture.calls[0].onFinish({ text: FINAL_ANSWER });
    await readSse(response);

    expect(h.finished).toHaveLength(1);
    const review = h.finished[0].reviewContent();
    expect(review?.query).toBe('how long is the refund window');
    expect(review?.answer).toBe(FINAL_ANSWER);
    expect(review?.context).toContain('Refunds are accepted within 30 days');
    expect(typeof review?.model).toBe('string');
    expect(review?.model).not.toBe('');
  });
});
