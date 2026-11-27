import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi, type MockInstance } from 'vitest';
import {
  DEFAULT_ROUTING_FAST_MODEL,
  DEFAULT_ROUTING_QUALITY_MODEL,
  OPTIONAL_STAGES,
  PROFILE_STAGE_DEFAULTS,
  loadRagConfig,
  resetRagConfigForTests,
  scopeGateEnabledFor,
  type RagEnvInput,
} from '@/lib/rag/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LatencyBudgetsSchema } from '@/lib/rag-eval/contracts.generated';
import { parseRunConfig, RUN_CONFIG_ENV_ALLOWLIST, RunConfigError } from '../../eval/harness/run-config.mts';

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  resetRagConfigForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const LAYER_ON: RagEnvInput = { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' };

/** The twelve D-28 variables, each set to its non-default value. */
const ALL_ON: RagEnvInput = {
  RAG_QUERY_DECOMPOSE_COMPLETENESS: 'true',
  RAG_QUERY_SUBQ_FILTERS: 'true',
  RAG_DECOMPOSED_ANSWER: 'true',
  RAG_TRANSLATION_GLOSSARY: 'true',
  RAG_LANGID_SIDECAR: 'true',
  RAG_MODEL_ROUTING: 'auto',
  RAG_ROUTING_FAST_MODEL: 'synthetic/fast-model',
  RAG_ROUTING_QUALITY_MODEL: 'synthetic/quality-model',
  RAG_SPECULATIVE_RETRIEVAL: 'true',
  RAG_QUERY_HISTORY_FALLBACK: 'true',
  RAG_WHATSAPP_HISTORY: 'true',
  RAG_SCOPE_GATE: 'true',
};

const D28_NAMES = Object.keys(ALL_ON);

const OFF_SWITCHES = {
  completeness: false,
  subqFilters: false,
  decomposedAnswer: false,
  translationGlossary: false,
  langidSidecar: false,
  speculativeRetrieval: false,
  historyFallback: false,
  scopeGate: false,
};

function queryLayerWarnings(): string[] {
  return warn.mock.calls.filter((call) => String(call[0]).includes('[Query Layer]')).map((call) => String(call[0]));
}

describe('query additions switches (D-28)', () => {
  test('raw defaults: completeness, decomposed answer and history fallback on; the rest off; routing off with the D-35 ids', () => {
    const config = loadRagConfig({});
    expect(config.queryAdditions.raw).toEqual({
      completeness: true,
      subqFilters: false,
      decomposedAnswer: true,
      translationGlossary: false,
      langidSidecar: false,
      speculativeRetrieval: false,
      historyFallback: true,
      scopeGate: false,
    });
    expect(config.queryAdditions.whatsappHistory).toBe(false);
    expect(config.modelRouting).toEqual({
      requestedMode: 'off',
      mode: 'off',
      fastModel: DEFAULT_ROUTING_FAST_MODEL,
      qualityModel: DEFAULT_ROUTING_QUALITY_MODEL,
    });
    expect(DEFAULT_ROUTING_FAST_MODEL).toBe('anthropic/claude-haiku-5.5');
    expect(DEFAULT_ROUTING_QUALITY_MODEL).toBe('anthropic/claude-sonnet-5.5');
    expect(config.warnings).toEqual([]);
  });

  test('every effective switch is off while the layer is off or the pipeline is legacy, even when set to true', () => {
    for (const env of [{}, { RAG_PIPELINE: 'v2' }, { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'false' }, { RAG_PIPELINE: 'legacy', RAG_QUERY_LAYER: 'true' }]) {
      resetRagConfigForTests();
      const config = loadRagConfig({ ...env, ...ALL_ON });
      expect(config.queryAdditions.effective).toEqual(OFF_SWITCHES);
      expect(config.modelRouting.mode).toBe('off');
      expect(config.modelRouting.requestedMode).toBe('auto');
      expect(config.disabledStages.has('scope_gate')).toBe(true);
    }
  });

  test('under v2 with the layer on the effective values follow the raw values', () => {
    const defaults = loadRagConfig(LAYER_ON);
    expect(defaults.queryAdditions.effective).toEqual({ ...OFF_SWITCHES, completeness: true, decomposedAnswer: true, historyFallback: true });
    expect(defaults.disabledStages.has('scope_gate')).toBe(true);
    const on = loadRagConfig({ ...LAYER_ON, ...ALL_ON });
    expect(Object.values(on.queryAdditions.effective).every(Boolean)).toBe(true);
    expect(on.modelRouting).toEqual({ requestedMode: 'auto', mode: 'auto', fastModel: 'synthetic/fast-model', qualityModel: 'synthetic/quality-model' });
    expect(on.disabledStages.has('scope_gate')).toBe(false);
  });

  test('RAG_WHATSAPP_HISTORY follows only its own variable (D-24)', () => {
    expect(loadRagConfig({ RAG_WHATSAPP_HISTORY: 'true' }).queryAdditions.whatsappHistory).toBe(true);
    expect(loadRagConfig({ RAG_PIPELINE: 'legacy', RAG_WHATSAPP_HISTORY: 'true' }).queryAdditions.whatsappHistory).toBe(true);
    expect(loadRagConfig({ ...LAYER_ON, RAG_WHATSAPP_HISTORY: 'false' }).queryAdditions.whatsappHistory).toBe(false);
  });

  test('an unknown value warns once and uses the default; RAG_MODEL_ROUTING accepts off and auto only', () => {
    const env = { ...LAYER_ON, RAG_SCOPE_GATE: 'maybe', RAG_QUERY_HISTORY_FALLBACK: 'maybe', RAG_MODEL_ROUTING: 'always' };
    const first = loadRagConfig(env);
    resetRagConfigForTests();
    warn.mockClear();
    loadRagConfig(env);
    loadRagConfig({ ...env, RAG_RERANK_TIER_CHAT: 'quality' });
    expect(first.queryAdditions.raw.scopeGate).toBe(false);
    expect(first.queryAdditions.raw.historyFallback).toBe(true);
    expect(first.modelRouting.mode).toBe('off');
    expect(queryLayerWarnings()).toHaveLength(3);
    expect(queryLayerWarnings().join(' ')).not.toContain('maybe');
  });

  test('an invalid routing model id warns and keeps the default', () => {
    const config = loadRagConfig({ RAG_ROUTING_FAST_MODEL: 'bad id with spaces', RAG_ROUTING_QUALITY_MODEL: '' });
    expect(config.modelRouting.fastModel).toBe(DEFAULT_ROUTING_FAST_MODEL);
    expect(config.modelRouting.qualityModel).toBe(DEFAULT_ROUTING_QUALITY_MODEL);
    expect(queryLayerWarnings()).toHaveLength(1);
  });

  test('changing any of the twelve variables changes the memo key', () => {
    const base = loadRagConfig(LAYER_ON);
    for (const name of D28_NAMES) {
      const changed = loadRagConfig({ ...LAYER_ON, [name]: (ALL_ON as Record<string, string>)[name] });
      expect(changed, name).not.toBe(base);
    }
  });
});

describe('scope_gate stage (D-26, D-29)', () => {
  test('scope_gate is an optional stage with chat, embed and eval timeouts and none in voice', () => {
    expect((OPTIONAL_STAGES as readonly string[]).includes('scope_gate')).toBe(true);
    expect(PROFILE_STAGE_DEFAULTS.chat.scope_gate).toBe(20);
    expect(PROFILE_STAGE_DEFAULTS.embed.scope_gate).toBe(20);
    expect(PROFILE_STAGE_DEFAULTS.eval.scope_gate).toBe(60000);
    expect(PROFILE_STAGE_DEFAULTS.voice.scope_gate).toBeUndefined();
  });

  test('voice never runs scope_gate, whatever RAG_SCOPE_GATE says', () => {
    const config = loadRagConfig({ ...LAYER_ON, RAG_SCOPE_GATE: 'true' });
    expect(scopeGateEnabledFor(config, 'voice')).toBe(false);
    for (const profile of ['chat', 'embed', 'eval'] as const) expect(scopeGateEnabledFor(config, profile)).toBe(true);
    const off = loadRagConfig(LAYER_ON);
    for (const profile of ['chat', 'embed', 'eval', 'voice'] as const) expect(scopeGateEnabledFor(off, profile)).toBe(false);
    const listed = loadRagConfig({ ...LAYER_ON, RAG_SCOPE_GATE: 'true', RAG_DISABLED_STAGES: 'scope_gate' });
    expect(scopeGateEnabledFor(listed, 'chat')).toBe(false);
  });
});

describe('voice translate timeout (D-16)', () => {
  test('the voice profile translate timeout is 250 ms while the query layer serves the slot; Phase 4 keeps 300 ms', () => {
    expect(loadRagConfig(LAYER_ON).timeouts.voice.translate).toBe(250);
    expect(loadRagConfig({ RAG_PIPELINE: 'v2' }).timeouts.voice.translate).toBe(300);
    expect(loadRagConfig({ ...LAYER_ON, RAG_STAGE_TIMEOUTS: 'voice.translate=200' }).timeouts.voice.translate).toBe(200);
  });
});

describe('eval run-config allowlist (D-10, D-16)', () => {
  test('run configs may set the twelve variables and RAG_QUERY_VOICE_TRANSFORMS', () => {
    for (const name of [...D28_NAMES, 'RAG_QUERY_VOICE_TRANSFORMS']) expect(RUN_CONFIG_ENV_ALLOWLIST, name).toContain(name);
    const parsed = parseRunConfig({ name: 'q62-all-on', env: { ...ALL_ON, RAG_QUERY_VOICE_TRANSFORMS: 'condense_history,normalize_dates,translate' } }, 'test');
    expect(Object.keys(parsed.env).sort()).toEqual([...D28_NAMES, 'RAG_QUERY_VOICE_TRANSFORMS'].sort());
  });

  test('an enumerated switch must carry a value the app accepts, and other new names stay rejected', () => {
    expect(() => parseRunConfig({ name: 'bad-value', env: { RAG_SCOPE_GATE: 'maybe' } }, 'test')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'bad-route', env: { RAG_MODEL_ROUTING: 'always' } }, 'test')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'unknown', env: { RAG_SCOPE_GATE_THRESHOLD: '0.5' } }, 'test')).toThrow(RunConfigError);
    expect(RUN_CONFIG_ENV_ALLOWLIST).not.toContain('RAG_SCOPE_GATE_THRESHOLD');
  });
});

describe('Phase 6.2 type extensions (P-32)', () => {
  test('existing objects stay valid and the new optional fields carry the generated types', () => {
    type RunInput = import('@/lib/rag/types').RunRetrievalInput;
    type Variant = import('@/lib/rag/types').QueryVariant;
    type Block = import('@/lib/rag/types').ContextBlock;
    type Result = import('@/lib/rag/types').RetrievalResult;
    expectTypeOf<RunInput['uiLanguage']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RunInput['previousStandaloneQuery']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<RunInput['previousTurnLanguage']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Variant['filters']>().toEqualTypeOf<import('@/lib/rag/backend/types').RetrievalFilters | undefined>();
    expectTypeOf<Variant['filterApplied']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Block['subQuestionIndexes']>().toEqualTypeOf<number[] | undefined>();
    expectTypeOf<Result['scopeGate']>().toEqualTypeOf<import('@/lib/rag-eval/contracts.generated').ScopeGateResult | undefined>();
    expectTypeOf<Result['searchesCounted']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Result['speculative']>().toEqualTypeOf<import('@/lib/rag/types').SpeculativeTrace | undefined>();
    expectTypeOf<'out_of_scope'>().toExtend<import('@/lib/rag/types').RetrievalSkipReason>();
    expectTypeOf<'small_talk'>().toExtend<import('@/lib/rag/types').RetrievalSkipReason>();
    expectTypeOf<Result['skipReason']>().toEqualTypeOf<import('@/lib/rag/types').RetrievalSkipReason | undefined>();

    const variant: Variant = {
      text: 'synthetic follow-up',
      language: null,
      kind: 'history_fallback',
      filters: { currentOnly: true, docTypes: ['general'] },
      filterApplied: true,
    };
    const phase6: Result = {
      status: 'empty',
      reason: 'no_candidates',
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
      traceId: 'trace-synthetic',
      queryContext: null,
    };
    expect(variant.kind).toBe('history_fallback');
    expect(phase6.scopeGate).toBeUndefined();
  });
});

describe('committed params and budgets (D-17, D-20, D-29)', () => {
  test('query-params.json holds the four Phase 6.2 keys at the QueryParams defaults', () => {
    const params = JSON.parse(readFileSync(join(process.cwd(), 'eval/config/query-params.json'), 'utf8'));
    expect(params).toMatchObject({
      language_confidence_threshold: 0.6,
      routing_fast_max_context_tokens: 2000,
      subq_filter_vocab_cap: 20,
      langid_timeout_ms: 30,
    });
  });

  test('latency-budgets.json carries a report-only scope_gate budget for chat and embed and none for voice', () => {
    const budgets = LatencyBudgetsSchema.parse(JSON.parse(readFileSync(join(process.cwd(), 'eval/config/latency-budgets.json'), 'utf8')));
    for (const profile of ['chat', 'embed'] as const) {
      expect(budgets.profiles[profile]?.stages.scope_gate).toBe(5);
      expect(budgets.profiles[profile]?.groups.scope_gate).toEqual({ p50_ms: 2, p95_ms: 5 });
    }
    expect(budgets.profiles.voice?.stages).not.toHaveProperty('scope_gate');
  });
});
