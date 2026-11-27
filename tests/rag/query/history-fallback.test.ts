import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { getRagDeps, setRagDepsForTests } from '@/lib/rag/deps';
import * as historyFallback from '@/lib/rag/query/history-fallback';
import type { SkippedTransform } from '@/lib/rag/query/plan';
import { runQueryLayer } from '@/lib/rag/query/run-layer';
import { buildQueryVariantSet, queryLayerVariantLimits } from '@/lib/rag/query/variants';
import { QueryPlanSchema } from '@/lib/rag-eval/contracts.generated';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, Profile, QueryVariant } from '@/lib/rag/types';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const build = (input: Parameters<typeof historyFallback.buildHistoryFallbackVariant>[0]) => {
  expect(typeof historyFallback.buildHistoryFallbackVariant).toBe('function');
  return historyFallback.buildHistoryFallbackVariant(input);
};

const scope = mintScope('single', null, null);
const NOW = Date.parse('2026-06-15T12:00:00Z');

const PREVIOUS_USER = 'Tell me about the sample gateway service.';
const HISTORY: HistoryTurn[] = [
  { role: 'user', content: PREVIOUS_USER },
  { role: 'assistant', content: 'The sample gateway service routes synthetic requests between modules.' },
];
const FOLLOW_UP = 'What does it log?';
const STORED_STANDALONE = 'Which modules does the sample gateway service route between?';
const PROTECTED_FOLLOW_UP = 'Does the ZQ-41 build log it?';

const GATE = { transforms: ['condense_history'] as const };
const LIMITS = { variantMaxChars: 500 };

function skippedCondense(reason: SkippedTransform['reason']): SkippedTransform[] {
  return [{ transform: 'condense_history', reason }];
}

describe('buildHistoryFallbackVariant (D-23)', () => {
  it.each(['timeout', 'error', 'aborted', 'protected_token_lost'] as const)('condense skipped with %s yields previous + newline + follow-up', (reason) => {
    const text = build({
      gate: { transforms: [...GATE.transforms] },
      skipped: skippedCondense(reason),
      previousStandalone: null,
      previousUserText: PREVIOUS_USER,
      followUp: FOLLOW_UP,
      limits: LIMITS,
    });
    expect(text).toBe(`${PREVIOUS_USER}\n${FOLLOW_UP}`);
  });

  it.each(['length', 'cap', 'disabled_for_profile', 'glossary_term_lost'] as const)('condense skipped with %s yields none', (reason) => {
    const text = build({
      gate: { transforms: [...GATE.transforms] },
      skipped: skippedCondense(reason),
      previousStandalone: STORED_STANDALONE,
      previousUserText: PREVIOUS_USER,
      followUp: FOLLOW_UP,
      limits: LIMITS,
    });
    expect(text).toBeNull();
  });

  it('a skip of another transform, or a gate that did not ask for condense_history, yields none', () => {
    const base = { previousStandalone: STORED_STANDALONE, previousUserText: PREVIOUS_USER, followUp: FOLLOW_UP, limits: LIMITS };
    expect(build({ ...base, gate: { transforms: ['condense_history'] }, skipped: [{ transform: 'expand', reason: 'timeout' }] })).toBeNull();
    expect(build({ ...base, gate: { transforms: ['expand'] }, skipped: skippedCondense('timeout') })).toBeNull();
  });

  it('the stored previous standalone query wins over the previous user text; with neither there is no variant', () => {
    const base = { gate: { transforms: ['condense_history' as const] }, skipped: skippedCondense('timeout'), followUp: FOLLOW_UP, limits: LIMITS };
    expect(build({ ...base, previousStandalone: STORED_STANDALONE, previousUserText: PREVIOUS_USER })).toBe(`${STORED_STANDALONE}\n${FOLLOW_UP}`);
    expect(build({ ...base, previousStandalone: '   ', previousUserText: PREVIOUS_USER })).toBe(`${PREVIOUS_USER}\n${FOLLOW_UP}`);
    expect(build({ ...base, previousStandalone: null, previousUserText: null })).toBeNull();
    expect(build({ ...base, previousStandalone: undefined, previousUserText: '  ' })).toBeNull();
  });

  it('a variant longer than variant_max_chars keeps the whole follow-up and cuts the previous text; no room means none', () => {
    const previous = 'synthetic context word '.repeat(40).trim();
    const text = build({
      gate: { transforms: ['condense_history'] },
      skipped: skippedCondense('error'),
      previousStandalone: previous,
      previousUserText: null,
      followUp: FOLLOW_UP,
      limits: { variantMaxChars: 120 },
    });
    expect(text).not.toBeNull();
    expect(Array.from(text ?? '').length).toBeLessThanOrEqual(120);
    expect(text?.endsWith(`\n${FOLLOW_UP}`)).toBe(true);
    expect(previous.startsWith(text?.split('\n')[0] ?? '-')).toBe(true);

    expect(
      build({
        gate: { transforms: ['condense_history'] },
        skipped: skippedCondense('error'),
        previousStandalone: previous,
        previousUserText: null,
        followUp: FOLLOW_UP,
        limits: { variantMaxChars: FOLLOW_UP.length + 1 },
      }),
    ).toBeNull();
  });

  it('a previous text equal to the follow-up adds nothing', () => {
    const text = build({
      gate: { transforms: ['condense_history'] },
      skipped: skippedCondense('timeout'),
      previousStandalone: ` ${FOLLOW_UP} `,
      previousUserText: null,
      followUp: FOLLOW_UP,
      limits: LIMITS,
    });
    expect(text).toBeNull();
  });
});

describe('history_fallback against the D-08 limits', () => {
  const fallback: QueryVariant = { text: `${PREVIOUS_USER}\n${FOLLOW_UP}`, language: 'en', kind: 'history_fallback' };
  const expanded = (text: string): QueryVariant => ({ text, language: 'en', kind: 'expanded' });

  it('is not an LLM variant: two expansions already present, the fallback is still searched', () => {
    const limits = queryLayerVariantLimits({ max_searches: 8, max_translations: 2, max_sub_questions: 4, max_llm_variants: 2 });
    const { variants, cuts } = buildQueryVariantSet(FOLLOW_UP, 'en', [], [expanded('synthetic one'), expanded('synthetic two'), fallback], limits);
    expect(variants.map((variant) => variant.kind)).toEqual(['original', 'history_fallback', 'expanded', 'expanded']);
    expect(cuts).toEqual([]);
  });

  it('counts toward max_searches: at the cap it is dropped with reason cap', () => {
    const limits = queryLayerVariantLimits({ max_searches: 1, max_translations: 2, max_sub_questions: 4, max_llm_variants: 2 });
    const { variants, cuts } = buildQueryVariantSet(FOLLOW_UP, 'en', [], [fallback], limits);
    expect(variants.map((variant) => variant.kind)).toEqual(['original']);
    expect(cuts).toEqual([{ transform: 'condense_history', reason: 'cap' }]);
  });
});

function install(entries: FakeQueryLlmEntry[]) {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  setRagDepsForTests({ queryLlm: () => fake, now: () => NOW });
  return fake;
}

interface RunOptions {
  history?: HistoryTurn[];
  previousStandaloneQuery?: string;
  env?: Record<string, string>;
  profile?: Profile;
}

async function run(query: string, options: RunOptions = {}) {
  const profile = options.profile ?? 'chat';
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const signal = new AbortController().signal;
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', ...options.env });
  const out = await runQueryLayer({
    input: {
      scope,
      query,
      profile,
      signal,
      ...(options.history ? { history: options.history } : {}),
      ...(options.previousStandaloneQuery ? { previousStandaloneQuery: options.previousStandaloneQuery } : {}),
    },
    config,
    profile,
    signal,
    collector,
  });
  return { out, stages: collector.stages() };
}

const kinds = (variants: readonly { kind: string }[] | undefined) => (variants ?? []).map((variant) => variant.kind);

describe('runQueryLayer: the history_fallback variant (D-22, D-23)', () => {
  beforeEach(() => {
    uninstallDeps();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a condense error adds the fallback right after the original, in the plan and in the searched variants', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, fail: 'error' }]);
    const { out } = await run(FOLLOW_UP, { history: HISTORY });

    expect(out.plan?.skipped).toEqual(expect.arrayContaining([{ transform: 'condense_history', reason: 'error' }]));
    expect(kinds(out.plan?.variants)).toEqual(['original', 'history_fallback']);
    expect(out.plan?.variants?.[1]).toMatchObject({ text: `${PREVIOUS_USER}\n${FOLLOW_UP}`, language: 'en', protected_ok: true });
    expect(out.plan?.standalone).toBe(FOLLOW_UP);
    expect(QueryPlanSchema.safeParse(out.plan).success).toBe(true);
    expect(out.variants.map((variant) => [variant.kind, variant.text, variant.legs])).toEqual([
      ['original', FOLLOW_UP, 'both'],
      ['history_fallback', `${PREVIOUS_USER}\n${FOLLOW_UP}`, 'both'],
    ]);
  });

  it('a condense timeout uses the stored previous standalone query', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, delay_ms: 1500, output: { standalone: STORED_STANDALONE, unchanged: false, language: null } }]);
    const { out, stages } = await run(FOLLOW_UP, { history: HISTORY, previousStandaloneQuery: STORED_STANDALONE });

    expect(stages.find((row) => row.name === 'condense')?.reason).toBe('timeout');
    expect(out.plan?.skipped).toEqual(expect.arrayContaining([{ transform: 'condense_history', reason: 'timeout' }]));
    expect(out.plan?.variants?.find((variant) => variant.kind === 'history_fallback')?.text).toBe(`${STORED_STANDALONE}\n${FOLLOW_UP}`);
  });

  it('a condensed query that lost a protected token adds the fallback', async () => {
    install([{ transform: 'condense', query: PROTECTED_FOLLOW_UP, output: { standalone: 'Does the sample gateway build log it?', unchanged: false, language: null } }]);
    const { out } = await run(PROTECTED_FOLLOW_UP, { history: HISTORY });

    expect(out.plan?.skipped).toEqual(expect.arrayContaining([{ transform: 'condense_history', reason: 'protected_token_lost' }]));
    expect(out.plan?.variants?.find((variant) => variant.kind === 'history_fallback')?.text).toBe(`${PREVIOUS_USER}\n${PROTECTED_FOLLOW_UP}`);
  });

  it('a condense that ran adds no fallback', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, output: { standalone: 'What does the sample gateway service log?', unchanged: false, language: null } }]);
    const { out } = await run(FOLLOW_UP, { history: HISTORY });
    expect(kinds(out.plan?.variants)).toEqual(['original', 'condensed']);
  });

  it('RAG_QUERY_HISTORY_FALLBACK=false keeps the Phase 6 plan', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, fail: 'error' }]);
    const { out } = await run(FOLLOW_UP, { history: HISTORY, env: { RAG_QUERY_HISTORY_FALLBACK: 'false' } });
    expect(kinds(out.plan?.variants)).toEqual(['original']);
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original']);
  });

  it('voice gets the fallback when it sends history', async () => {
    install([{ transform: 'condense', query: FOLLOW_UP, fail: 'error' }]);
    const { out } = await run(FOLLOW_UP, { history: HISTORY, profile: 'voice' });
    expect(kinds(out.plan?.variants)).toEqual(['original', 'history_fallback']);
  });

  it('the default ragEnv reads RAG_QUERY_HISTORY_FALLBACK from the process environment', () => {
    vi.stubEnv('RAG_QUERY_HISTORY_FALLBACK', 'false');
    expect(getRagDeps().ragEnv().RAG_QUERY_HISTORY_FALLBACK).toBe('false');
  });
});
