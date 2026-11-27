import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { createCitationSession, type ContextBlock, type RetrievalResult } from '@/lib/rag';
import type { StageRecord } from '@/lib/rag/types';
import { buildEvalSystemPrompt } from '@/lib/rag-eval/answer';
import { fixedText } from '@/lib/rag/lang/texts';
import { chatRequest, emptyRetrieval, installChatPipeline, readSse } from '../helpers/chat-route-fakes';
import { systemTextOf } from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    runRetrieval: vi.fn(),
    finishTrace: vi.fn(),
    overlay: { value: null as Record<string, unknown> | null },
  };
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

const env = process.env as Record<string, string | undefined>;
const ENV_NAMES = [
  'RAG_QUERY_LAYER',
  'RAG_DECOMPOSED_ANSWER',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_EVAL_SECRET',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'NEXT_PUBLIC_OPENROUTER_MODELS',
] as const;
let saved: Record<string, string | undefined>;

const ORIGINAL = 'How do the alpha module and the beta module compare?';
const SUB_A = 'What does the alpha module do?';
const SUB_B = 'What does the beta module do?';
const TEXT_A = 'The alpha module sorts the incoming records.';
const TEXT_B = 'The beta module archives the sorted records.';

function block(index: number, text: string, subQuestionIndexes?: number[], alias: string | null = null): ContextBlock {
  return {
    documentId: `doc-${index}`,
    documentName: `module-${index}.md`,
    documentVersion: 1,
    chunkIds: [`chunk-${index}`],
    page: null,
    sectionPath: null,
    title: `module-${index}.md`,
    text,
    isImage: false,
    alias,
    ...(subQuestionIndexes ? { subQuestionIndexes } : {}),
  };
}

function plan(subQuestions: string[], reasons: string[] = ['R6_COMPOUND']) {
  return {
    original: ORIGINAL,
    standalone: ORIGINAL,
    language: 'en',
    gate: { rewrite: true, transforms: ['decompose'], reasons, lang: 'en', protected_tokens: [], skip_retrieval: false },
    date_range: null,
    sub_questions: subQuestions,
    framework: 'llamaindex',
  };
}

function knowledgeOverlay(options: { subQuestions?: string[]; blocks?: ContextBlock[]; reasons?: string[] } = {}) {
  const blocks = options.blocks ?? [block(1, TEXT_A, [0]), block(2, TEXT_B, [1])];
  return {
    status: 'ok',
    reason: 'ok',
    context: blocks.map((entry) => entry.text).join('\n\n'),
    blocks,
    usedDocuments: blocks.map((entry) => ({ id: entry.documentId, name: entry.documentName, filename: entry.documentName, similarity: 0.8 })),
    queryPlan: plan(options.subQuestions ?? [SUB_A, SUB_B], options.reasons),
    refusalCandidate: false,
  };
}

async function loadChatRoute() {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    h.runRetrieval.mockImplementation(async (input: Parameters<typeof actual.runRetrieval>[0]) => {
      const result = await actual.runRetrieval(input);
      return h.overlay.value ? { ...result, ...h.overlay.value } : result;
    });
    h.finishTrace.mockImplementation(() => undefined);
    return { ...actual, runRetrieval: h.runRetrieval, finishTrace: h.finishTrace };
  });
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

async function chatSystem(data: Record<string, unknown> = { ragMode: 'balanced', settings: { webSearch: false } }): Promise<string> {
  const { POST } = await loadChatRoute();
  const response = await POST(chatRequest({ messages: [{ role: 'user', content: ORIGINAL }], data }));
  await readSse(response);
  expect(h.capture.streamText).toHaveBeenCalledTimes(1);
  return systemTextOf(h.capture.streamText.mock.calls[0][0] as Record<string, unknown>);
}

function tracedStages(): StageRecord[] {
  const calls = h.finishTrace.mock.calls;
  if (calls.length === 0) return [];
  const collector = calls[calls.length - 1][0] as { stages: () => StageRecord[] };
  return collector.stages();
}

describe('GEN-13 decomposed answers at the entry points (D-11, D-12)', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.RAG_QUERY_LAYER = 'true';
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(emptyRetrieval());
    h.runRetrieval.mockReset();
    h.finishTrace.mockReset();
    h.overlay.value = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.restoreAllMocks();
  });

  it('chat: a question with two sub-questions gets the localized per-part block in the system prompt', async () => {
    h.overlay.value = knowledgeOverlay();
    const system = await chatSystem();
    expect(system).toContain('Answer structure');
    expect(system).toContain(`1. ${SUB_A}`);
    expect(system).toContain(`2. ${SUB_B}`);
    expect(system.indexOf('Answer structure')).toBeGreaterThan(system.indexOf(TEXT_B));
  });

  it('chat: a sub-question without a supporting block is named with the GEN-08 text', async () => {
    h.overlay.value = knowledgeOverlay({ blocks: [block(1, TEXT_A, [0]), block(2, TEXT_B, [0])] });
    const system = await chatSystem();
    expect(system).toContain(`2. ${SUB_B} “${fixedText('labels.not_covered', 'en')}”`);
    expect(system).not.toContain(`1. ${SUB_A} “`);
  });

  it('chat: the comparison order is added when the gate fired R3', async () => {
    h.overlay.value = knowledgeOverlay({ reasons: ['R3_COMPARISON'] });
    const system = await chatSystem();
    expect(system).toContain('add one section on the differences between them');
  });

  it('chat: switch off or a single sub-question leaves the prompt byte-identical to a plan without sub-questions', async () => {
    h.overlay.value = knowledgeOverlay({ subQuestions: [] });
    const baseline = await chatSystem();
    expect(baseline).not.toContain('Answer structure');

    h.capture.reset();
    h.overlay.value = knowledgeOverlay({ subQuestions: [SUB_A] });
    expect(await chatSystem()).toBe(baseline);

    h.capture.reset();
    env.RAG_DECOMPOSED_ANSWER = 'false';
    h.overlay.value = knowledgeOverlay();
    expect(await chatSystem()).toBe(baseline);
    expect(tracedStages().some((stage) => stage.name === 'answer_structure')).toBe(false);

    h.capture.reset();
    delete env.RAG_DECOMPOSED_ANSWER;
    env.RAG_QUERY_LAYER = 'false';
    expect(await chatSystem()).toBe(baseline);
  });

  it('chat: answer_structure is recorded on the trace after the answer; cited_parts is not measured without a labeller', async () => {
    h.overlay.value = knowledgeOverlay({ blocks: [block(1, TEXT_A, [0]), block(2, TEXT_B, [0])] });
    h.capture.setDeltas([`1. ${TEXT_A}\n`, `2. ${fixedText('labels.not_covered', 'en')}`]);
    await chatSystem();
    const record = tracedStages().find((stage) => stage.name === 'answer_structure');
    expect(record).toBeDefined();
    expect(record?.counts).toEqual({ parts: 2, uncovered_parts: 1 });
    expect(record?.attributes).toEqual({ cited_parts_measured: false });
  });

  it('eval: buildEvalSystemPrompt appends the same block, and is unchanged without it', () => {
    const blocks = [block(1, TEXT_A, [0]), block(2, TEXT_B, [1])];
    const input = { subQuestions: [SUB_A, SUB_B], comparison: false, uncoveredIndexes: [], blocks, language: 'en', citationsActive: false };
    const context = blocks.map((entry) => entry.text).join('\n\n');
    const base = buildEvalSystemPrompt({ context, ragMode: 'strict' });
    const withBlock = buildEvalSystemPrompt({ context, ragMode: 'strict', decomposedAnswer: input } as Parameters<typeof buildEvalSystemPrompt>[0]);
    expect(withBlock.startsWith(base)).toBe(true);
    expect(withBlock).toContain(`1. ${SUB_A}`);
    expect(buildEvalSystemPrompt({ context, ragMode: 'strict', decomposedAnswer: { ...input, subQuestions: [SUB_A] } } as Parameters<typeof buildEvalSystemPrompt>[0])).toBe(base);
  });

  it('Claude Citations path: the block goes into claudeSystemPrompt and names documents by their order', () => {
    env.NEXT_PUBLIC_OPENROUTER_MODELS = JSON.stringify([
      { id: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', anthropicId: 'claude-sonnet-5-5' },
    ]);
    const session = createCitationSession({
      capabilities: { citations: true },
      ragMode: 'strict',
      modelId: 'anthropic/claude-sonnet-5.5',
      language: 'en',
      config: { citations: false, claudeCitations: true, anthropicApiKey: 'test-anthropic-key-placeholder' },
      facts: { mcp: false, multiStep: false, webSearch: false, reasoning: false },
    });
    const blocks = [block(1, TEXT_A, [1], 'S1'), block(2, TEXT_B, [0], 'S2'), block(3, TEXT_B, [0], 'S3')];
    session.attach({ blocks, links: [] });
    expect(session.strategy).toBe('claude-citations');
    const base = 'You are a helpful assistant.\n\nContext:\n{{context}}';
    const plain = session.claudeSystemPrompt(base);
    const claudeSystemPrompt = session.claudeSystemPrompt as (prompt: string, options?: Record<string, unknown>) => string;
    const decomposed = claudeSystemPrompt.call(session, base, {
      decomposedAnswer: { subQuestions: [SUB_A, SUB_B], comparison: false, uncoveredIndexes: [], blocks, language: 'en', citationsActive: true },
    });
    expect(decomposed.startsWith(plain)).toBe(true);
    expect(decomposed).toContain(`1. ${SUB_A} [2, 3]`);
    expect(decomposed).toContain(`2. ${SUB_B} [1]`);
    expect(decomposed).not.toContain('[S');
  });
});

describe('GEN-13 in the eval route (D-12)', () => {
  const SECRET = 'b'.repeat(48);

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.RAG_QUERY_LAYER = 'true';
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    const answer = await import('@/lib/rag-eval/answer');
    answer.setEvalLanguageModelFactory(null);
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function evalResult(overlay: Record<string, unknown>): RetrievalResult {
    return {
      status: 'ok',
      reason: 'ok',
      candidates: [],
      context: '',
      usedDocuments: [],
      sourceImages: [],
      links: [],
      relevantChunks: [],
      kept: [],
      queryTerms: [],
      refusalCandidate: false,
      stages: [],
      traceId: 'trace-stub',
      queryContext: {
        isTemporalQuery: false,
        isFinancialQuery: false,
        isSpecificDataQuery: false,
        requiredPrecision: 'low',
        suggestedThreshold: 0.3,
        reasoningText: 'stub',
        financialMetrics: [],
        searchStrategy: 'semantic_only',
      },
      refusal: null,
      queryLanguage: 'en',
      ...overlay,
    } as RetrievalResult;
  }

  async function runEval(overlay: Record<string, unknown>, answerText: string) {
    vi.resetModules();
    const systems: string[] = [];
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return { ...actual, runRetrieval: async () => evalResult(overlay) };
    });
    await installChatPipeline(h);
    const answer = await import('@/lib/rag-eval/answer');
    answer.setEvalLanguageModelFactory(
      () =>
        new MockLanguageModelV3({
          doGenerate: async (options) => {
            systems.push(
              options.prompt
                .filter((message) => message.role === 'system')
                .map((message) => (typeof message.content === 'string' ? message.content : ''))
                .join('\n\n'),
            );
            return {
              content: [{ type: 'text' as const, text: answerText }],
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
              warnings: [],
            };
          },
        }) as unknown as LanguageModel,
    );
    const route = await import('@/app/api/internal/rag/run/route');
    const response = await route.POST(
      new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
        body: JSON.stringify({ schema_version: 1, query: ORIGINAL, rag_mode: 'balanced', include_answer: true, options: { generator_model: 'test/eval-model' } }),
      }),
    );
    if (response.status !== 200) throw new Error(await response.text());
    return { trace: (await response.json()) as Record<string, unknown>, systems };
  }

  it('the eval answer prompt carries the block and the trace carries answer_structure', async () => {
    const { trace, systems } = await runEval(knowledgeOverlay(), `1. ${TEXT_A}\n2. ${TEXT_B}`);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain(`1. ${SUB_A}`);
    expect(trace.answer_structure).toEqual({ parts: 2, cited_parts: null, uncovered_parts: 0 });
  });

  it('not decomposed: no block and no answer_structure', async () => {
    const { trace, systems } = await runEval(knowledgeOverlay({ subQuestions: [] }), TEXT_A);
    expect(systems[0]).not.toContain('Answer structure');
    expect(trace).not.toHaveProperty('answer_structure');
  });
});
