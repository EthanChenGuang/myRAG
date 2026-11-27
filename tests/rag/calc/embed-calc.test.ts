import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import { emitNotice, renderNoticeAsText } from '@/lib/rag/generation/notices';
import { installChatPipeline, retrievalWith } from '../../helpers/chat-route-fakes';
import {
  expectCharacterization,
  readGoldenQuestions,
  SNAPSHOT_DIR,
  startRouteFixture,
  systemTextOf,
  type RouteFixture,
} from '../../helpers/route-fixture';

const QUESTION = 'What is 3 times the value of item one?';
const PLAIN_QUESTION = 'Which panel shows the export option?';
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
    fakeAdmin: true,
    calls: [] as Array<Record<string, any>>,
    parts: [] as Array<Record<string, unknown>>,
    rules: [] as Array<Record<string, unknown>>,
    retrievalInputs: [] as Array<Record<string, any>>,
    enqueued: [] as Array<Record<string, any>>,
    traces: [] as Array<{ stages: () => Array<Record<string, any>> }>,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (params: Parameters<typeof actual.streamText>[0]) => {
      h.calls.push(params as unknown as Record<string, any>);
      return actual.streamText({ ...params, model: h.model() });
    },
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
vi.mock('@/lib/rag/generation/answer-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/generation/answer-rules')>();
  return {
    ...actual,
    composeAnswerRules: (...args: Parameters<typeof actual.composeAnswerRules>) => {
      h.rules.push(args[0] as unknown as Record<string, unknown>);
      return actual.composeAnswerRules(...args);
    },
  };
});
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
vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>();
  return { ...actual, getSupabaseAdmin: () => (h.fakeAdmin ? h.supabase.client : actual.getSupabaseAdmin()) };
});
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));

const PROCESS_ENV: Record<string, string> = {
  NEXT_PUBLIC_EMBED_ENABLED: 'true',
  NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS: '*',
  NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
  EMBED_RATE_LIMIT: '100000',
};
const SWITCHES = ['RAG_CALC_TOOL', 'RAG_CALC_CHECK', 'RAG_PROMPT_BUDGET', 'RAG_CONTEXT_OVERFLOW', 'RAG_PIPELINE'] as const;
const env = process.env as Record<string, string | undefined>;

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

function parse(body: string): Array<{ type?: string; delta?: string }> {
  const out: Array<{ type?: string; delta?: string }> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      continue;
    }
  }
  return out;
}

async function post(question = QUESTION) {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
        h.retrievalInputs.push(input as unknown as Record<string, any>);
        return actual.runRetrieval(input);
      },
    };
  });
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/embed/chat/route');
  const response = await POST(
    new NextRequest('http://localhost/api/embed/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.41' },
      body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
    }),
  );
  const body = await response.text();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const chunks = parse(body);
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta ?? '').join('');
  return { body, text };
}

const ALL_521_SWITCHES = ['RAG_CALC_TOOL', 'RAG_CALC_CHECK', 'RAG_PROMPT_BUDGET', 'RAG_CONTEXT_OVERFLOW'] as const;

// Task 3 (D-03): every 5.2.1 and 5.2 switch at its default equals the committed embed characterization, never regenerated here
describe('embed route all-off proof (05.2.1-22, D-03)', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    h.fakeAdmin = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: { RAG_PIPELINE: 'legacy' } });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
    h.fakeAdmin = true;
  });

  beforeEach(() => {
    h.calls.length = 0;
    h.parts.length = 0;
    h.rules.length = 0;
    h.state.deltas = ['ok'];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('the captured request and stream equal the committed snapshot with every switch at its default', async () => {
    expect(process.env.UPDATE_CHARACTERIZATION).not.toBe('1');
    for (const name of ALL_521_SWITCHES) expect(['', 'false', 'off', 'truncate', undefined], name).toContain(process.env[name]);
    const { POST } = await fixture.loadRoute<typeof import('@/app/api/embed/chat/route')>('embed/chat');
    const rag = await import('@/lib/rag');
    const answerConfig = rag.readAnswerConfig();
    expect(answerConfig.anyNonDefault).toBe(false);
    expect([answerConfig.calcTool, answerConfig.calcCheck, answerConfig.promptBudget, answerConfig.contextOverflow]).toEqual([
      false,
      false,
      false,
      'truncate',
    ]);

    const actual: Array<{ id: string; system: string }> = [];
    for (const { id, question } of readGoldenQuestions()) {
      h.calls.length = 0;
      const response = await POST(
        new NextRequest('http://localhost/api/embed/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.43' },
          body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
        }),
      );
      const body = await response.text();
      expect(h.calls, id).toHaveLength(1);
      const params = h.calls[0];
      expect(params.tools, id).toBeUndefined();
      expect(params.providerOptions, id).toBeUndefined();
      expect(params.experimental_transform, id).toBeUndefined();
      expect(params.maxOutputTokens, id).toBe(2000);
      expect((params.messages as Array<{ role: string; content: string }>).map((m) => m.role), id).toEqual(['system', 'user']);
      expect((params.messages as Array<{ role: string; content: string }>)[1].content, id).toBe(question);
      const deltas = parse(body).filter((c) => c.type === 'text-delta').map((c) => c.delta ?? '');
      expect(deltas.join(''), id).toBe('ok');
      actual.push({ id, system: systemTextOf(params) });
    }
    expect(actual.every((entry) => !entry.system.includes(CALC_BLOCK_OPEN))).toBe(true);
    expect(h.parts.some((p) => 'calcBlock' in p || 'calcCheck' in p)).toBe(false);
    expect(h.rules.some((r) => 'calculation' in r)).toBe(false);
    expectCharacterization('embed', actual);
    const diff = execFileSync('git', ['status', '--porcelain', '--', SNAPSHOT_DIR], { encoding: 'utf8' });
    expect(diff).toBe('');
  });
});

describe('embed route calculation (05.2.1-22)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [name, value] of Object.entries(PROCESS_ENV)) {
      saved[name] = env[name];
      env[name] = value;
    }
    for (const name of SWITCHES) {
      saved[name] = env[name];
      delete env[name];
    }
    h.calls.length = 0;
    h.parts.length = 0;
    h.rules.length = 0;
    h.retrievalInputs.length = 0;
    h.enqueued.length = 0;
    h.traces.length = 0;
    h.retrieval.mockReset();
    h.state.deltas = ['ok'];
    seed();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    vi.restoreAllMocks();
  });

  it('switches off: no labeler, no calculation part, no calculation transform and no tools', async () => {
    await post();

    expect(h.retrievalInputs).toHaveLength(1);
    expect(h.retrievalInputs[0].citationLabeler).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].tools).toBeUndefined();
    expect(h.parts.some((p) => 'calcBlock' in p || 'calcCheck' in p)).toBe(false);
    expect(h.rules.some((r) => 'calculation' in r)).toBe(false);
    expect(h.enqueued).toHaveLength(0);
  });

  it('RAG_CALC_TOOL on with a quantity question: labeler, trailing-block composer part, block transform with marker stripping, no tools', async () => {
    env.RAG_CALC_TOOL = 'true';
    h.state.deltas = ['The total is 36 units [S1].', block('12')];
    const out = await post();

    expect(h.retrievalInputs[0].citationLabeler).toBeDefined();
    expect(h.rules.some((r) => (r.calculation as { mode?: string } | undefined)?.mode === 'trailing_block')).toBe(true);
    const parts = h.parts.find((p) => 'calcBlock' in p);
    expect(parts?.calcBlock).toMatchObject({ stripMarkers: true });
    expect(h.calls[0].tools).toBeUndefined();
    expect(h.calls[0].toolChoice).toBeUndefined();
    expect(out.text).toContain('The total is 36 units');
    expect(out.text).not.toContain(CALC_BLOCK_OPEN);
    expect(out.text).not.toContain('[S1]');
  });

  it('RAG_CALC_TOOL on with a question without quantity or intent term: nothing is offered', async () => {
    env.RAG_CALC_TOOL = 'true';
    await post(PLAIN_QUESTION);

    expect(h.retrievalInputs[0].citationLabeler).toBeUndefined();
    expect(h.parts.some((p) => 'calcBlock' in p || 'calcCheck' in p)).toBe(false);
    expect(h.rules.some((r) => 'calculation' in r)).toBe(false);
  });

  it('RAG_CALC_CHECK on with a wrong total: the corrected notice is the final plain-text delta and calc_mismatch is enqueued with ids only', async () => {
    env.RAG_CALC_TOOL = 'true';
    env.RAG_CALC_CHECK = 'true';
    h.state.deltas = ['The total is 40 units [S1].', block('12')];
    const out = await post();

    const notice = emitNotice('calc_corrected', { language: 'en', params: { value: '36 units' } });
    expect(out.text.endsWith(renderNoticeAsText(notice))).toBe(true);
    expect(out.text).not.toContain(CALC_BLOCK_OPEN);
    expect(h.calls[0].tools).toBeUndefined();
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      reason: 'calc_mismatch',
      detector: 'calc_check',
      sourceChunkIds: ['chunk-calc-1'],
      documentIds: ['doc-calc-1'],
    });
    expect(JSON.stringify(h.enqueued[0])).not.toContain('Item one');
    const span = h.traces.flatMap((t) => t.stages()).find((s) => s.name === 'calc_check');
    expect(span?.counts).toMatchObject({ calc_checks: 1, calc_corrected: 1 });
  });

  it('RAG_CALC_CHECK on with a correct total: no notice and nothing enqueued', async () => {
    env.RAG_CALC_TOOL = 'true';
    env.RAG_CALC_CHECK = 'true';
    h.state.deltas = ['The total is 36 units [S1].', block('12')];
    const out = await post();

    expect(out.text).toBe('The total is 36 units.');
    expect(h.enqueued).toHaveLength(0);
  });
});
