import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  CORE_STAGES,
  OPTIONAL_STAGES,
  PROFILE_STAGE_DEFAULTS,
  loadRagConfig,
  resetRagConfigForTests,
  resolveFinalResultCount,
  warnInjectionCheckDisabled,
} from '@/lib/rag/config';
import { loadIngestConfig, resetIngestConfigForTests } from '@/lib/rag/ingest/config';

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  resetRagConfigForTests();
  resetIngestConfigForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function configWarnings(): string[] {
  return warn.mock.calls
    .filter((call) => String(call[0]).includes('[RAG Config]'))
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
}

const CHAT_DEFAULTS = {
  refs: 5000,
  analyze: 1000,
  embed: 15000,
  search: 15000,
  fuse: 1000,
  legacy_rank: 2000,
  post_filter: 10000,
  assemble: 10000,
  exact_id_lookup: 1000,
  translate: 1000,
  dedupe: 1000,
  rerank: 600,
  refusal: 1000,
  expand_parents: 3000,
  compress: 1000,
  injection_check: 400,
};

describe('stage tables', () => {
  test('core and optional stage names include v2 stages', () => {
    expect([...CORE_STAGES]).toEqual(['embed', 'search', 'fuse']);
    expect([...OPTIONAL_STAGES]).toEqual([
      'refs',
      'analyze',
      'legacy_rank',
      'post_filter',
      'assemble',
      'voice_keyword_fallback',
      'local_rerank',
      'exact_id_lookup',
      'translate',
      'dedupe',
      'rerank',
      'refusal',
      'expand_parents',
      'compress',
      'injection_check',
    ]);
  });

  test('profile defaults match the Phase 4 latency table', () => {
    for (const profile of ['chat', 'embed', 'media'] as const) {
      expect(PROFILE_STAGE_DEFAULTS[profile]).toEqual(CHAT_DEFAULTS);
    }
    expect(PROFILE_STAGE_DEFAULTS.eval.rerank).toBe(60000);
    expect(PROFILE_STAGE_DEFAULTS.eval.expand_parents).toBe(10000);
    expect(PROFILE_STAGE_DEFAULTS.eval.injection_check).toBe(60000);
    expect(PROFILE_STAGE_DEFAULTS.voice.injection_check).toBe(1000);
    expect(PROFILE_STAGE_DEFAULTS.voice).toMatchObject({
      embed: 5000,
      rerank: 250,
      expand_parents: 1000,
      translate: 300,
    });
  });
});

describe('loadRagConfig', () => {
  test('empty values give legacy, v2 switch-off stages disabled and profile defaults', () => {
    const config = loadRagConfig({});
    expect(config.pipeline).toBe('legacy');
    expect([...config.disabledStages].sort()).toEqual(['compress', 'expand_parents', 'rerank', 'translate']);
    expect(config.timeouts.chat).toEqual(PROFILE_STAGE_DEFAULTS.chat);
    expect(config.v2.reranker).toBe('none');
    expect(config.v2.tokenBudget).toBe(6000);
    expect(config.warnings).toEqual([]);
  });

  test('RAG_PIPELINE=v2 selects v2; unknown values run legacy with one warning per value', () => {
    expect(loadRagConfig({ RAG_PIPELINE: 'v2' }).pipeline).toBe('v2');
    expect(loadRagConfig({ RAG_PIPELINE: 'v3' }).pipeline).toBe('legacy');
    expect(loadRagConfig({ RAG_PIPELINE: 'foo' }).pipeline).toBe('legacy');
    expect(configWarnings()).toHaveLength(2);
    for (let i = 0; i < 5; i += 1) loadRagConfig({ RAG_PIPELINE: 'foo' });
    expect(configWarnings()).toHaveLength(2);
  });

  test('legacy and blank pipeline values do not log', () => {
    loadRagConfig({ RAG_PIPELINE: 'legacy' });
    loadRagConfig({ RAG_PIPELINE: '  ' });
    expect(configWarnings()).toEqual([]);
  });

  test('optional stages can be disabled explicitly', () => {
    const config = loadRagConfig({ RAG_DISABLED_STAGES: 'legacy_rank, assemble' });
    expect([...config.disabledStages].sort()).toEqual(['assemble', 'compress', 'expand_parents', 'legacy_rank', 'rerank', 'translate']);
  });

  test('a core stage in the disabled list is dropped and logged once', () => {
    const env = { RAG_DISABLED_STAGES: 'embed,legacy_rank,search' };
    const config = loadRagConfig(env);
    expect([...config.disabledStages].sort()).toEqual(['compress', 'expand_parents', 'legacy_rank', 'rerank', 'translate']);
    expect(configWarnings()).toHaveLength(2);
  });

  test('rerank is a valid optional stage name in RAG_DISABLED_STAGES', () => {
    const config = loadRagConfig({ RAG_DISABLED_STAGES: 'rerank,post_filter' });
    expect([...config.disabledStages].sort()).toEqual(['compress', 'expand_parents', 'post_filter', 'rerank', 'translate']);
    expect(configWarnings()).toEqual([]);
  });

  test('timeout overrides apply to every profile; profile prefixes affect one profile only', () => {
    const config = loadRagConfig({ RAG_STAGE_TIMEOUTS: 'embed=2000,voice.rerank=200,rerank=400' });
    for (const profile of ['chat', 'embed', 'media', 'eval'] as const) {
      expect(config.timeouts[profile].embed).toBe(2000);
      expect(config.timeouts[profile].rerank).toBe(400);
    }
    expect(config.timeouts.voice.rerank).toBe(200);
    expect(config.timeouts.voice.embed).toBe(2000);
    expect(config.timeouts.chat.search).toBe(15000);
  });

  test('an unknown profile prefix in timeouts is dropped with a warning', () => {
    loadRagConfig({ RAG_STAGE_TIMEOUTS: 'nope.rerank=100' });
    expect(configWarnings().join(' ')).toContain('Unknown profile');
  });

  test('v2 switch parsers and invalid values fall back with warnings', () => {
    const config = loadRagConfig({
      RAG_RERANKER: 'bogus',
      RAG_CONTEXT_TOKEN_BUDGET: 'abc',
      RAG_EXACT_SCAN_CUTOFF: '200000',
      RAG_RERANK_VOYAGE_MODEL_BY_LANG: 'zh=rerank-2.5,it=rerank-3,de=bad',
    });
    expect(config.v2.reranker).toBe('none');
    expect(config.v2.tokenBudget).toBe(6000);
    expect(config.v2.exactScanCutoff).toBe(0);
    expect(config.v2.voyageModelByLang).toEqual({ zh: 'rerank-2.5', it: 'rerank-3' });
    expect(configWarnings().length).toBeGreaterThanOrEqual(3);
  });

  test('RAG_RETRIEVAL_PARAMS_OVERRIDE parses partial overrides and validates cap', () => {
    const config = loadRagConfig({
      RAG_RETRIEVAL_PARAMS_OVERRIDE: 'pool=50,cap=60,topk=10,cap=200,foo=1',
    });
    expect(config.v2.paramsOverride).toEqual({ candidate_pool_size: 50, rerank_input_cap: 60, final_top_k: 10 });
    expect(configWarnings().join(' ')).toMatch(/cap|foo/);
  });

  test('RAG_RERANKER=cohere removes rerank from disabledStages', () => {
    const config = loadRagConfig({ RAG_RERANKER: 'cohere' });
    expect(config.disabledStages.has('rerank')).toBe(false);
    expect([...config.disabledStages].sort()).toEqual(['compress', 'expand_parents', 'translate']);
  });

  test('hasCohereKey reflects presence only and warnings never echo the key', () => {
    const secret = 'cohere-test-key-not-real-32charsxxxxxxxx';
    const config = loadRagConfig({ COHERE_API_KEY: secret, RAG_RERANKER: 'bogus' });
    expect(config.v2.hasCohereKey).toBe(true);
    const blob = JSON.stringify(warn.mock.calls);
    expect(blob).not.toContain(secret);
  });

  test('flipping RAG_RERANKER between calls returns different configs after memo reset', () => {
    const a = loadRagConfig({ RAG_RERANKER: 'none' });
    const b = loadRagConfig({ RAG_RERANKER: 'cohere' });
    expect(a).not.toBe(b);
    expect(a.v2.reranker).toBe('none');
    expect(b.v2.reranker).toBe('cohere');
    resetRagConfigForTests();
    expect(loadRagConfig({ RAG_RERANKER: 'none' })).not.toBe(a);
  });

  test('the exact-id switch and stage timeout overrides still behave as before', () => {
    const config = loadRagConfig({ RAG_DISABLED_STAGES: 'exact_id_lookup', RAG_STAGE_TIMEOUTS: 'exact_id_lookup=250', RAG_EXACT_ID_LOOKUP: 'true' });
    expect([...config.disabledStages]).toContain('exact_id_lookup');
    expect(config.exactIdLookup).toBe(true);
    expect(config.timeouts.chat.exact_id_lookup).toBe(250);
  });

  test('identical env snapshots are memoised', () => {
    const env = { RAG_STAGE_TIMEOUTS: 'embed=2000', RAG_RERANKER: 'voyage' };
    expect(loadRagConfig(env)).toBe(loadRagConfig({ ...env }));
  });
});

describe('injection_check stage', () => {
  test('RAG_STAGE_TIMEOUTS accepts injection_check globally and per profile', () => {
    const config = loadRagConfig({ RAG_STAGE_TIMEOUTS: 'injection_check=50,voice.injection_check=700' });
    expect(config.timeouts.chat.injection_check).toBe(50);
    expect(config.timeouts.eval.injection_check).toBe(50);
    expect(config.timeouts.voice.injection_check).toBe(700);
    expect(configWarnings()).toEqual([]);
  });

  test('injection_check can be listed in RAG_DISABLED_STAGES', () => {
    const config = loadRagConfig({ RAG_DISABLED_STAGES: 'injection_check' });
    expect(config.disabledStages.has('injection_check')).toBe(true);
    expect(configWarnings()).toEqual([]);
  });

  test('disabling it while RAG_INJECTION_CHECK is on warns once; with the check off it never warns', () => {
    const disabled = loadRagConfig({ RAG_DISABLED_STAGES: 'injection_check' });
    expect(warnInjectionCheckDisabled(disabled, 'off')).toBe(false);
    expect(configWarnings()).toHaveLength(0);
    for (let i = 0; i < 3; i += 1) expect(warnInjectionCheckDisabled(disabled, 'drop')).toBe(true);
    expect(configWarnings()).toHaveLength(1);
    expect(configWarnings()[0]).toContain('injection_check');
    expect(warnInjectionCheckDisabled(loadRagConfig({}), 'drop')).toBe(false);
    expect(disabled.warnings).toEqual([]);
  });
});

describe('resolveFinalResultCount', () => {
  test.each<[unknown, string | undefined, number]>([
    [undefined, undefined, 25],
    [undefined, '40', 40],
    [Number.NaN, 'abc', 25],
    [Number.NaN, '12', 12],
    [-5, '-3', 25],
    [0, '0', 25],
    [undefined, '', 25],
    [undefined, 'abc', 25],
    [7, 'abc', 7],
    [250, undefined, 100],
    [undefined, '500', 100],
    [2.5, undefined, 25],
  ])('request %s with env %s resolves to %s and is never unbounded', (requested, envValue, expected) => {
    const count = resolveFinalResultCount(requested, envValue);
    expect(count).toBe(expected);
    expect(Number.isInteger(count) && count >= 1 && count <= 100).toBe(true);
  });

  test('an invalid env value is logged once under [RAG Config]', () => {
    resolveFinalResultCount(undefined, 'abc');
    resolveFinalResultCount(undefined, 'abc');
    expect(configWarnings()).toHaveLength(1);
  });
});
function ingestConfigWarnings(): string[] {
  return warn.mock.calls
    .filter((call) => String(call[0]).includes('[Ingest Config]'))
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
}

describe('Phase 3.2 ingestion switches (D-47)', () => {
  test('RAG_LANGUAGE_AWARE_INGEST defaults to off, accepts on, and falls back to off with one warning', () => {
    expect(loadIngestConfig({}).languageAwareIngest).toBe('off');
    expect(loadIngestConfig({ RAG_LANGUAGE_AWARE_INGEST: 'on' }).languageAwareIngest).toBe('on');
    expect(loadIngestConfig({ RAG_LANGUAGE_AWARE_INGEST: 'off' }).languageAwareIngest).toBe('off');
    expect(ingestConfigWarnings()).toEqual([]);
    expect(loadIngestConfig({ RAG_LANGUAGE_AWARE_INGEST: 'yes' }).languageAwareIngest).toBe('off');
    loadIngestConfig({ RAG_LANGUAGE_AWARE_INGEST: 'yes' });
    expect(ingestConfigWarnings()).toHaveLength(1);
    expect(ingestConfigWarnings()[0]).toContain('RAG_LANGUAGE_AWARE_INGEST');
  });
});
