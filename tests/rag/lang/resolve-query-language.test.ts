import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { resolveQueryLanguage, type ResolveQueryLanguageInput } from '@/lib/rag/lang/resolve-query-language';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { detectGateLanguage } from '@/lib/rag/query/gate-language';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { needsRewrite } from '@/lib/rag/query/rewrite-gate';
import { runQueryLayer } from '@/lib/rag/query/run-layer';
import { QueryPlanSchema } from '@/lib/rag-eval/contracts.generated';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, RunRetrievalInput } from '@/lib/rag/types';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const spies = vi.hoisted(() => ({ resolve: vi.fn(), shares: { value: null as Record<string, number> | null } }));

vi.mock('@/lib/rag/lang/resolve-query-language', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/lang/resolve-query-language')>();
  spies.resolve.mockImplementation(actual.resolveQueryLanguage);
  return { ...actual, resolveQueryLanguage: spies.resolve };
});

vi.mock('@/lib/rag/query/kb-languages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/query/kb-languages')>();
  return { ...actual, getKbLanguageShares: async () => spies.shares.value };
});

const PARAMS = { language_confidence_threshold: 0.6, langid_timeout_ms: 30 };
const ENABLED = ['zh', 'en', 'it'];

function resolve(text: string, over: Partial<ResolveQueryLanguageInput> = {}) {
  return resolveQueryLanguage({ text, enabled: ENABLED, primary: 'en', profile: 'chat', params: PARAMS, ...over });
}

describe('resolveQueryLanguage (D-17)', () => {
  it('one enabled language skips detection: that language, confidence 1, source single_language', async () => {
    const detection = await resolve('dove si trova il file di log del modulo', { enabled: ['en'], primary: 'en' });
    expect(detection).toEqual({ language: 'en', confidence: 1, source: 'single_language' });
  });

  it('a confident detection is the detector source with a confidence in [0, 1] at or above the threshold', async () => {
    const detection = await resolve('how do I reset the sample gateway to its defaults');
    expect(detection.source).toBe('detector');
    expect(detection.language).toBe('en');
    expect(detection.confidence).toBeGreaterThanOrEqual(0.6);
    expect(detection.confidence).toBeLessThanOrEqual(1);
  });

  it('chooses only among the enabled languages', async () => {
    const detection = await resolve('come si configura il modulo di prova', { enabled: ['zh', 'en'], primary: 'zh' });
    expect(detection.language).not.toBe('it');
    expect(['zh', 'en']).toContain(detection.language);
  });

  it('Han-dominant text is not short: two Han words are a confident detection', async () => {
    expect(await resolve('日志')).toMatchObject({ language: 'zh', source: 'detector', confidence: 1 });
  });

  it('three words or fewer are low confidence even with a stopword hit', async () => {
    expect((await resolve('the logs')).source).toBe('primary');
  });

  it('mixed scripts without a dominant one are low confidence', async () => {
    expect(await resolve('如何 配置 sample gateway', { previousTurnLanguage: 'zh' })).toMatchObject({ language: 'zh', source: 'previous_turn' });
  });

  it('code-dominated text is low confidence', async () => {
    const detection = await resolve('the config.yaml has sample_module.timeout and retry_limit=3 set', { uiLanguage: 'it' });
    expect(detection).toMatchObject({ language: 'it', source: 'ui_language' });
  });

  it('a detection under the threshold is low confidence', async () => {
    const detection = await resolve('what is the status of the modulo', { params: { ...PARAMS, language_confidence_threshold: 0.99 } });
    expect(detection.source).toBe('primary');
    expect(detection.confidence).toBeLessThan(0.99);
  });

  it('low confidence: the previous turn wins, then the UI language, then the primary language', async () => {
    expect(await resolve('gateway logs', { previousTurnLanguage: 'it', uiLanguage: 'zh' })).toMatchObject({ language: 'it', source: 'previous_turn' });
    expect(await resolve('gateway logs', { uiLanguage: 'zh' })).toMatchObject({ language: 'zh', source: 'ui_language' });
    expect(await resolve('gateway logs', { primary: 'it' })).toMatchObject({ language: 'it', source: 'primary' });
  });

  it('a hint naming a language outside the enabled list is skipped', async () => {
    expect(await resolve('gateway logs', { previousTurnLanguage: 'fr', uiLanguage: 'es' })).toMatchObject({ language: 'en', source: 'primary' });
    expect(await resolve('gateway logs', { enabled: ['zh', 'en'], uiLanguage: 'it' })).toMatchObject({ language: 'en', source: 'primary' });
  });

  it('a regional UI code counts by its primary subtag', async () => {
    expect(await resolve('gateway logs', { uiLanguage: 'zh-CN' })).toMatchObject({ language: 'zh', source: 'ui_language' });
  });

  it('every confident detection agrees with the gate language detector', async () => {
    const texts = [
      'how do I reset the sample gateway to its defaults',
      'where is the log file for this module',
      'come si configura il modulo di prova',
      'dove si trova il file di log del modulo',
      '这个示例模块的日志文件在哪里',
      '配置文件',
    ];
    for (const text of texts) {
      const detection = await resolve(text);
      expect(detection.source, text).toBe('detector');
      expect(detection.language, text).toBe(detectGateLanguage(text));
    }
  });
});

describe('needsRewrite language context (P-21)', () => {
  it('a resolved language replaces the gate detector; absent keeps it', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(needsRewrite('gateway logs', { hasHistory: false, now }).lang).toBe('en');
    expect(needsRewrite('gateway logs', { hasHistory: false, now, language: 'it' }).lang).toBe('it');
  });
});

const scope = mintScope('single', null, null);
const NOW = Date.parse('2026-06-15T12:00:00Z');
const HISTORY: HistoryTurn[] = [
  { role: 'user', content: 'Tell me about the sample gateway service.' },
  { role: 'assistant', content: 'The sample gateway service routes synthetic requests between modules.' },
];

function install(entries: FakeQueryLlmEntry[]) {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const requests: Array<{ transform: string; target?: string }> = [];
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      requests.push({ transform: request.transform, ...(request.targetLanguage ? { target: request.targetLanguage } : {}) });
      return fake.generate(request);
    },
  };
  setRagDepsForTests({ queryLlm: () => llm, now: () => NOW });
  return { fake, requests };
}

async function runLayer(query: string, input: Partial<RunRetrievalInput> = {}) {
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const signal = new AbortController().signal;
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true' });
  return runQueryLayer({ input: { scope, query, profile: 'chat', signal, ...input }, config, profile: 'chat', signal, collector, scope });
}

describe('runQueryLayer language resolution (D-17)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetLanguageSettingsForTests();
    spies.resolve.mockClear();
    spies.shares.value = null;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('resolves before the gate and traces the detection on the plan', async () => {
    install([]);
    const out = await runLayer('gateway logs', { previousTurnLanguage: 'it' });
    expect(spies.resolve).toHaveBeenCalledTimes(1);
    expect(out.plan?.gate.lang).toBe('it');
    expect(out.plan?.language_detection).toEqual({ language: 'it', confidence: 0, source: 'previous_turn' });
    expect(QueryPlanSchema.safeParse(out.plan).success).toBe(true);
  });

  it('a confident query keeps the gate language the detector would give', async () => {
    install([]);
    const query = 'how do I reset the sample gateway to its defaults';
    const out = await runLayer(query, { uiLanguage: 'zh' });
    expect(out.plan?.gate.lang).toBe(detectGateLanguage(query));
    expect(out.plan?.language_detection?.source).toBe('detector');
  });

  it('a condense output reporting an enabled language sets the answer language and translation targets, not the gate', async () => {
    spies.shares.value = { zh: 0.5, it: 0.4, en: 0.1 };
    const query = 'What does it weigh?';
    const standalone = 'What does the sample gateway weigh?';
    const { requests } = install([{ transform: 'condense', query, output: { standalone, unchanged: false, language: 'it' } }]);
    const out = await runLayer(query, { history: HISTORY });
    expect(out.plan?.gate.lang).toBe('en');
    expect(out.plan?.language).toBe('it');
    expect(out.plan?.language_detection?.source).toBe('llm');
    expect(requests.filter((request) => request.transform === 'translate').map((request) => request.target)).toEqual(['zh']);
  });

  it('a null or non-enabled reported language changes nothing', async () => {
    spies.shares.value = { zh: 0.5, it: 0.4, en: 0.1 };
    const query = 'What does it weigh?';
    const standalone = 'What does the sample gateway weigh?';
    const { requests } = install([{ transform: 'condense', query, output: { standalone, unchanged: false, language: null } }]);
    const out = await runLayer(query, { history: HISTORY });
    expect(out.plan?.language).toBe('en');
    expect(out.plan?.language_detection?.source).toBe('detector');
    expect(requests.filter((request) => request.transform === 'translate').map((request) => request.target)).toEqual(['zh', 'it']);
  });

  it('a translate output reporting its source language sets the answer language only', async () => {
    spies.shares.value = { zh: 0.9, en: 0.1 };
    const query = 'how do I reset the sample gateway to its defaults';
    install([
      { transform: 'translate', query, output: { target_language: 'zh', text: '如何将示例网关重置为默认值', source_language: 'it' } },
    ]);
    const out = await runLayer(query);
    expect(out.plan?.gate.lang).toBe('en');
    expect(out.plan?.language).toBe('it');
    expect(out.plan?.language_detection?.source).toBe('llm');
  });
});
