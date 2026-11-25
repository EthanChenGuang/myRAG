import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import type { QueryClassification } from '@/lib/query-classifier';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { runQueryLayer } from '@/lib/rag/query/run-layer';
import { QueryPlanSchema } from '@/lib/rag-eval/contracts.generated';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, Profile, StageOverrides } from '@/lib/rag/types';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const NOW = Date.parse('2026-06-15T12:00:00Z');

const HISTORY: HistoryTurn[] = [
  { role: 'user', content: 'Tell me about the sample gateway service.' },
  { role: 'assistant', content: 'The sample gateway service routes synthetic requests between modules.' },
];

const COMPARISON_ZH = 'A 和 B 有什么区别？';
const SHORT_ZH = '日志';
const SHORT_EN = 'gateway logs';
const FOLLOW_UP_DATES = 'What changed in it last year?';
const FOLLOW_UP_KEYWORDS = 'its logs';
const FOLLOW_UP_COMPARE = 'Compare it with the alpha module';

function install(entries: FakeQueryLlmEntry[]) {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const prompts: Array<{ transform: string; prompt: string }> = [];
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      prompts.push({ transform: request.transform, prompt: request.prompt });
      return fake.generate(request);
    },
  };
  setRagDepsForTests({ queryLlm: () => llm, now: () => NOW });
  return { fake, prompts };
}

function config(over: Record<string, string> = {}) {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', ...over });
}

interface RunOptions {
  history?: HistoryTurn[];
  profile?: Profile;
  env?: Record<string, string>;
  classification?: QueryClassification;
  stageOverrides?: StageOverrides;
}

async function run(query: string, options: RunOptions = {}) {
  const profile = options.profile ?? 'chat';
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const signal = new AbortController().signal;
  const out = await runQueryLayer({
    input: {
      scope,
      query,
      profile,
      signal,
      ...(options.history ? { history: options.history } : {}),
      ...(options.classification ? { classification: options.classification } : {}),
      ...(options.stageOverrides ? { stageOverrides: options.stageOverrides } : {}),
    },
    config: config(options.env),
    profile,
    signal,
    collector,
    stageOverrides: options.stageOverrides,
  });
  const stages = collector.stages();
  const stage = (name: string) => stages.find((row) => row.name === name);
  return { out, stages, stage };
}

function classified(category: QueryClassification['category'], needsMcp: boolean): QueryClassification {
  return { category, needsMcp, confidence: 0.9, reasoningText: 'synthetic' };
}

describe('runQueryLayer: router, parallel group and native transforms', () => {
  beforeEach(() => {
    uninstallDeps();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('a comparison runs decompose only and searches the sub-questions after the original', async () => {
    const { fake } = install([{ transform: 'decompose', query: COMPARISON_ZH, output: { questions: ['A 是什么？', 'B 是什么？'] } }]);
    const { out, stage } = await run(COMPARISON_ZH);

    expect(fake.calls).toEqual([{ transform: 'decompose', input: COMPARISON_ZH }]);
    expect(stage('decompose')?.status).toBe('ok');
    expect(stage('expand')).toBeUndefined();
    expect(stage('condense')).toBeUndefined();
    expect(out.plan?.sub_questions).toEqual(['A 是什么？', 'B 是什么？']);
    expect(out.variants.map((variant) => [variant.kind, variant.text, variant.subQuestionIndex])).toEqual([
      ['original', COMPARISON_ZH, undefined],
      ['sub_question', 'A 是什么？', 0],
      ['sub_question', 'B 是什么？', 1],
    ]);
  });

  it('a short keyword query runs expand only, asked for the full LLM-variant budget of 2', async () => {
    const { fake, prompts } = install([{ transform: 'expand', query: SHORT_ZH, output: { queries: ['系统日志在哪里查看', '日志配置说明'] } }]);
    const { out, stage } = await run(SHORT_ZH);

    expect(fake.calls).toEqual([{ transform: 'expand', input: SHORT_ZH }]);
    expect(prompts[0]?.prompt).toContain('Generate 2 search queries');
    expect(stage('expand')?.status).toBe('ok');
    expect(stage('hyde')?.status).toBe('disabled');
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original', 'expanded', 'expanded']);
    expect(out.variants[0]?.text).toBe(SHORT_ZH);
  });

  it('a follow-up with a relative date runs condense, then normalize_dates, and narrows the dates', async () => {
    const condensed = 'What changed in the sample gateway service last year?';
    const { fake } = install([{ transform: 'condense', query: FOLLOW_UP_DATES, output: { standalone: condensed, unchanged: false } }]);
    const { out, stages } = await run(FOLLOW_UP_DATES, { history: HISTORY });

    expect(fake.calls).toEqual([{ transform: 'condense', input: FOLLOW_UP_DATES }]);
    const names = stages.map((row) => row.name);
    expect(names.indexOf('query_gate')).toBeLessThan(names.indexOf('condense'));
    expect(names.indexOf('condense')).toBeLessThan(names.indexOf('normalize_dates'));
    expect(stages.find((row) => row.name === 'normalize_dates')?.status).toBe('ok');
    expect(out.dateRange).toMatchObject({ from: '2025-01-01', to: '2025-12-31', includeUndated: true });
    expect(out.plan?.date_range).toEqual({ from_date: '2025-01-01', to_date: '2025-12-31', include_undated: true, time_zone: 'UTC' });
    expect(out.plan?.standalone).toBe(condensed);
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original', 'condensed']);
  });

  it('with a condensed query and HyDE on, expand gets no budget and makes no call', async () => {
    const condensed = 'Where are the logs of the sample gateway service?';
    const { fake } = install([
      { transform: 'condense', query: FOLLOW_UP_KEYWORDS, output: { standalone: condensed, unchanged: false } },
      { transform: 'hyde', query: condensed, output: { passage: 'The sample gateway service writes its logs to a synthetic directory.' } },
      { transform: 'expand', query: condensed, output: { queries: ['synthetic expansion one', 'synthetic expansion two'] } },
    ]);
    const { out } = await run(FOLLOW_UP_KEYWORDS, { history: HISTORY, env: { RAG_QUERY_HYDE: 'true' } });

    expect(fake.calls.map((call) => call.transform)).toEqual(['condense', 'hyde']);
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original', 'condensed', 'hyde']);
    expect(out.plan?.skipped).toContainEqual({ transform: 'expand', reason: 'cap' });
  });

  it('a tool-required classification runs no transform; multi_step adds decompose', async () => {
    const tool = install([]);
    const toolRun = await run(SHORT_EN, { classification: classified('tool_required', true) });
    expect(tool.fake.calls).toEqual([]);
    expect(toolRun.stage('expand')?.status).toBe('disabled');
    expect(toolRun.out.variants.map((variant) => variant.kind)).toEqual(['original']);

    const multi = install([
      { transform: 'expand', query: SHORT_EN, output: { queries: ['synthetic expansion one'] } },
      { transform: 'decompose', query: SHORT_EN, output: { questions: ['synthetic part one', 'synthetic part two'] } },
    ]);
    const multiRun = await run(SHORT_EN, { classification: classified('multi_step', false) });
    expect(multi.fake.calls.map((call) => call.transform).sort()).toEqual(['decompose', 'expand']);
    expect(multiRun.stage('decompose')?.status).toBe('ok');
  });

  it('voice runs only condense and normalize_dates, natively, even with the LangChain framework', async () => {
    const condensed = 'Compare the sample gateway service with the alpha module';
    const { fake } = install([
      { transform: 'condense', query: FOLLOW_UP_COMPARE, output: { standalone: condensed, unchanged: false } },
      { transform: 'expand', query: condensed, output: { queries: ['synthetic expansion one'] } },
      { transform: 'decompose', query: condensed, output: { questions: ['synthetic part one', 'synthetic part two'] } },
    ]);
    const { out, stage } = await run(FOLLOW_UP_COMPARE, {
      profile: 'voice',
      history: HISTORY,
      env: { RAG_QUERY_FRAMEWORK: 'langchain', RAG_QUERY_HYDE: 'true' },
    });

    expect(fake.calls.map((call) => call.transform)).toEqual(['condense']);
    expect(out.plan?.framework).toBe('llamaindex');
    expect(stage('condense')?.status).toBe('ok');
    for (const name of ['expand', 'hyde', 'decompose']) expect(stage(name)?.status).toBe('disabled');
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original', 'condensed']);
  });

  it('the plan validates against QueryPlanSchema and lists skipped transforms with reasons', async () => {
    install([
      { transform: 'condense', query: FOLLOW_UP_COMPARE, fail: 'error' },
      { transform: 'expand', query: FOLLOW_UP_COMPARE, fail: 'invalid' },
      { transform: 'decompose', query: FOLLOW_UP_COMPARE, output: { questions: ['synthetic part one', 'synthetic part two'] } },
    ]);
    const { out, stage } = await run(FOLLOW_UP_COMPARE, { history: HISTORY });

    expect(QueryPlanSchema.safeParse(out.plan).success).toBe(true);
    expect(out.plan?.variants?.[0]).toMatchObject({ kind: 'original', text: FOLLOW_UP_COMPARE });
    expect(out.plan?.skipped).toEqual(
      expect.arrayContaining([
        { transform: 'condense_history', reason: 'error' },
        { transform: 'expand', reason: 'error' },
      ]),
    );
    expect(stage('condense')?.status).toBe('skipped');
    expect(stage('expand')?.status).toBe('skipped');
    expect(stage('decompose')?.status).toBe('ok');
  });

  it('an eval override switches expand off for the eval profile and is ignored for chat', async () => {
    const entries: FakeQueryLlmEntry[] = [{ transform: 'expand', query: SHORT_EN, output: { queries: ['synthetic expansion one'] } }];
    const overrides: StageOverrides = { queryLayer: { transforms: { expand: false } } };

    const evalFake = install(entries);
    const evalRun = await run(SHORT_EN, { profile: 'eval', stageOverrides: overrides });
    expect(evalFake.fake.calls).toEqual([]);
    expect(evalRun.stage('expand')?.status).toBe('disabled');
    expect(evalRun.out.variants.map((variant) => variant.kind)).toEqual(['original']);

    const chatFake = install(entries);
    const chatRun = await run(SHORT_EN, { profile: 'chat', stageOverrides: overrides });
    expect(chatFake.fake.calls).toEqual([{ transform: 'expand', input: SHORT_EN }]);
    expect(chatRun.stage('expand')?.status).toBe('ok');
  });

  it('an eval override can switch HyDE on although the environment leaves it off', async () => {
    const { fake } = install([{ transform: 'expand', query: SHORT_EN, output: { queries: [] } }]);
    const { stage } = await run(SHORT_EN, { profile: 'eval', stageOverrides: { queryLayer: { transforms: { hyde: true } } } });
    expect(fake.calls.map((call) => call.transform).sort()).toEqual(['expand', 'hyde']);
    expect(stage('hyde')?.status).toBe('ok');
  });

  it('small talk short-circuits under the layer with no transform call', async () => {
    const { fake } = install([]);
    const { out } = await run('hello');
    expect(fake.calls).toEqual([]);
    expect(out.shortCircuit).toEqual({ kind: 'small_talk' });
    expect(out.plan?.gate.skip_retrieval).toBe(true);
  });
});
