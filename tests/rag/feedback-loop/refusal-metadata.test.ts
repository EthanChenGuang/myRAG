import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    tasks: [] as Array<() => Promise<void>>,
    writes: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));
vi.mock('@/lib/rag/feedback-loop/retrieval-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/feedback-loop/retrieval-log')>();
  return {
    ...actual,
    writeRetrievalLog: async (row: Record<string, unknown>) => {
      h.writes.push(row);
    },
  };
});
vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), streamText: h.capture.streamText }));
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
const VARS = [MODE, 'RAG_RETRIEVAL_LOG', 'RAG_REFUSAL_FEEDBACK'] as const;
const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
const QUESTION = 'What does the synthetic sample note say about the blue widget?';
const CHAT_ID = '44444444-4444-4444-8444-444444444444';

type Path = 'no_context' | 'kb_unavailable';

async function ask(path: Path, data: Record<string, unknown> = {}): Promise<string> {
  process.env[MODE] = 'single-tenant';
  vi.resetModules();
  await installChatPipeline(h);
  if (path === 'kb_unavailable') h.retrieval.mockRejectedValue(new Error('vector backend down'));
  else h.retrieval.mockResolvedValue(retrievalWith([]));
  const route = await import('@/app/api/chat/route');
  const response = await route.POST(
    chatRequest({
      messages: [{ role: 'user', content: QUESTION }],
      data: { ragMode: 'strict', chatId: CHAT_ID, settings: { webSearch: false, language: 'en' }, ...data },
    }),
  );
  const body = await readSse(response);
  while (h.tasks.length > 0) await h.tasks.shift()!();
  return body;
}

function parts(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    out.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return out;
}

function withoutStart(body: string): string {
  return body
    .split('\n\n')
    .filter((frame) => !frame.startsWith('data: {"type":"start"'))
    .join('\n\n');
}

function setSwitches(log: string | undefined, refusal: string | undefined) {
  if (log === undefined) delete process.env.RAG_RETRIEVAL_LOG;
  else process.env.RAG_RETRIEVAL_LOG = log;
  if (refusal === undefined) delete process.env.RAG_REFUSAL_FEEDBACK;
  else process.env.RAG_REFUSAL_FEEDBACK = refusal;
}

/** The bytes of both streams before this plan, with Date pinned so the text id is stable. */
const EXPECTED_TODAY: Record<Path, (body: string) => void> = {
  no_context: (body) => {
    expect(parts(body).map((part) => part.type)).toEqual(['text-start', 'text-delta', 'text-end']);
    expect(body).toContain('"id":"text-1798761600000"');
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  },
  kb_unavailable: (body) => {
    expect(parts(body).map((part) => part.type)).toEqual(['error']);
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  },
};

beforeEach(() => {
  h.capture.reset();
  h.retrieval.mockReset();
  h.tasks.length = 0;
  h.writes.length = 0;
  h.supabase.store.documents = [];
  h.supabase.store.document_chunks = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe.each<Path>(['no_context', 'kb_unavailable'])('chat %s stream and RAG_REFUSAL_FEEDBACK (D-08)', (path) => {
  it('with every switch at its default the stream is today’s', async () => {
    setSwitches(undefined, undefined);
    const body = await ask(path);
    EXPECTED_TODAY[path](body);
    expect(body).not.toContain('refusal');
    expect(body).not.toContain('ragTraceId');
  });

  it('switch off with the log on: byte-identical to the defaults', async () => {
    setSwitches(undefined, undefined);
    const baseline = await ask(path);
    setSwitches('ids', 'false');
    const body = await ask(path);
    expect(body).toBe(baseline);
    expect(h.writes).toHaveLength(1);
  });

  it('switch on with the log off: no metadata, byte-identical', async () => {
    setSwitches(undefined, undefined);
    const baseline = await ask(path);
    setSwitches('off', 'true');
    expect(await ask(path)).toBe(baseline);
  });

  it('switch on with the log on: a start part with {ragTraceId, refusal: true} first, the rest unchanged', async () => {
    setSwitches('ids', 'false');
    const off = await ask(path);
    h.writes.length = 0;
    setSwitches('ids', 'true');
    const body = await ask(path);

    const [first, ...rest] = parts(body);
    // the SDK adds a generated messageId to a start part that has none
    expect(first).toEqual({
      type: 'start',
      messageId: expect.any(String),
      messageMetadata: { ragTraceId: expect.stringMatching(/^[0-9a-f]{32}$/), refusal: true },
    });
    expect(rest).toEqual(parts(off));
    expect(withoutStart(body)).toBe(off);
    expect(h.writes).toHaveLength(1);
    expect((first!.messageMetadata as { ragTraceId: string }).ragTraceId).toBe(h.writes[0]!.trace_id);
    expect(h.writes[0]!.outcome).toBe(path === 'no_context' ? 'refused_no_context' : 'kb_unavailable');
  });

  it('switch on with the log on but a ghost chat (no row is written): no metadata', async () => {
    setSwitches(undefined, undefined);
    const baseline = await ask(path, { chatId: 'ghost-1234' });
    setSwitches('masked_query', 'true');
    expect(await ask(path, { chatId: 'ghost-1234' })).toBe(baseline);
    expect(h.writes).toHaveLength(0);
  });
});
