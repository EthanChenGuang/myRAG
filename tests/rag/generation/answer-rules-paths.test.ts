import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';
import { FAKE_ANTHROPIC_KEY } from '../../helpers/fake-anthropic';
import { systemTextOf } from '../../helpers/route-fixture';
import { REFERENCE_NOTICE, OUTPUT_POLICY_NOTICE } from '@/lib/rag/context/wrap';
import { attachedDocumentsSentence, citationInstruction } from '@/lib/rag/generation/citations/instructions';
import { NO_ANSWER_SENTINEL } from '@/lib/rag/generation/sentinel';
import { composeAnswerRules } from '@/lib/rag/generation/answer-rules';
import { readAnswerConfig } from '@/lib/rag/generation/answer-config';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
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
vi.mock('@/lib/rag/generation/answer-finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/answer-finish')>()),
  scheduleAnswerFinish: () => {},
}));

const SWITCHES = [
  'RAG_PARTIAL_ANSWER_RULE',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_OUTPUT_GUARD',
  'RAG_VERSION_LABELS',
  'RAG_CITATIONS',
  'RAG_CLAUDE_CITATIONS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'NEXT_PUBLIC_OPENROUTER_MODELS',
  'RAG_CONTEXT_TAGGING',
  'EXA_API_KEY',
] as const;
type SwitchName = (typeof SWITCHES)[number];
const saved: Partial<Record<SwitchName, string | undefined>> = {};

const RULES_ON = { RAG_PARTIAL_ANSWER_RULE: 'true', RAG_CONTEXT_RELEVANCE_RULE: 'true' } as const;
const CLAUDE_MODEL = 'anthropic/claude-sonnet-5.5';
const MODELS = JSON.stringify([{ id: CLAUDE_MODEL, displayName: 'Claude Sonnet 5.5', anthropicId: 'claude-sonnet-5-5' }]);
const ADMIN_PROMPT_HEAD = 'You are a careful assistant for a synthetic test.';
const QUESTION = 'What is the value of the second item in the list?';
const CHUNK_TEXT = 'The second item in the list has the value B.';

function setEnv(values: Partial<Record<SwitchName, string>>): void {
  for (const name of SWITCHES) delete process.env[name];
  Object.assign(process.env, { RAG_SYSTEM_PROMPT: `${ADMIN_PROMPT_HEAD}\n\nContext:\n{{context}}` }, values);
}

async function ask(
  values: Partial<Record<SwitchName, string>>,
  data: Record<string, unknown>,
): Promise<Array<Record<string, any>>> {
  setEnv(values);
  h.capture.reset();
  vi.resetModules();
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/chat/route');
  await readSse(await POST(chatRequest({ messages: [{ role: 'user', content: QUESTION }], data })));
  return [...h.capture.calls];
}

function strictWeb(extra: Record<string, unknown> = {}, mode = 'strict') {
  return { ragMode: mode, settings: { webSearch: false }, capabilities: { citations: true }, ...extra };
}

beforeEach(() => {
  for (const name of SWITCHES) saved[name] = process.env[name];
  saved.RAG_SYSTEM_PROMPT = process.env.RAG_SYSTEM_PROMPT;
  h.supabase.store.documents = [{ id: 'doc-1', filename: 'notes.md', created_at: '2026-01-01T00:00:00.000Z', content: null, metadata: {} }];
  h.supabase.store.document_chunks = [{ id: 'chunk-1', document_id: 'doc-1', metadata: null }];
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(
    retrievalWith([
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
    ]),
  );
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
  h.supabase.store.documents = [];
  h.supabase.store.document_chunks = [];
  vi.restoreAllMocks();
});

describe('chat route: the answer-rule block (D-04, D-07)', () => {
  it.each(['strict', 'balanced', 'flexible'])('%s: the prompt with every switch off equals the on-prompt without its block', async (mode) => {
    const [offCall] = await ask({ RAG_CITATIONS: 'true' }, strictWeb({}, mode));
    const off = systemTextOf(offCall!);
    expect(off).not.toContain('[rule:');
    expect(off).toContain(CHUNK_TEXT);

    const on = { RAG_CITATIONS: 'true', ...RULES_ON, RAG_OUTPUT_GUARD: 'flag' } as const;
    const [onCall] = await ask(on, strictWeb({}, mode));
    const composed = systemTextOf(onCall!);
    const added = composeAnswerRules({
      prompt: '',
      mode,
      language: null,
      config: readAnswerConfig(on),
      channel: 'web',
      webSearchOffered: false,
      capApplies: false,
      calcOffered: false,
      contextTagging: false,
    }, { log: false });
    expect(added.startsWith('\n\n[rule:')).toBe(true);
    expect(composed.split(added)).toHaveLength(2);
    expect(composed.replace(added, '')).toBe(off);
  });

  it('strict with the rule switches on: admin prompt with context, then the citation instruction, then relevance and partial answer', async () => {
    const [call] = await ask({ RAG_CITATIONS: 'true', ...RULES_ON }, strictWeb());
    const system = systemTextOf(call!);
    const context = system.indexOf(CHUNK_TEXT);
    const citation = system.indexOf(citationInstruction('en'));
    const relevance = system.indexOf('[rule:relevance]');
    const partial = system.indexOf('[rule:partial_answer]');
    expect(system.indexOf(ADMIN_PROMPT_HEAD)).toBeGreaterThanOrEqual(0);
    expect(system.indexOf(ADMIN_PROMPT_HEAD)).toBeLessThan(citation);
    expect(context).toBeGreaterThanOrEqual(0);
    expect(context).toBeLessThan(citation);
    expect(citation).toBeLessThan(relevance);
    expect(relevance).toBeLessThan(partial);
    expect(system).not.toContain('{{context}}');
    expect(system).toContain(NO_ANSWER_SENTINEL);
    expect(system.split('[rule:relevance]').length - 1).toBe(1);
    expect(system).not.toContain('[rule:web_separation]');
  });

  it('strict with webSearch offered: the web variant and the separation rule', async () => {
    const [call] = await ask(
      { RAG_CITATIONS: 'true', ...RULES_ON, EXA_API_KEY: 'test-exa-key-placeholder' },
      strictWeb({ settings: { webSearch: true } }),
    );
    const system = systemTextOf(call!);
    expect(system).toContain('[rule:web_separation]');
    expect(system.indexOf('[rule:partial_answer]')).toBeLessThan(system.indexOf('[rule:web_separation]'));
  });

  it('balanced gets relevance_open and general_knowledge, never the partial-answer rule', async () => {
    const [call] = await ask({ RAG_CITATIONS: 'true', ...RULES_ON }, strictWeb({}, 'balanced'));
    const system = systemTextOf(call!);
    expect(system).toContain('[rule:relevance]');
    expect(system).toContain('[rule:general_knowledge]');
    expect(system).not.toContain('[rule:partial_answer]');
    expect(system).not.toContain(NO_ANSWER_SENTINEL);
  });

  it('logs one [Answer Rules] line with part ids only', async () => {
    await ask({ RAG_CITATIONS: 'true', ...RULES_ON }, strictWeb());
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((args) => args[0] === '[Answer Rules]');
    expect(lines).toEqual([['[Answer Rules]', { parts: ['relevance', 'partial_answer'], mode: 'strict', channel: 'web' }]]);
  });

  it('a WhatsApp request gets the block without any citation instruction', async () => {
    const [call] = await ask({ RAG_CITATIONS: 'true', ...RULES_ON }, { ragMode: 'strict', chatId: 'whatsapp-0000', settings: { webSearch: false } });
    const system = systemTextOf(call!);
    expect(system).toContain('[rule:relevance]');
    expect(system).toContain('[rule:partial_answer]');
    expect(system).not.toContain(citationInstruction('en'));
  });

  it('the Claude path: attached-documents sentence, the Phase 5.1 notice, then the composed block', async () => {
    const calls = await ask(
      {
        RAG_CLAUDE_CITATIONS: 'true',
        ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
        NEXT_PUBLIC_OPENROUTER_MODELS: MODELS,
        RAG_CONTEXT_TAGGING: 'true',
        RAG_OUTPUT_GUARD: 'enforce',
        ...RULES_ON,
      },
      { ragMode: 'strict', settings: { model: CLAUDE_MODEL, webSearch: false }, capabilities: { citations: true } },
    );
    const claude = calls.find((call) => typeof call.system === 'string' && call.system.includes(attachedDocumentsSentence('en')));
    expect(claude, 'the direct Claude call was made').toBeTruthy();
    const first = String(claude!.system);
    const sentence = first.indexOf(attachedDocumentsSentence('en'));
    const notice = first.indexOf(REFERENCE_NOTICE);
    const relevance = first.indexOf('[rule:relevance]');
    const policy = first.indexOf(`[rule:output_policy]\n${OUTPUT_POLICY_NOTICE}`);
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(sentence);
    expect(sentence).toBeLessThan(relevance);
    expect(relevance).toBeLessThan(first.indexOf('[rule:partial_answer]'));
    expect(first.indexOf('[rule:partial_answer]')).toBeLessThan(policy);
    expect(first.split('[rule:relevance]').length - 1).toBe(1);
  });

  it('the Claude path with every switch off carries no rule part', async () => {
    const calls = await ask(
      { RAG_CLAUDE_CITATIONS: 'true', ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, NEXT_PUBLIC_OPENROUTER_MODELS: MODELS },
      { ragMode: 'strict', settings: { model: CLAUDE_MODEL, webSearch: false }, capabilities: { citations: true } },
    );
    const claude = calls.find((call) => typeof call.system === 'string' && call.system.includes(attachedDocumentsSentence('en')));
    expect(claude).toBeTruthy();
    expect(String(claude!.system)).not.toContain('[rule:');
  });
});
