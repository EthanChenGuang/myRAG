import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { QueryPlanSchema } from '@/lib/rag-eval/contracts.generated';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, Profile } from '@/lib/rag/types';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);

const HISTORY: HistoryTurn[] = [
  { role: 'user', content: '网关日志里出现了 ERR_TIMEOUT 错误。' },
  { role: 'assistant', content: 'ERR_TIMEOUT 表示上游服务在规定时间内没有响应。' },
];
const FOLLOW_UP = '那个 ERR_TIMEOUT 怎么修？';
const CONDENSED = '网关日志中的 ERR_TIMEOUT 错误怎么修复？';
const LOST_TOKEN = '网关日志中的超时错误怎么修复？';
const STANDALONE = 'How do I configure the retry interval of the sample gateway service?';

function table(entries: FakeQueryLlmEntry[]) {
  return { version: 1 as const, entries };
}

function install(entries: FakeQueryLlmEntry[]) {
  const fake = createFakeQueryLlm({ table: table(entries) });
  const prompts: string[] = [];
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      prompts.push(request.prompt);
      return fake.generate(request);
    },
  };
  setRagDepsForTests({ queryLlm: () => llm });
  return { fake, prompts };
}

function layerConfig(over: Record<string, string> = {}) {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', ...over });
}

async function run(query: string, options: { history?: HistoryTurn[]; profile?: Profile } = {}) {
  const profile = options.profile ?? 'eval';
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const signal = new AbortController().signal;
  const out = await runQueryStages({
    input: { scope, query, profile, signal, ...(options.history ? { history: options.history } : {}) },
    scope,
    config: layerConfig(),
    profile,
    signal,
    collector,
  });
  const stage = (name: string) => collector.stages().find((row) => row.name === name);
  return { out, stage };
}

describe('native condense through the v2 query stage', () => {
  beforeEach(() => {
    uninstallDeps();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    vi.restoreAllMocks();
  });

  it('turns a follow-up into the scripted standalone query with the protected code verbatim', async () => {
    const { fake, prompts } = install([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: false } }]);
    const { out, stage } = await run(FOLLOW_UP, { history: HISTORY });

    const plan = out.queryLayer?.plan;
    expect(plan).toBeTruthy();
    expect(QueryPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan?.gate.reasons).toEqual(expect.arrayContaining(['R1_PRONOUN', 'R4_EXACT_CODE']));
    expect(plan?.gate.protected_tokens).toContain('ERR_TIMEOUT');
    expect(plan?.standalone).toBe(CONDENSED);
    expect(plan?.skipped).toEqual([]);
    expect(out.variants.map((variant) => [variant.kind, variant.text])).toEqual([
      ['original', FOLLOW_UP],
      ['condensed', CONDENSED],
    ]);
    expect(fake.calls).toEqual([{ transform: 'condense', input: FOLLOW_UP }]);
    expect(stage('query_gate')?.status).toBe('ok');
    expect(stage('condense')?.status).toBe('ok');

    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('rewrite the message to be a standalone question that captures all relevant context');
    expect(prompt).toContain('<conversation>');
    expect(prompt).toContain(HISTORY[1]!.content);
    expect(prompt).toContain('["ERR_TIMEOUT"]');
    expect(prompt).toContain('Chinese');
  });

  it('discards a rewrite that loses a protected token and searches the original only', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: LOST_TOKEN, unchanged: false } }]);
    const { out, stage } = await run(FOLLOW_UP, { history: HISTORY });

    const plan = out.queryLayer?.plan;
    expect(plan?.standalone).toBe(FOLLOW_UP);
    expect(plan?.skipped).toEqual([{ transform: 'condense_history', reason: 'protected_token_lost' }]);
    expect(out.variants).toEqual([expect.objectContaining({ kind: 'original', text: FOLLOW_UP })]);
    expect(stage('condense')?.status).toBe('ok');
    expect(stage('condense')?.detail).toBe('discarded=protected_token_lost');
  });

  it('passes a standalone question through without calling the query LLM', async () => {
    const { fake } = install([{ transform: 'condense', query: STANDALONE, output: { standalone: CONDENSED, unchanged: false } }]);
    const { out, stage } = await run(STANDALONE, { history: HISTORY });

    expect(out.queryLayer?.plan?.gate.transforms).not.toContain('condense_history');
    expect(out.queryLayer?.plan?.standalone).toBe(STANDALONE);
    expect(out.variants).toEqual([expect.objectContaining({ kind: 'original', text: STANDALONE })]);
    expect(fake.calls).toEqual([]);
    expect(stage('query_gate')?.status).toBe('ok');
    expect(stage('condense')).toBeUndefined();
  });

  it('treats an unchanged answer from the model as a pass-through', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: true } }]);
    const { out, stage } = await run(FOLLOW_UP, { history: HISTORY });
    expect(out.queryLayer?.plan?.standalone).toBe(FOLLOW_UP);
    expect(out.variants).toHaveLength(1);
    expect(stage('condense')?.detail).toBe('pass_through');
  });

  it('skips a failing query LLM with reason error and keeps the original', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, fail: 'error' }]);
    const { out, stage } = await run(FOLLOW_UP, { history: HISTORY });
    expect(out.queryLayer?.plan?.skipped).toEqual([{ transform: 'condense_history', reason: 'error' }]);
    expect(out.variants).toEqual([expect.objectContaining({ kind: 'original', text: FOLLOW_UP })]);
    expect(stage('condense')?.status).toBe('skipped');
  });

  it('skips a 2 s condense at the 600 ms chat timeout and still retrieves the original', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, delay_ms: 2000, output: { standalone: CONDENSED, unchanged: false } }]);
    const started = Date.now();
    const { out, stage } = await run(FOLLOW_UP, { history: HISTORY, profile: 'chat' });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1500);
    expect(stage('condense')?.status).toBe('skipped');
    expect(stage('condense')?.reason).toBe('timeout');
    expect(out.queryLayer?.plan?.skipped).toEqual([{ transform: 'condense_history', reason: 'timeout' }]);
    expect(out.variants).toEqual([expect.objectContaining({ kind: 'original', text: FOLLOW_UP })]);
  });

  it('does not run condense when the eval request switches it off', async () => {
    const { fake } = install([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: CONDENSED, unchanged: false } }]);
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const signal = new AbortController().signal;
    const out = await runQueryStages({
      input: { scope, query: FOLLOW_UP, profile: 'eval', signal, history: HISTORY },
      scope,
      config: layerConfig(),
      profile: 'eval',
      signal,
      collector,
      stageOverrides: { queryLayer: { transforms: { condense: false } } },
    });
    expect(fake.calls).toEqual([]);
    expect(collector.stages().find((row) => row.name === 'condense')?.status).toBe('disabled');
    expect(out.variants).toHaveLength(1);
  });
});
