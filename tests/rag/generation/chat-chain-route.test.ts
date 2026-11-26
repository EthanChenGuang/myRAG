import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { AnswerSentenceSchema } from '@/lib/rag-eval/contracts.generated';
import { NO_ANSWER_SENTINEL } from '@/lib/rag/generation/sentinel';
import { fixedText } from '@/lib/rag/lang/texts';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const SESSION_USER = '00000000-0000-4000-8000-0000000019c1';
const QUESTION = 'What is the refund window for annual plans?';
const GPT_PATTERN = /gpt-4|o1|chatgpt/;

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const state = { deltas: ['ok'] as string[], finishReason: 'stop' as 'stop' | 'length' };
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          ...state.deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end' as const, id: 't1' },
          {
            type: 'finish' as const,
            finishReason: { unified: state.finishReason, raw: state.finishReason },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      }),
    });
  const session = { userId: null as string | null };
  return {
    state,
    model,
    session,
    params: [] as Array<Record<string, unknown>>,
    finishInputs: [] as Array<Record<string, unknown>>,
    logRows: [] as Array<Record<string, unknown>>,
    tasks: [] as Array<() => Promise<void>>,
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }) } },
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (params: Parameters<typeof actual.streamText>[0]) => {
      h.params.push(params as unknown as Record<string, unknown>);
      return actual.streamText(params);
    },
  };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => h.model(modelId),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));
vi.mock('@/lib/rag/generation/answer-finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/answer-finish')>()),
  scheduleAnswerFinish: (input: Record<string, unknown>) => {
    h.finishInputs.push(input);
    return null;
  },
}));
vi.mock('@/lib/rag/feedback-loop/retrieval-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/feedback-loop/retrieval-log')>()),
  writeRetrievalLog: async (row: Record<string, unknown>) => {
    h.logRows.push(row);
  },
}));

const SWITCHES = [
  'RAG_CITATIONS',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_CITATION_PER_SENTENCE',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_RETRIEVAL_LOG',
] as const;

const PHASE_52_KEYS = ['sentences', 'notices', 'answerLanguage', 'truncated', 'refusalOrigin'];
const FINISH_INPUT_KEYS = ['checks', 'answerLanguage', 'textsSource', 'refusedByModel'];

function nonGptModel(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  const id = models.map((model) => model.id).find((candidate) => !GPT_PATTERN.test(candidate) && !candidate.includes('claude'));
  if (!id) throw new Error('no non-GPT fixture model configured');
  return id;
}

interface SseChunk {
  type?: string;
  delta?: string;
  messageMetadata?: Record<string, unknown>;
}

function parseSse(body: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(payload) as SseChunk);
    } catch {
      continue;
    }
  }
  return chunks;
}

const textOf = (chunks: SseChunk[]) =>
  chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta ?? '').join('');
const finishOf = (chunks: SseChunk[]) => chunks.find((chunk) => chunk.type === 'finish')?.messageMetadata ?? {};

function setEnv(values: Partial<Record<(typeof SWITCHES)[number], string>>) {
  for (const name of SWITCHES) delete process.env[name];
  Object.assign(process.env, values);
}

describe('chat route: answer chain, finish metadata and checks input (05.2-09)', () => {
  let fixture: RouteFixture;
  let model: string;

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    model = nonGptModel();
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.params.length = 0;
    h.finishInputs.length = 0;
    h.logRows.length = 0;
    h.tasks.length = 0;
    h.state.deltas = ['ok'];
    h.state.finishReason = 'stop';
    h.session.userId = SESSION_USER;
    h.exa.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setEnv({});
    vi.restoreAllMocks();
  });

  async function post(data: Record<string, unknown>) {
    const { POST } = await fixture.loadRoute('chat');
    const response = await POST(chatRequest({ messages: [{ role: 'user', content: QUESTION }], data }));
    const chunks = parseSse(await response.text());
    for (const task of h.tasks.splice(0)) await task();
    return chunks;
  }

  const body = (extra: Record<string, unknown> = {}) => ({
    ragMode: 'strict',
    settings: { model, webSearch: false },
    capabilities: { citations: true },
    ...extra,
  });

  it('every switch off: only the citation transform, no new metadata key and no new finish-input key', async () => {
    setEnv({ RAG_CITATIONS: 'true' });
    h.state.deltas = ['Annual plans have a window [S1].'];
    const chunks = await post(body());
    const transforms = h.params.at(-1)?.experimental_transform as unknown[];
    expect(Array.isArray(transforms)).toBe(true);
    expect(transforms).toHaveLength(1);
    const metadata = finishOf(chunks);
    for (const key of PHASE_52_KEYS) expect(metadata).not.toHaveProperty(key);
    expect(metadata).not.toHaveProperty('refusal');
    expect(h.finishInputs).toHaveLength(1);
    for (const key of FINISH_INPUT_KEYS) expect(h.finishInputs[0]).not.toHaveProperty(key);
  });

  it('every switch off and no citations: no experimental_transform at all', async () => {
    setEnv({});
    await post(body({ capabilities: undefined }));
    expect(h.params.at(-1)).not.toHaveProperty('experimental_transform');
  });

  it('relevance rule on: a sentinel answer streams the registry refusal and is not scored', async () => {
    setEnv({
      RAG_CITATIONS: 'true',
      RAG_CONTEXT_RELEVANCE_RULE: 'true',
      RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
      RAG_PRIMARY_LANGUAGE: 'en',
      RAG_RETRIEVAL_LOG: 'ids',
    });
    h.state.deltas = [NO_ANSWER_SENTINEL.slice(0, 6), NO_ANSWER_SENTINEL.slice(6)];
    const chunks = await post(body({ chatId: '55555555-5555-4555-8555-555555555555' }));
    expect(textOf(chunks)).toBe(fixedText('notices.no_information', 'en'));
    const metadata = finishOf(chunks);
    expect(metadata.refusal).toBe(true);
    expect(metadata.refusalOrigin).toBe('model_relevance');
    expect(h.finishInputs).toHaveLength(1);
    expect(h.finishInputs[0]!.groundednessEligible).toBe(false);
    expect(h.finishInputs[0]!.refusedByModel).toBe(true);
    expect(h.logRows.at(-1)).toMatchObject({ outcome: 'refused_no_context' });
  });

  it('per-sentence on: sentences[] and answerLanguage in the metadata, the same records in the finish input', async () => {
    setEnv({ RAG_CITATIONS: 'true', RAG_CITATION_PER_SENTENCE: 'true', RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' });
    h.state.deltas = ['Annual plans have a window [S1]. ', 'Monthly plans differ.'];
    const chunks = await post(body());
    const metadata = finishOf(chunks);
    const sentences = metadata.sentences as unknown[];
    expect(sentences).toHaveLength(2);
    for (const record of sentences) expect(AnswerSentenceSchema.safeParse(record).success).toBe(true);
    expect(metadata.answerLanguage).toBe('en');
    expect(metadata.truncated).toBe(false);
    const checks = h.finishInputs[0]!.checks as { sentences?: unknown[]; finish_reason?: string };
    expect(checks.sentences).toEqual(sentences);
    expect(checks.finish_reason).toBe('stop');
    expect(h.finishInputs[0]!.answerLanguage).toBe('en');
    expect(h.finishInputs[0]!.refusedByModel).toBe(false);
  });

  it("a body with channel 'whatsapp' gets the truncation notice as text; any other body gets it in the metadata", async () => {
    setEnv({ RAG_CITATION_PER_SENTENCE: 'true', RAG_CITATIONS: 'true', RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' });
    const notice = fixedText('notices.answer_truncated', 'en');
    h.state.finishReason = 'length';
    h.state.deltas = ['Annual plans have a window'];
    const plain = await post(body({ channel: 'whatsapp' }));
    expect(textOf(plain)).toBe(`Annual plans have a window\n\n${notice}`);
    expect(finishOf(plain)).not.toHaveProperty('notices');

    const web = await post(body({ channel: 'something-else' }));
    expect(textOf(web)).toBe('Annual plans have a window');
    expect(finishOf(web).notices).toEqual([{ kind: 'answer_truncated', text: notice, language: 'en' }]);
    expect(finishOf(web).truncated).toBe(true);
  });
});
