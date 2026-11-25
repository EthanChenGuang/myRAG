import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_USER_ID, chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';
import { detectLanguage } from '@/lib/rag/lang/detect';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    tasks: [] as Array<() => Promise<void>>,
    imported: 0,
    writes: [] as Array<{ row: Record<string, unknown>; expectedTenantKey: string }>,
    finishText: undefined as string | undefined,
  };
});

vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));

vi.mock('@/lib/rag/feedback-loop/retrieval-log', async (importOriginal) => {
  h.imported += 1;
  const actual = await importOriginal<typeof import('@/lib/rag/feedback-loop/retrieval-log')>();
  return {
    ...actual,
    writeRetrievalLog: async (row: Record<string, unknown>, options: { expectedTenantKey: string }) => {
      h.writes.push({ row, expectedTenantKey: options.expectedTenantKey });
    },
  };
});

/** The shared capture never calls streamText's onFinish; this wrapper calls it before the finish part when a text is set. */
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
    };
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

const MODE = 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE';
const QUESTION = 'What does the synthetic sample note say about the blue widget?';
const CHAT_ID = '44444444-4444-4444-8444-444444444444';
const ANSWER_EN = 'The sample note says the blue widget is stored on the second shelf and is checked every week.';
const ANSWER_IT = 'La nota di esempio dice che il widget blu è conservato sul secondo scaffale e viene controllato ogni settimana.';
const saved = { mode: process.env[MODE], log: process.env.RAG_RETRIEVAL_LOG };

function chunkRow(id: string, similarity = 0.9) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `Chunk 1 of 1. The blue widget sample note ${id}.`,
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
    filename: `sample-note-${id}.md`,
    created_at: '2026-01-01T00:00:00.000Z',
    content: 'sample note',
    metadata: {},
  }));
  h.supabase.store.document_chunks = ids.map((id) => ({ id: `chunk-${id}`, document_id: `doc-${id}`, metadata: null }));
}

async function loadRoute() {
  process.env[MODE] = 'single-tenant';
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

async function ask(data: Record<string, unknown> = {}) {
  const route = await loadRoute();
  const response = await route.POST(
    chatRequest({
      messages: [{ role: 'user', content: QUESTION }],
      data: { ragMode: 'strict', chatId: CHAT_ID, settings: { webSearch: false }, ...data },
    }),
  );
  const body = await readSse(response);
  while (h.tasks.length > 0) await h.tasks.shift()!();
  return body;
}

function rows(): Array<Record<string, unknown>> {
  return h.writes.map((write) => write.row);
}

function onlyRow(): Record<string, unknown> {
  expect(h.writes).toHaveLength(1);
  return h.writes[0]!.row;
}

beforeEach(() => {
  h.capture.reset();
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(retrievalWith([]));
  h.ssr.auth.getUser.mockClear();
  h.supabase.store.documents = [];
  h.supabase.store.document_chunks = [];
  h.tasks.length = 0;
  h.writes.length = 0;
  h.imported = 0;
  h.finishText = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of [[MODE, saved.mode], ['RAG_RETRIEVAL_LOG', saved.log]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('chat route retrieval log with RAG_RETRIEVAL_LOG off (default)', () => {
  it('never imports the writer, schedules no log task and makes no extra session lookup', async () => {
    delete process.env.RAG_RETRIEVAL_LOG;
    seedDocuments(['a']);
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('a')]));
    h.finishText = ANSWER_EN;
    await ask();
    await ask({ ragMode: 'strict', settings: { webSearch: false, language: 'es' } });
    h.supabase.store.documents = [];
    h.retrieval.mockResolvedValue(retrievalWith([]));
    await ask();
    h.retrieval.mockRejectedValue(new Error('vector backend down'));
    await ask();

    expect(h.imported).toBe(0);
    expect(h.writes).toHaveLength(0);
    expect(h.ssr.auth.getUser).not.toHaveBeenCalled();
  });
});

describe('chat route retrieval log in ids mode (D-03a, D-05, D-07)', () => {
  beforeEach(() => {
    process.env.RAG_RETRIEVAL_LOG = 'ids';
  });

  it('a normal answer gives one answered row with rag mode, chat id, user id and the detected answer language', async () => {
    seedDocuments(['a']);
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('a')]));
    h.finishText = ANSWER_IT;
    await ask({ ragMode: 'balanced' });

    const row = onlyRow();
    expect(row).toMatchObject({ channel: 'chat', outcome: 'answered', rag_mode: 'balanced', chat_id: CHAT_ID, user_id: FAKE_USER_ID });
    expect(row.answer_language).toBe(detectLanguage(ANSWER_IT));
    expect(row.answer_language).toBe('it');
    expect(row.query_masked ?? null).toBeNull();
    expect(h.writes[0]!.expectedTenantKey).toBe('s:default');
  });

  it('the query reaches the log only for language detection in ids mode and is never sent with the row text', async () => {
    seedDocuments(['a']);
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('a')]));
    h.finishText = ANSWER_EN;
    await ask();
    const row = onlyRow();
    expect(row.query_language).toBe('en');
    expect(JSON.stringify(row)).not.toContain(QUESTION);
    expect(JSON.stringify(row)).not.toContain(ANSWER_EN);
  });

  it('an aborted generation leaves the answer language null', async () => {
    seedDocuments(['a']);
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('a')]));
    h.capture.setAbort(true);
    await ask();
    const row = onlyRow();
    expect(row.outcome).toBe('answered');
    expect(row.answer_language).toBeNull();
  });

  it.each([
    { language: 'en', rendered: 'en' },
    { language: 'es', rendered: 'es' },
    { language: 'zh', rendered: 'en' },
    { language: 'x'.repeat(500), rendered: 'en' },
    { language: '<b onclick="x">it</b>', rendered: 'en' },
  ])('strict with no context gives refused_no_context in the rendered language $rendered', async ({ language, rendered }) => {
    await ask({ settings: { webSearch: false, language } });
    const row = onlyRow();
    expect(row.outcome).toBe('refused_no_context');
    expect(row.answer_language).toBe(rendered);
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it.each([
    { language: 'zh', rendered: 'zh' },
    { language: 'it', rendered: 'it' },
    { language: 'fr', rendered: 'en' },
    { language: '<script>alert(1)</script>', rendered: 'en' },
    { language: 'toString', rendered: 'en' },
  ])('a retrieval error in strict without web search gives kb_unavailable in the rendered language $rendered', async ({ language, rendered }) => {
    h.retrieval.mockRejectedValue(new Error('vector backend down'));
    await ask({ settings: { webSearch: false, language } });
    const row = onlyRow();
    expect(row.outcome).toBe('kb_unavailable');
    expect(row.answer_language).toBe(rendered);
  });

  it('a retrieval error in balanced mode gives degraded_answer', async () => {
    h.retrieval.mockRejectedValue(new Error('vector backend down'));
    h.finishText = ANSWER_EN;
    await ask({ ragMode: 'balanced' });
    const row = onlyRow();
    expect(row.outcome).toBe('degraded_answer');
    expect(row.status).toBe('degraded');
    expect(row.answer_language).toBe('en');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
  });

  it('a ghost chat, a disableRAG request and the bypass mode write no row', async () => {
    seedDocuments(['a']);
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('a')]));
    h.finishText = ANSWER_EN;
    await ask({ chatId: 'ghost-1234' });
    await ask({ disableRAG: true });
    await ask({ ragMode: 'bypass' });
    expect(rows()).toHaveLength(0);
  });
});
