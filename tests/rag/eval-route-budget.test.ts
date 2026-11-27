import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { generateText, type LanguageModel } from 'ai';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { RagTraceSchema, type GoldenItem } from '@/lib/rag-eval/contracts.generated';
import { installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';

const SECRET = 'b'.repeat(48);
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_PROMPT_BUDGET',
  'RAG_CONTEXT_OVERFLOW',
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_CALC_TOOL',
  'RAG_CALC_CHECK',
  'RAG_CITATIONS',
  'RAG_SYSTEM_PROMPT',
  'RAG_PRE_CONTEXT',
  'RAG_POST_CONTEXT',
] as const;
const env = process.env as Record<string, string | undefined>;

const SMALL = 'fixture/small-window-4k';
const QUESTION = 'Which marker opens the Orvane sequence phase with eleven rounds?';
const FILLER = 'The Orvane ledger lists plain grey tiles in a row along the quiet hall near the old gate.';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

let saved: Record<string, string | undefined>;

function repeat(text: string, times: number): string {
  return Array.from({ length: times }, (_, index) => `${text} (${index + 1})`).join(' ');
}

function chunkRow(id: string, content: string, similarity: number) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content,
    similarity,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: similarity,
    match_reason: 'similarity',
  };
}

function seed(rows: Array<ReturnType<typeof chunkRow>>) {
  h.supabase.store.documents = rows.map((row) => ({
    id: row.document_id,
    filename: `orvane-notes-${row.document_id}.md`,
    created_at: '2026-01-01T00:00:00.000Z',
    content: 'orvane notes',
    metadata: {},
  }));
  h.supabase.store.document_chunks = rows.map((row) => ({ id: row.chunk_id, document_id: row.document_id, metadata: null }));
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(retrievalWith(rows));
}

function item(question: string): GoldenItem {
  return { question } as unknown as GoldenItem;
}

type Trace = ReturnType<typeof RagTraceSchema.parse> & Record<string, unknown>;

interface Harness {
  route: { POST: (req: NextRequest) => Promise<Response> };
  fake: typeof import('../../eval/harness/fake-small-window.mts');
  prompts: LanguageModelV3CallOptions['prompt'][];
}

async function loadRoute(questions: string[]): Promise<Harness> {
  vi.resetModules();
  await installChatPipeline(h);
  const models = await import('../../eval/harness/fake-answer-models.mts');
  const fake = await import('../../eval/harness/fake-small-window.mts');
  fake.resetSmallWindowRequests();
  const factory = models.installFakeAnswerModels({ items: questions.map(item) });
  await fake.installFakeModelWindows();
  const prompts: LanguageModelV3CallOptions['prompt'][] = [];
  const recording = Object.assign(
    (id: string) => {
      const inner = factory(id) as unknown as { doGenerate: (options: LanguageModelV3CallOptions) => Promise<unknown> };
      return new MockLanguageModelV3({
        provider: 'fixture',
        modelId: id,
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          return (await inner.doGenerate(options)) as Awaited<ReturnType<NonNullable<MockLanguageModelV3['doGenerate']>>>;
        },
      }) as unknown as LanguageModel;
    },
    { canUseTools: factory.canUseTools, maxOutputTokens: factory.maxOutputTokens },
  );
  const answer = await import('@/lib/rag-eval/answer');
  answer.setEvalLanguageModelFactory(recording);
  const route = await import('@/app/api/internal/rag/run/route');
  return { route, fake, prompts };
}

async function post(
  harness: Harness,
  query: string,
  conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<{ status: number; trace: Trace }> {
  const response = await harness.route.POST(
    new NextRequest('http://localhost/api/internal/rag/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
      body: JSON.stringify({
        schema_version: 1,
        query,
        ...(conversation.length > 0 ? { conversation } : {}),
        rag_mode: 'balanced',
        include_answer: true,
        options: { generator_model: SMALL },
      }),
    }),
  );
  return { status: response.status, trace: JSON.parse(await response.text()) as Trace };
}

function longHistory(turns: number) {
  return Array.from({ length: turns }, (_, index) => [
    { role: 'user' as const, content: `Turn ${index + 1} asks about the grey tiles. ${repeat(FILLER, 8)}` },
    { role: 'assistant' as const, content: `Turn ${index + 1} answer about the grey tiles. ${repeat(FILLER, 8)}` },
  ]).flat();
}

function userTexts(prompt: LanguageModelV3CallOptions['prompt']): string[] {
  return prompt
    .filter((message) => message.role === 'user')
    .map((message) => (message.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join(''));
}

describe('recording small-window fake (05.2.1-20 Task 1, D-88)', () => {
  afterEach(async () => {
    const window = await import('@/lib/rag/context/model-window');
    window.setModelContextLengthOverrides(null);
  });

  async function fakeModel() {
    const models = await import('../../eval/harness/fake-answer-models.mts');
    const fake = await import('../../eval/harness/fake-small-window.mts');
    fake.resetSmallWindowRequests();
    const factory = models.installFakeAnswerModels({ items: [item(QUESTION)] });
    await fake.installFakeModelWindows();
    return { factory, fake, models };
  }

  it('the fake is a fake generator id, declares its output limit and registers its window as the fixture family', async () => {
    const { factory, models } = await fakeModel();
    const window = await import('@/lib/rag/context/model-window');
    expect(models.isFakeGeneratorModel(SMALL)).toBe(true);
    expect(factory.maxOutputTokens(SMALL)).toBe(512);
    expect(factory.maxOutputTokens('fake/rule-following-v1')).toBeUndefined();
    expect(window.modelContextLength(SMALL)).toBe(4096);
    expect(window.modelFamily(SMALL)).toBe('fixture');
  });

  it('the fake rejects and records a prompt above its window with fake_window_exceeded', async () => {
    const { factory, fake } = await fakeModel();
    await expect(
      generateText({ model: factory(SMALL), system: repeat(FILLER, 400), messages: [{ role: 'user', content: QUESTION }], maxOutputTokens: 64 }),
    ).rejects.toThrow('fake_window_exceeded');
    expect(fake.smallWindowRequests()).toHaveLength(1);
    expect(fake.smallWindowRequests()[0].outcome).toBe('fake_window_exceeded');
    expect(fake.smallWindowRequests()[0].promptTokens).toBeGreaterThan(4096);
  });

  it('the fake rejects a request whose last user message is not the question with question_not_last', async () => {
    const { factory, fake } = await fakeModel();
    await expect(
      generateText({
        model: factory(SMALL),
        system: 'Answer from the documents.',
        messages: [
          { role: 'user', content: QUESTION },
          { role: 'assistant', content: 'An earlier answer.' },
          { role: 'user', content: 'A different later message.' },
        ],
        maxOutputTokens: 64,
      }),
    ).rejects.toThrow('question_not_last');
    expect(fake.smallWindowRequests()[0].outcome).toBe('question_not_last');
  });

  it('within its window the fake answers from the first block and reports its own count as the input tokens', async () => {
    const { factory, fake } = await fakeModel();
    const system = `Context:\n[S1] orvane-notes.md\nDocument: orvane-notes.md Content: The marker Selvan opens the phase. More text.\n`;
    const result = await generateText({
      model: factory(SMALL),
      system,
      messages: [{ role: 'user', content: QUESTION }],
      maxOutputTokens: 64,
    });
    expect(result.text).toBe('The marker Selvan opens the phase. [S1]');
    const recorded = fake.smallWindowRequests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].outcome).toBe('ok');
    expect(result.usage.inputTokens).toBe(recorded[0].promptTokens);
    const own = fake.smallWindowPromptTokens({ prompt: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text: QUESTION }] }] });
    expect(recorded[0].promptTokens).toBe(own);
  });
});

describe('prompt budget on the eval path (05.2.1-20 Task 2, D-79 to D-86)', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.RAG_SUPPORTED_LANGUAGES = 'en';
    env.RAG_PRIMARY_LANGUAGE = 'en';
    h.supabase.store.reset();
    seed([chunkRow('1', 'The marker Selvan opens the Orvane phase with eleven rounds.', 0.92), chunkRow('2', FILLER, 0.88)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    const answer = await import('@/lib/rag-eval/answer');
    answer.setEvalLanguageModelFactory(null);
    const window = await import('@/lib/rag/context/model-window');
    window.setModelContextLengthOverrides(null);
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('switch off: the whole conversation is sent and the trace has no prompt_budget, usage or answer_error', async () => {
    const harness = await loadRoute([QUESTION]);
    const history = longHistory(1);
    const { status, trace } = await post(harness, QUESTION, history);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(harness.prompts).toHaveLength(1);
    expect(userTexts(harness.prompts[0])).toEqual([history[0].content, QUESTION]);
    expect(trace).not.toHaveProperty('prompt_budget');
    expect(trace).not.toHaveProperty('usage');
    expect(trace).not.toHaveProperty('answer_error');
  });

  it('switch on, long history: the oldest turns go first, the question is last and the fake is never exceeded', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    const harness = await loadRoute([QUESTION]);
    const history = longHistory(6);
    const { status, trace } = await post(harness, QUESTION, history);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(harness.fake.smallWindowRequests().map((request) => request.outcome)).toEqual(['ok']);
    const budget = trace.prompt_budget!;
    expect(budget.status).toBe('ok');
    expect(budget.window).toBe(4096);
    expect(budget.window_source).toBe('model');
    expect(budget.estimator.family).toBe('fixture');
    expect(budget.dropped_history_turns).toBeGreaterThan(0);
    const sent = userTexts(harness.prompts[0]);
    expect(sent.at(-1)).toBe(QUESTION);
    const keptTurns = sent.length - 1;
    const expectedKept = history.filter((turn) => turn.role === 'user').slice(budget.dropped_history_turns).map((turn) => turn.content);
    expect(sent.slice(0, keptTurns)).toEqual(expectedKept);
    expect(trace.usage?.input_tokens).toBe(harness.fake.smallWindowRequests()[0].promptTokens);
    expect(budget.estimated_raw_total).toBeGreaterThan(0);
    expect(trace).not.toHaveProperty('answer_error');
  });

  it('switch on, ranked evidence: documentTokenBudget packs the documents, the dropped count is on the trace', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    seed(Array.from({ length: 8 }, (_, index) => chunkRow(String(index + 1), repeat(`Orvane note ${index + 1}. ${FILLER}`, 12), 0.95 - index * 0.01)));
    const harness = await loadRoute([QUESTION]);
    const { status, trace } = await post(harness, QUESTION);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(harness.fake.smallWindowRequests().map((request) => request.outcome)).toEqual(['ok']);
    expect(trace.prompt_budget!.dropped_documents).toBeGreaterThan(0);
    expect(trace.prompt_budget!.parts.documents).toBeGreaterThan(0);
    expect(trace.context).toContain('Orvane note 1.');
    expect(trace.context).not.toContain('Orvane note 8.');
    expect(trace.usage?.input_tokens).toBeGreaterThan(0);
  });

  it('switch on, a question longer than the window: answer_error prompt_budget_exceeded and no generation call', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    // The run contract caps the query at 4,000 characters, so the long question is written in Han characters (more tokens each)
    const long = `${'灰石方砖排成一列。'.repeat(420)} ${QUESTION}`;
    const harness = await loadRoute([long]);
    const { status, trace } = await post(harness, long);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(harness.prompts).toHaveLength(0);
    expect(harness.fake.smallWindowRequests()).toHaveLength(0);
    expect(trace.answer_error).toBe('prompt_budget_exceeded');
    expect(trace.answer).toBeNull();
    expect(trace.prompt_budget!.status).toBe('exceeded');
    expect(trace).not.toHaveProperty('usage');
  });
});
