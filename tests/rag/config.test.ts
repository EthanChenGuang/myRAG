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
describe('domain embeddings switches', () => {
  test('defaults: off, two legs, 800 ms, and the ingest switch is off', () => {
    const config = loadRagConfig({});
    expect(config.v2.domainEmbeddings).toEqual({ enabled: false, maxLegs: 2, timeoutMs: 800 });
    expect(loadIngestConfig({}).domainEmbeddings).toBe('off');
    expect(config.warnings).toEqual([]);
  });

  test('on with embedding profiles on enables both', () => {
    const env = { RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' };
    expect(loadRagConfig(env).v2.domainEmbeddings?.enabled).toBe(true);
    expect(loadIngestConfig(env).domainEmbeddings).toBe('on');
    expect(loadRagConfig(env).warnings).toEqual([]);
  });

  test('on with embedding profiles off stays off with one warning', () => {
    const env = { RAG_EMBEDDING_PROFILES: 'off', RAG_DOMAIN_EMBEDDINGS: 'on' };
    const config = loadRagConfig(env);
    expect(config.v2.domainEmbeddings?.enabled).toBe(false);
    expect(config.warnings.filter((w) => w.includes('domain-embeddings needs embedding profiles'))).toHaveLength(1);
    const ingest = loadIngestConfig(env);
    expect(ingest.domainEmbeddings).toBe('off');
    expect(ingest.warnings.filter((w) => w.includes('domain-embeddings needs embedding profiles'))).toHaveLength(1);
  });

  test('profiles on but domain embeddings unset stays off without a warning', () => {
    const config = loadRagConfig({ RAG_EMBEDDING_PROFILES: 'on' });
    expect(config.v2.domainEmbeddings?.enabled).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  test('an unsupported switch value falls back to off with a warning', () => {
    const env = { RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'yes' };
    const config = loadRagConfig(env);
    expect(config.v2.domainEmbeddings?.enabled).toBe(false);
    expect(config.warnings).toHaveLength(1);
    expect(loadIngestConfig(env).domainEmbeddings).toBe('off');
  });

  test('max legs is bounded 0..5; zero is accepted', () => {
    const nine = loadRagConfig({ RAG_DOMAIN_EMBEDDING_MAX_LEGS: '9' });
    expect(nine.v2.domainEmbeddings?.maxLegs).toBe(2);
    expect(nine.warnings).toHaveLength(1);
    const zero = loadRagConfig({ RAG_DOMAIN_EMBEDDING_MAX_LEGS: '0' });
    expect(zero.v2.domainEmbeddings?.maxLegs).toBe(0);
    expect(zero.warnings).toEqual([]);
    expect(loadRagConfig({ RAG_DOMAIN_EMBEDDING_MAX_LEGS: '5' }).v2.domainEmbeddings?.maxLegs).toBe(5);
    expect(loadRagConfig({ RAG_DOMAIN_EMBEDDING_MAX_LEGS: 'two' }).v2.domainEmbeddings?.maxLegs).toBe(2);
  });

  test('timeout is bounded 100..5000', () => {
    const low = loadRagConfig({ RAG_DOMAIN_EMBEDDING_TIMEOUT_MS: '50' });
    expect(low.v2.domainEmbeddings?.timeoutMs).toBe(800);
    expect(low.warnings).toHaveLength(1);
    expect(loadRagConfig({ RAG_DOMAIN_EMBEDDING_TIMEOUT_MS: '5001' }).v2.domainEmbeddings?.timeoutMs).toBe(800);
    expect(loadRagConfig({ RAG_DOMAIN_EMBEDDING_TIMEOUT_MS: '100' }).v2.domainEmbeddings?.timeoutMs).toBe(100);
    expect(loadRagConfig({ RAG_DOMAIN_EMBEDDING_TIMEOUT_MS: '5000' }).v2.domainEmbeddings?.timeoutMs).toBe(5000);
    expect(loadRagConfig({ RAG_DOMAIN_EMBEDDING_TIMEOUT_MS: '1.5e3' }).v2.domainEmbeddings?.timeoutMs).toBe(800);
  });

  test('the switches are part of the memo key', () => {
    const on = loadRagConfig({ RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' });
    const off = loadRagConfig({ RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'off' });
    expect(on.v2.domainEmbeddings?.enabled).toBe(true);
    expect(off.v2.domainEmbeddings?.enabled).toBe(false);
  });
});
