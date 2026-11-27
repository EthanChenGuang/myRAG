import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, emptyRetrieval, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';
import { FAKE_ANTHROPIC_KEY } from '../../helpers/fake-anthropic';
import { systemTextOf } from '../../helpers/route-fixture';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '@/lib/rag/generation/citations/claude';
import { attachedDocumentsSentence } from '@/lib/rag/generation/citations/instructions';
import { NO_ANSWER_SENTINEL } from '@/lib/rag/generation/sentinel';
import { outputCapFloor } from '@/lib/rag/generation/output-cap';
import { fixedText } from '@/lib/rag/lang/texts';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const state = { deltas: ['A short answer.'] as string[], finishReason: 'stop' as 'stop' | 'length' };
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
  return { ...fakes.createChatRouteHarness(), state, model, params: [] as Array<Record<string, any>> };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (params: Parameters<typeof actual.streamText>[0]) => {
      h.params.push(params as unknown as Record<string, any>);
      return actual.streamText({ ...params, model: h.model('fake-model') } as Parameters<typeof actual.streamText>[0]);
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
vi.mock('@/lib/rag/generation/answer-finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/answer-finish')>()),
  scheduleAnswerFinish: () => null,
}));

const SWITCHES = [
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_REGISTRY_TEXTS',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_CITATIONS',
  'RAG_CLAUDE_CITATIONS',
  'ANTHROPIC_API_KEY',
  'NEXT_PUBLIC_OPENROUTER_MODELS',
  'NEXT_PUBLIC_REASONING_ENABLED',
] as const;
type SwitchName = (typeof SWITCHES)[number];
const saved: Partial<Record<SwitchName | 'RAG_SYSTEM_PROMPT', string | undefined>> = {};

const CLAUDE_MODEL = 'anthropic/claude-sonnet-5.5';
const MODELS = JSON.stringify([{ id: CLAUDE_MODEL, displayName: 'Claude Sonnet 5.5', anthropicId: 'claude-sonnet-5-5' }]);
const QUESTION = 'What is the value of the second item in the list?';
const CHUNK_TEXT = 'The second item in the list has the value B.';
const QUESTIONS = {
  en: 'What is the value of the second item in the list?',
  zh: '列表中第二项的数值是多少？',
  it: 'Qual è il valore del secondo elemento della lista?',
} as const;
const LANGUAGES = ['zh', 'en', 'it'] as const;

function setEnv(values: Partial<Record<SwitchName, string>>): void {
  for (const name of SWITCHES) delete process.env[name];
  Object.assign(process.env, { RAG_SYSTEM_PROMPT: 'You are a careful assistant for a synthetic test.\n\nContext:\n{{context}}' }, values);
  resetLanguageSettingsForTests();
}

function contextRetrieval() {
  return retrievalWith([
    {
      chunk_id: 'chunk-1',
      document_id: 'doc-1',
      content: CHUNK_TEXT,
      similarity: 0.9,
      metadata: null,
      temporal_score: 0,
      financial_score: 0,
      final_score: 0.9,
      match_reason: 'similarity',
    },
  ]);
}

function streamedText(body: string): string {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const part = JSON.parse(line.slice(5).trim()) as { type?: string; delta?: string };
      if (part.type === 'text-delta' && typeof part.delta === 'string') out.push(part.delta);
    } catch {
      continue;
    }
  }
  return out.join('');
}

interface Turn {
  body: string;
  params: Array<Record<string, any>>;
}

async function ask(
  values: Partial<Record<SwitchName, string>>,
  data: Record<string, unknown>,
  messages: Array<Record<string, unknown>> = [{ role: 'user', content: QUESTION }],
): Promise<Turn> {
  setEnv(values);
  h.params.length = 0;
  vi.resetModules();
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/chat/route');
  const body = await readSse(await POST(chatRequest({ messages, data })));
  return { body, params: [...h.params] };
}

const answerCall = (turn: Turn) => turn.params.find((params) => systemTextOf(params).includes(CHUNK_TEXT)) ?? turn.params.at(-1)!;

function strict(extra: Record<string, unknown> = {}, mode = 'strict') {
  return { ragMode: mode, settings: { webSearch: false }, ...extra };
}

beforeEach(() => {
  for (const name of SWITCHES) saved[name] = process.env[name];
  saved.RAG_SYSTEM_PROMPT = process.env.RAG_SYSTEM_PROMPT;
  h.supabase.store.documents = [{ id: 'doc-1', filename: 'notes.md', created_at: '2026-01-01T00:00:00.000Z', content: null, metadata: {} }];
  h.supabase.store.document_chunks = [{ id: 'chunk-1', document_id: 'doc-1', metadata: null }];
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(contextRetrieval());
  h.state.deltas = ['A short answer.'];
  h.state.finishReason = 'stop';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved) as Array<[string, string | undefined]>) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetLanguageSettingsForTests();
  h.supabase.store.documents = [];
  h.supabase.store.document_chunks = [];
  vi.restoreAllMocks();
});

describe('chat route: the output cap (D-29, D-30, D-32)', () => {
  it('RAG_MAX_OUTPUT_TOKENS off: today\'s limit and no concise part in strict and balanced', async () => {
    for (const mode of ['strict', 'balanced']) {
      const call = answerCall(await ask({}, strict({}, mode)));
      expect(call.maxOutputTokens).toBe(4096);
      expect(systemTextOf(call)).toContain(CHUNK_TEXT);
      expect(systemTextOf(call)).not.toContain('[rule:concise]');
    }
  });

  it('700 in strict and balanced with knowledge context: min(today, 700) and the concise part', async () => {
    for (const mode of ['strict', 'balanced']) {
      const call = answerCall(await ask({ RAG_MAX_OUTPUT_TOKENS: '700' }, strict({}, mode)));
      expect(call.maxOutputTokens).toBe(700);
      expect(systemTextOf(call)).toContain('[rule:concise]');
    }
  });

  it('the cap never raises a lower limit', async () => {
    const call = answerCall(await ask({ RAG_MAX_OUTPUT_TOKENS: '9000' }, strict()));
    expect(call.maxOutputTokens).toBe(4096);
    expect(systemTextOf(call)).toContain('[rule:concise]');
  });

  it.each([
    ['a request with its own maxOutputTokens', strict({ settings: { webSearch: false, maxOutputTokens: 2000 } }), undefined],
    ['a flexible request', strict({}, 'flexible'), undefined],
    [
      'an approval continuation',
      strict(),
      [
        { role: 'user', content: 'Run the tool.' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'fakeTool', args: {} }] },
        { role: 'user', content: QUESTION },
      ],
    ],
  ] as const)('%s keeps today\'s limit and gets no concise part', async (_name, data, messages) => {
    const off = answerCall(await ask({}, data as Record<string, unknown>, messages as never));
    const on = answerCall(await ask({ RAG_MAX_OUTPUT_TOKENS: '700' }, data as Record<string, unknown>, messages as never));
    expect(on.maxOutputTokens).toBe(off.maxOutputTokens);
    expect(systemTextOf(on)).not.toContain('[rule:concise]');
  });

  it('a reasoning request keeps today\'s limit and gets no concise part', async () => {
    const data = strict({ settings: { webSearch: false, reasoning: { enabled: true, effort: 'low' } } });
    const off = answerCall(await ask({ NEXT_PUBLIC_REASONING_ENABLED: 'true' }, data));
    const on = answerCall(await ask({ NEXT_PUBLIC_REASONING_ENABLED: 'true', RAG_MAX_OUTPUT_TOKENS: '700' }, data));
    expect(on.maxOutputTokens).toBe(off.maxOutputTokens);
    expect(systemTextOf(on)).not.toContain('[rule:concise]');
  });

  it('a request without knowledge-base context keeps today\'s limit', async () => {
    h.retrieval.mockResolvedValue(emptyRetrieval());
    const off = await ask({}, strict({}, 'balanced'));
    h.retrieval.mockResolvedValue(emptyRetrieval());
    const on = await ask({ RAG_MAX_OUTPUT_TOKENS: '700' }, strict({}, 'balanced'));
    expect(on.params.at(-1)!.maxOutputTokens).toBe(off.params.at(-1)!.maxOutputTokens);
    expect(systemTextOf(on.params.at(-1)!)).not.toContain('[rule:concise]');
  });

  it('a WhatsApp request in strict keeps its limit and gets the concise part', async () => {
    const data = strict({ chatId: 'whatsapp-0000', settings: { webSearch: false, maxOutputTokens: 4096 } });
    const off = answerCall(await ask({}, data));
    const on = answerCall(await ask({ RAG_MAX_OUTPUT_TOKENS: '700' }, data));
    expect(on.maxOutputTokens).toBe(off.maxOutputTokens);
    expect(systemTextOf(off)).not.toContain('[rule:concise]');
    expect(systemTextOf(on)).toContain('[rule:concise]');
  });

  it('the Claude path receives min(16384, 700) with the cap and 16384 without it', async () => {
    const claudeEnv = { RAG_CLAUDE_CITATIONS: 'true', ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, NEXT_PUBLIC_OPENROUTER_MODELS: MODELS } as const;
    const data = { ragMode: 'strict', settings: { model: CLAUDE_MODEL, webSearch: false }, capabilities: { citations: true } };
    const isClaude = (params: Record<string, any>) => typeof params.system === 'string' && params.system.includes(attachedDocumentsSentence('en'));
    const off = (await ask(claudeEnv, data)).params.find(isClaude);
    expect(off, 'the direct Claude call was made').toBeTruthy();
    expect(off!.maxOutputTokens).toBe(CLAUDE_MAX_OUTPUT_TOKENS);
    const on = (await ask({ ...claudeEnv, RAG_MAX_OUTPUT_TOKENS: '700' }, data)).params.find(isClaude);
    expect(on!.maxOutputTokens).toBe(Math.min(CLAUDE_MAX_OUTPUT_TOKENS, 700));
    expect(String(on!.system)).toContain('[rule:concise]');
  });
});

describe('chat route: the refusal is never cut with the cap on (D-31, D-62 e)', () => {
  const languagesOn = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' } as const;

  it.each(LANGUAGES)('%s: the server-side refusal for a verified empty result streams whole with the cap at the floor', async (code) => {
    h.retrieval.mockResolvedValue(emptyRetrieval());
    const turn = await ask(
      { RAG_MAX_OUTPUT_TOKENS: String(outputCapFloor()), RAG_REGISTRY_TEXTS: 'true', ...languagesOn },
      strict({ settings: { webSearch: false, language: 'en' } }),
      [{ role: 'user', content: QUESTIONS[code] }],
    );
    expect(streamedText(turn.body)).toBe(fixedText('notices.no_information', code));
  });

  it.each(LANGUAGES)('%s: a sentinel refusal streams whole when the model budget ends right after the token', async (code) => {
    h.state.deltas = [NO_ANSWER_SENTINEL];
    h.state.finishReason = 'length';
    const turn = await ask(
      { RAG_MAX_OUTPUT_TOKENS: String(outputCapFloor()), RAG_CONTEXT_RELEVANCE_RULE: 'true', ...languagesOn },
      strict({ settings: { webSearch: false, language: 'en' } }),
      [{ role: 'user', content: QUESTIONS[code] }],
    );
    expect(answerCall(turn).maxOutputTokens).toBe(outputCapFloor());
    expect(streamedText(turn.body)).toBe(fixedText('notices.no_information', code));
  });
});
