import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalResult } from '@/lib/rag';
import { getLanguagePack } from '@/lib/rag/lang/registry';
import { chatRequest, emptyRetrieval, installChatPipeline, readSse } from '../helpers/chat-route-fakes';
import { systemTextOf } from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runRetrieval: vi.fn(), next: { overlay: {} as Record<string, unknown> } };
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
const ENV_NAMES = ['RAG_PIPELINE', 'RAG_QUERY_LAYER', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE', 'EXA_API_KEY'] as const;
let saved: Record<string, string | undefined>;

const QUESTION = 'Which colour do the sample widgets have?';

const QUERY_CONTEXT = {
  isTemporalQuery: false,
  isFinancialQuery: false,
  isSpecificDataQuery: false,
  requiredPrecision: 'low',
  suggestedThreshold: 0.3,
  reasoningText: 'stub',
  financialMetrics: [],
  searchStrategy: 'semantic_only',
  timeframe: null,
  requireTemporalMatch: false,
};

function gate(label: 'in_scope' | 'out_of_scope' | 'unsure') {
  return {
    label,
    score: 0.12,
    negative_score: 0.4,
    reason: label === 'out_of_scope' ? 'below_threshold' : label === 'in_scope' ? 'above_threshold' : 'within_margin',
    centroid_count: 4,
    latency_ms: 1,
  };
}

function plan(language = 'en') {
  return {
    original: QUESTION,
    standalone: QUESTION,
    language,
    gate: { rewrite: false, transforms: [], reasons: [], lang: language, protected_tokens: [], skip_retrieval: false },
    date_range: null,
    framework: 'llamaindex',
  };
}

function scopeResult(label: 'in_scope' | 'out_of_scope' | 'unsure', language = 'en'): RetrievalResult {
  const base = {
    status: 'empty',
    reason: 'no_results',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: true,
    stages: [],
    traceId: 'trace-stub',
    queryContext: QUERY_CONTEXT,
    refusal: null,
    queryLanguage: language,
    queryPlan: plan(language),
    scopeGate: gate(label),
  };
  return (label === 'out_of_scope' ? { ...base, reason: 'out_of_scope', skipReason: 'out_of_scope' } : base) as unknown as RetrievalResult;
}

function packTexts(code: string): { notice: string | null; rule: string | null } {
  const texts = getLanguagePack(code)?.texts.query_layer;
  return { notice: texts?.scope_gate_notice ?? null, rule: texts?.scope_gate_prompt_rule ?? null };
}

interface SseChunk {
  type?: string;
  delta?: string;
  messageMetadata?: Record<string, unknown>;
}

function parseSse(body: string): SseChunk[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload !== '' && payload !== '[DONE]')
    .flatMap((payload) => {
      try {
        return [JSON.parse(payload) as SseChunk];
      } catch {
        return [];
      }
    });
}

function text(chunks: SseChunk[]): string {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta ?? '').join('');
}

function finishRag(chunks: SseChunk[]): Record<string, unknown> | undefined {
  return chunks.find((chunk) => chunk.type === 'finish')?.messageMetadata?.rag as Record<string, unknown> | undefined;
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    h.runRetrieval.mockImplementation(async () => h.next.overlay.result);
    return { ...actual, runRetrieval: h.runRetrieval };
  });
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

async function post(result: RetrievalResult, data: Record<string, unknown>) {
  h.next.overlay.result = result;
  const { POST } = await loadRoute();
  const response = await POST(chatRequest({ messages: [{ role: 'user', content: QUESTION }], data }));
  return parseSse(await readSse(response));
}

function system(): string {
  return systemTextOf(h.capture.streamText.mock.calls[0][0] as Record<string, unknown>);
}

describe('chat route answers for out_of_scope turns (D-26, P-05)', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.RAG_PIPELINE = 'v2';
    env.RAG_QUERY_LAYER = 'true';
    env.RAG_SUPPORTED_LANGUAGES = 'en,zh,it';
    env.RAG_PRIMARY_LANGUAGE = 'en';
    h.capture.reset();
    h.exa.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(emptyRetrieval());
    h.runRetrieval.mockReset();
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

  it('the three packs carry a neutral notice and prompt sentence without placeholders', () => {
    for (const code of ['zh', 'en', 'it']) {
      const { notice, rule } = packTexts(code);
      expect(typeof notice).toBe('string');
      expect(typeof rule).toBe('string');
      expect(`${notice}${rule}`).not.toMatch(/[{}]/);
    }
  });

  it('strict with webSearch off: the existing information-not-available response, no model call, no label', async () => {
    const outOfScope = await post(scopeResult('out_of_scope'), { ragMode: 'strict', settings: { webSearch: false } });
    expect(h.capture.streamText).not.toHaveBeenCalled();
    const empty = await post(scopeResult('unsure'), { ragMode: 'strict', settings: { webSearch: false } });
    expect(text(outOfScope)).toContain('Information Not Available');
    expect(text(outOfScope)).toBe(text(empty));
    expect(JSON.stringify(outOfScope)).not.toContain('scopeGate');
  });

  it('strict with webSearch on: the model gets the Exa webSearch tool as today and no notice', async () => {
    env.EXA_API_KEY = 'test-exa-key-placeholder';
    const chunks = await post(scopeResult('out_of_scope'), { ragMode: 'strict', settings: { webSearch: true } });
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.capture.calls[0].tools ?? {})).toContain('webSearch');
    expect(text(chunks)).not.toContain('Information Not Available');
    const { notice, rule } = packTexts('en');
    expect(notice).not.toBeNull();
    expect(text(chunks)).not.toContain(notice as string);
    expect(system()).not.toContain(rule as string);
  });

  it.each(['balanced', 'flexible'])('%s: the answer starts with the localized notice, rag.scopeGate is the label only, the prompt says not to repeat it', async (ragMode) => {
    h.capture.setDeltas(['A general answer.']);
    const chunks = await post(scopeResult('out_of_scope'), { ragMode, settings: { webSearch: false } });
    const { notice, rule } = packTexts('en');
    expect(notice).not.toBeNull();
    const firstText = chunks.find((chunk) => chunk.type === 'text-delta');
    expect(firstText?.delta?.startsWith(notice as string)).toBe(true);
    expect(text(chunks).endsWith('A general answer.')).toBe(true);
    const rag = finishRag(chunks);
    expect(rag?.scopeGate).toBe('out_of_scope');
    expect(JSON.stringify(chunks)).not.toContain('negative_score');
    expect(system()).toContain(rule as string);
  });

  it('balanced: the notice follows the answer language of the plan', async () => {
    const chunks = await post(scopeResult('out_of_scope', 'it'), { ragMode: 'balanced', settings: { webSearch: false } });
    const { notice } = packTexts('it');
    expect(notice).not.toBeNull();
    expect(text(chunks).startsWith(notice as string)).toBe(true);
  });

  it.each(['unsure', 'in_scope'] as const)('balanced, %s: no notice, no rule and no scopeGate metadata', async (label) => {
    const chunks = await post(scopeResult(label), { ragMode: 'balanced', settings: { webSearch: false } });
    const { notice, rule } = packTexts('en');
    expect(text(chunks)).toBe('ok');
    if (notice) expect(text(chunks)).not.toContain(notice);
    if (rule) expect(system()).not.toContain(rule);
    expect(finishRag(chunks)?.scopeGate).toBeUndefined();
  });
});
