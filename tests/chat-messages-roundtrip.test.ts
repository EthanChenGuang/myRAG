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

const ANSWER_ID = '7d3f0a52-4c1e-4b7a-9d55-2f1c8e6b9a01';

function citationRecord(n: number, overrides: Record<string, unknown> = {}) {
  return {
    alias: `S${n}`,
    chunkIds: [`chunk-${n}`],
    documentId: `doc-${n}`,
    documentName: `handbook-${n}.md`,
    documentVersion: 2,
    n,
    page: 3,
    quote: `Refunds are accepted within ${n * 10} days.`,
    quoteHash: 'a'.repeat(64),
    sectionPath: ['Refunds'],
    strategy: 'chunk-alias',
    ...overrides,
  };
}

const GROUNDEDNESS = {
  checkedAt: '2026-11-25T10:00:05.000Z',
  label: 'verified',
  latencyMs: 820,
  reason: null,
  score: 0.91,
  scorer: 'hhem_2_1_open',
  status: 'scored',
  threshold: 0.5,
  thresholdSource: 'default',
  truncated: false,
};

const FEEDBACK = { comment: null, reasons: [], updatedAt: '2026-11-25T10:01:00.000Z', vote: 'helpful' };

function answerMetadata() {
  return {
    ragTraceId: 'f'.repeat(32),
    answerId: ANSWER_ID,
    citations: [citationRecord(1), citationRecord(2)],
    citationStrategy: 'chunk-alias',
    invalidCitations: 1,
    groundedness: GROUNDEDNESS,
    feedback: FEEDBACK,
  };
}

function assistantWith(metadata: Record<string, unknown> | undefined): ExtendedMessage {
  return {
    id: 'assistant-9',
    role: 'assistant',
    content: 'Refunds are accepted within 30 days [S1].',
    createdAt: new Date('2026-11-25T10:00:00.000Z'),
    ...(metadata ? { metadata } : {}),
  };
}

function saveAndReload(message: ExtendedMessage): ExtendedMessage {
  const stored = JSON.parse(JSON.stringify(toDBMessages([message]))) as DBMessage[];
  return fromDBMessages(stored)[0];
}

describe('answer metadata persistence (D-15)', () => {
  it('keeps answerId, citations, strategy, invalid count, groundedness and feedback through save, reload and the UI shape', () => {
    const metadata = answerMetadata();
    const stored = JSON.parse(JSON.stringify(toDBMessages([assistantWith(metadata)]))) as DBMessage[];
    expect(stored[0].metadata).toEqual(metadata);

    const [restored] = fromDBMessages(stored);
    expect(restored.metadata).toEqual(metadata);

    const ui = toMessage(restored);
    expect(ui.metadata).toMatchObject(metadata);
    const back = fromUIMessage(ui);
    expect(back.metadata).toEqual(metadata);
    expect(saveAndReload(back).metadata).toEqual(metadata);
  });

  it('round-trips a message with only ragTraceId and one with no metadata exactly as before', () => {
    const traced = assistantWith({ ragTraceId: 'f'.repeat(32) });
    const [stored] = toDBMessages([traced]);
    expect(stored.metadata).toEqual({ ragTraceId: 'f'.repeat(32) });
    expect(Object.keys(stored)).toEqual(['id', 'role', 'content', 'createdAt', 'metadata']);
    expect(saveAndReload(traced).metadata).toEqual({ ragTraceId: 'f'.repeat(32) });

    const plain = assistantWith(undefined);
    const [plainStored] = toDBMessages([plain]);
    expect(plainStored).not.toHaveProperty('metadata');
    expect(saveAndReload(plain)).not.toHaveProperty('metadata');
  });

  it('drops malformed values field by field and never persists unknown keys', () => {
    const metadata = {
      ...answerMetadata(),
      citations: [citationRecord(1), { ...citationRecord(2), quoteHash: 'not-a-hash' }, citationRecord(3)],
      groundedness: { ...GROUNDEDNESS, status: 'great' },
      somethingElse: 'kept out',
    };
    const [stored] = toDBMessages([assistantWith(metadata)]);
    expect(stored.metadata).toEqual({
      ragTraceId: 'f'.repeat(32),
      answerId: ANSWER_ID,
      citations: [citationRecord(1), citationRecord(3)],
      citationStrategy: 'chunk-alias',
      invalidCitations: 1,
      feedback: FEEDBACK,
    });

    const [badId] = toDBMessages([assistantWith({ ragTraceId: 'f'.repeat(32), answerId: 'answer-1', invalidCitations: -2 })]);
    expect(badId.metadata).toEqual({ ragTraceId: 'f'.repeat(32) });

    const loaded = fromDBMessages([
      { id: 'a-1', role: 'assistant', content: 'x', metadata: { answerId: ANSWER_ID, feedback: { vote: 'meh' } } as unknown as DBMessage['metadata'] },
    ]);
    expect(loaded[0].metadata).toEqual({ answerId: ANSWER_ID });
  });
});
