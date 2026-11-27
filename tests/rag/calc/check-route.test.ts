import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import { emitNotice } from '@/lib/rag/generation/notices';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const QUESTION = 'What is 3 times the value of item one?';
const CHUNK_TEXT = 'Item one has value 12 units.';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const state = { deltas: ['ok'] as string[] };
  const model = () =>
    new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          ...state.deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end' as const, id: 't1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      }),
    });
  return {
    ...fakes.createChatRouteHarness(),
    state,
    model,
    scheduled: [] as Array<Record<string, any>>,
    enqueued: [] as Array<Record<string, any>>,
    traces: [] as Array<{ stages: () => Array<Record<string, any>> }>,
    parts: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (params: Parameters<typeof actual.streamText>[0]) => actual.streamText({ ...params, model: h.model() }),
  };
});
vi.mock('@/lib/rag/generation/answer-transforms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/generation/answer-transforms')>();
  return {
    ...actual,
    buildAnswerTransforms: (parts: Parameters<typeof actual.buildAnswerTransforms>[0]) => {
      h.parts.push(parts as unknown as Record<string, unknown>);
      return actual.buildAnswerTransforms(parts);
    },
  };
});
vi.mock('@/lib/rag/generation/answer-finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/answer-finish')>()),
  scheduleAnswerFinish: (input: Record<string, any>) => {
    h.scheduled.push(input);
    return Promise.resolve(null);
  },
}));
vi.mock('@/lib/rag/feedback-loop/enqueue-item', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/feedback-loop/enqueue-item')>()),
  enqueueReviewItem: async (input: Record<string, any>) => {
    h.enqueued.push(input);
    return null;
  },
}));
vi.mock('@/lib/rag/trace/collector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/collector')>();
  return {
    ...actual,
    createTraceCollector: (options: Parameters<typeof actual.createTraceCollector>[0]) => {
      const collector = actual.createTraceCollector(options);
      h.traces.push(collector as never);
      return collector;
    },
  };
});
vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    void task();
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

function block(value: string): string {
  return `${CALC_BLOCK_OPEN}${JSON.stringify({
    operands: [
      { name: 'base', value, unit: 'units', source: { kind: 'chunk', alias: 'S1' } },
      { name: 'factor', value: '3', source: { kind: 'question' } },
    ],
    steps: [{ id: 'total', op: 'multiply', args: ['base', 'factor'] }],
    result: 'total',
  })}${CALC_BLOCK_CLOSE}`;
}

function seed() {
  h.supabase.store.documents = [{ id: 'doc-calc-1', filename: 'values.txt', created_at: '2026-01-01T00:00:00.000Z', content: CHUNK_TEXT, metadata: {} }];
  h.supabase.store.document_chunks = [{ id: 'chunk-calc-1', document_id: 'doc-calc-1', content: CHUNK_TEXT, metadata: {} }];
  h.retrieval.mockResolvedValue(
    retrievalWith([
      {
        chunk_id: 'chunk-calc-1',
        document_id: 'doc-calc-1',
        content: CHUNK_TEXT,
        similarity: 0.9,
        metadata: {},
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.9,
        match_reason: 'similarity',
      },
    ]),
  );
}

interface SseChunk {
  type?: string;
  delta?: string;
  messageMetadata?: Record<string, any>;
}

function parse(body: string): SseChunk[] {
  const out: SseChunk[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload) as SseChunk);
    } catch {
      continue;
    }
  }
  return out;
}

function normalize(body: string): string {
  return body.replace(/"(id|messageId|toolCallId|ragTraceId|answerId)":"[^"]*"/g, '"$1":"<id>"');
}

async function post(data: Record<string, unknown> = {}) {
  vi.resetModules();
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/chat/route');
  const body = await readSse(
    await POST(
      chatRequest({
        messages: [{ role: 'user', content: QUESTION }],
        data: { ragMode: 'strict', settings: { webSearch: false, model: DEFAULT_MODEL }, ...data },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const chunks = parse(body);
  const finish = chunks.find((c) => c.type === 'finish')?.messageMetadata;
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta ?? '').join('');
  return { body, finish, text };
}

const SWITCHES = ['RAG_CALC_TOOL', 'RAG_CALC_CHECK', 'RAG_ANSWER_FEEDBACK', 'RAG_DOMAIN_EXPERT_REVIEW'] as const;

describe('chat route calculation check (05.2.1-18)', () => {
  beforeEach(() => {
    h.retrieval.mockReset();
    h.scheduled.length = 0;
    h.enqueued.length = 0;
    h.traces.length = 0;
    h.parts.length = 0;
    for (const name of SWITCHES) delete process.env[name];
    seed();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of SWITCHES) delete process.env[name];
    vi.restoreAllMocks();
  });

  it('check on, corrected turn on web chat: finish metadata carries calc with both values; the record gets checks.calc and calc_mismatch', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_CALC_CHECK = 'true';
    process.env.RAG_ANSWER_FEEDBACK = 'true';
    h.state.deltas = ['The total is 40 units [S1].', block('12')];
    const out = await post({ capabilities: { citations: true }, chatId: '00000000-0000-4000-8000-0000000000c1' });

    expect(out.text.startsWith('The total is 40 units')).toBe(true);
    expect(out.text).not.toContain(CALC_BLOCK_OPEN);
    expect(out.finish?.calc).toEqual([expect.objectContaining({ status: 'corrected', stated: '40', recomputed: '36', unit: 'units' })]);
    expect(out.finish?.notices).toEqual([emitNotice('calc_corrected', { language: out.finish?.answerLanguage ?? 'en', params: { value: '36 units' } })]);
    expect(h.scheduled).toHaveLength(1);
    const record = h.scheduled[0]!;
    expect(record.calc?.primary).toMatchObject({ status: 'corrected', stated: '40', recomputed: '36' });
    expect(record.calc?.items).toHaveLength(1);
    expect(record.calc?.reviewReasons).toEqual(['calc_mismatch']);
    expect(h.enqueued).toEqual([]);
  });

  it('check on, not-verified turn without an answer record: the enqueue client gets calc_unverified with ids only', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_CALC_CHECK = 'true';
    h.state.deltas = ['The total is 39 units [S1].', block('13')];
    const out = await post();

    expect(out.finish?.calc).toEqual([expect.objectContaining({ status: 'not_verified' })]);
    expect(h.scheduled).toHaveLength(0);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({ reason: 'calc_unverified', sourceChunkIds: ['chunk-calc-1'], documentIds: ['doc-calc-1'] });
    expect(JSON.stringify(h.enqueued[0])).not.toContain('Item one');
  });

  it('ghost chat: the notice still appears; no record write and no enqueue', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_CALC_CHECK = 'true';
    process.env.RAG_ANSWER_FEEDBACK = 'true';
    h.state.deltas = ['The total is 39 units [S1].', block('13')];
    const out = await post({ capabilities: { citations: true }, chatId: 'ghost-1234' });

    expect(out.finish?.notices).toEqual([expect.objectContaining({ kind: 'calc_not_verified' })]);
    expect(h.scheduled).toHaveLength(0);
    expect(h.enqueued).toHaveLength(0);
  });

  it('check off: finish metadata, record inputs and transforms equal the switch-off capture', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_ANSWER_FEEDBACK = 'true';
    h.state.deltas = ['The total is 40 units [S1].', block('12')];
    const data = { capabilities: { citations: true }, chatId: '00000000-0000-4000-8000-0000000000c2' };
    const unset = await post(data);
    const unsetRecord = h.scheduled.map(({ answerId: _a, traceId: _t, ...rest }) => rest);
    const unsetParts = h.parts.map((p) => Object.keys(p).sort());
    h.scheduled.length = 0;
    h.parts.length = 0;
    process.env.RAG_CALC_CHECK = 'false';
    const off = await post(data);

    expect(normalize(off.body)).toBe(normalize(unset.body));
    expect(h.scheduled.map(({ answerId: _a, traceId: _t, ...rest }) => rest)).toEqual(unsetRecord);
    expect(h.parts.map((p) => Object.keys(p).sort())).toEqual(unsetParts);
    expect(off.finish?.calc).toBeUndefined();
    expect(h.scheduled[0]?.calc).toBeUndefined();
    expect(h.parts.some((p) => 'calcCheck' in p)).toBe(false);
    expect(h.enqueued).toHaveLength(0);
  });

  it('the trace has a calc_check span with status counts, and latency-budgets.json has a report-only calc_check entry', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_CALC_CHECK = 'true';
    h.state.deltas = ['The total is 40 units [S1].', block('12')];
    await post();

    const stages = h.traces.flatMap((t) => t.stages());
    const span = stages.find((s) => s.name === 'calc_check');
    expect(span).toBeDefined();
    expect(span?.counts).toMatchObject({ calc_corrected: 1 });
    expect(JSON.stringify(span)).not.toContain('Item one');

    const budgets = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../eval/config/latency-budgets.json'), 'utf8'));
    expect(budgets.answer_checks.calc_check).toMatchObject({ p50_ms: expect.any(Number), p95_ms: expect.any(Number) });
    expect(budgets.answer_checks.report_only).toBe(true);
  });
});
