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

describe('Phase 3.2 typed switches (D-47)', () => {
  test('ingestion-side fields default to D-47 with an empty environment', () => {
    const config = loadIngestConfig({});
    expect({
      tableHeaderRepeat: config.tableHeaderRepeat,
      tableRowSerialization: config.tableRowSerialization,
      captionLanguage: config.captionLanguage,
      docTranslation: config.docTranslation,
      docTranslationModel: config.docTranslationModel,
      hiddenTextCheck: config.hiddenTextCheck,
      ingestLinkCheck: config.ingestLinkCheck,
      outputLinkAllowlist: config.outputLinkAllowlist,
      uploadApproval: config.uploadApproval,
      scopeTags: config.scopeTags,
      scopeTagSuggest: config.scopeTagSuggest,
      supersessionDetect: config.supersessionDetect,
      effectiveDateLlmExtract: config.effectiveDateLlmExtract,
    }).toEqual({
      tableHeaderRepeat: 'profile',
      tableRowSerialization: false,
      captionLanguage: 'en',
      docTranslation: 'off',
      docTranslationModel: '',
      hiddenTextCheck: 'off',
      ingestLinkCheck: 'off',
      outputLinkAllowlist: '',
      uploadApproval: 'off',
      scopeTags: false,
      scopeTagSuggest: false,
      supersessionDetect: 'off',
      effectiveDateLlmExtract: false,
    });
    expect(config.warnings).toEqual([]);
  });

  test('ingestion-side fields accept every D-47 value', () => {
    const config = loadIngestConfig({
      RAG_TABLE_HEADER_REPEAT: 'always',
      RAG_TABLE_ROW_SERIALIZATION: 'true',
      RAG_CAPTION_LANGUAGE: 'document',
      RAG_DOC_TRANSLATION: 'on',
      RAG_DOC_TRANSLATION_MODEL: 'vendor/model-a',
      RAG_HIDDEN_TEXT_CHECK: 'quarantine',
      RAG_INGEST_LINK_CHECK: 'flag',
      RAG_OUTPUT_LINK_ALLOWLIST: 'example.com,example.org',
      RAG_UPLOAD_APPROVAL: 'members',
      RAG_SCOPE_TAGS: 'true',
      RAG_SCOPE_TAG_SUGGEST: 'true',
      RAG_SUPERSESSION_DETECT: 'on',
      RAG_EFFECTIVE_DATE_LLM_EXTRACT: 'true',
    });
    expect(config.tableHeaderRepeat).toBe('always');
    expect(config.tableRowSerialization).toBe(true);
    expect(config.captionLanguage).toBe('document');
    expect(config.docTranslation).toBe('on');
    expect(config.docTranslationModel).toBe('vendor/model-a');
    expect(config.hiddenTextCheck).toBe('quarantine');
    expect(config.ingestLinkCheck).toBe('flag');
    expect(config.outputLinkAllowlist).toBe('example.com,example.org');
    expect(config.uploadApproval).toBe('members');
    expect(config.scopeTags).toBe(true);
    expect(config.scopeTagSuggest).toBe(true);
    expect(config.supersessionDetect).toBe('on');
    expect(config.effectiveDateLlmExtract).toBe(true);
    expect(loadIngestConfig({ RAG_HIDDEN_TEXT_CHECK: 'flag', RAG_INGEST_LINK_CHECK: 'quarantine', RAG_UPLOAD_APPROVAL: 'all' })).toMatchObject({
      hiddenTextCheck: 'flag',
      ingestLinkCheck: 'quarantine',
      uploadApproval: 'all',
    });
    expect(ingestConfigWarnings()).toEqual([]);
  });

  test.each([
    ['RAG_TABLE_HEADER_REPEAT', 'tableHeaderRepeat', 'sometimes', 'profile'],
    ['RAG_TABLE_ROW_SERIALIZATION', 'tableRowSerialization', 'yes', false],
    ['RAG_TABLE_ROW_SERIALIZATION', 'tableRowSerialization', '1', false],
    ['RAG_CAPTION_LANGUAGE', 'captionLanguage', 'fr', 'en'],
    ['RAG_DOC_TRANSLATION', 'docTranslation', 'true', 'off'],
    ['RAG_HIDDEN_TEXT_CHECK', 'hiddenTextCheck', 'block', 'off'],
    ['RAG_INGEST_LINK_CHECK', 'ingestLinkCheck', 'on', 'off'],
    ['RAG_UPLOAD_APPROVAL', 'uploadApproval', 'admins', 'off'],
    ['RAG_SCOPE_TAGS', 'scopeTags', 'on', false],
    ['RAG_SCOPE_TAG_SUGGEST', 'scopeTagSuggest', 'on', false],
    ['RAG_SUPERSESSION_DETECT', 'supersessionDetect', 'true', 'off'],
    ['RAG_EFFECTIVE_DATE_LLM_EXTRACT', 'effectiveDateLlmExtract', 'on', false],
  ] as const)('ingest %s=%s falls back to the default with one [Ingest Config] warning', (name, field, raw, fallback) => {
    const config = loadIngestConfig({ [name]: raw });
    expect((config as unknown as Record<string, unknown>)[field]).toBe(fallback);
    loadIngestConfig({ [name]: raw });
    const warnings = ingestConfigWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(name);
  });

  test('query-side fields default to D-47 with an empty environment', () => {
    const config = loadRagConfig({});
    expect({
      effectiveDates: config.effectiveDates,
      scopeTags: config.scopeTags,
      docTranslation: config.docTranslation,
      bgeM3Serving: config.bgeM3Serving,
      outputLinkAllowlist: config.outputLinkAllowlist,
    }).toEqual({ effectiveDates: false, scopeTags: false, docTranslation: 'off', bgeM3Serving: 'hosted', outputLinkAllowlist: '' });
  });

  test('query-side fields accept every D-47 value', () => {
    const config = loadRagConfig({
      RAG_EFFECTIVE_DATES: 'true',
      RAG_SCOPE_TAGS: 'true',
      RAG_DOC_TRANSLATION: 'on',
      RAG_BGE_M3_SERVING: 'sidecar',
      RAG_OUTPUT_LINK_ALLOWLIST: 'example.com',
    });
    expect(config).toMatchObject({ effectiveDates: true, scopeTags: true, docTranslation: 'on', bgeM3Serving: 'sidecar', outputLinkAllowlist: 'example.com' });
    expect(configWarnings()).toEqual([]);
  });

  test.each([
    ['RAG_EFFECTIVE_DATES', 'effectiveDates', 'yes', false],
    ['RAG_SCOPE_TAGS', 'scopeTags', 'on', false],
    ['RAG_DOC_TRANSLATION', 'docTranslation', 'enabled', 'off'],
    ['RAG_BGE_M3_SERVING', 'bgeM3Serving', 'local', 'hosted'],
  ] as const)('rag %s=%s falls back to the default with one [RAG Config] warning', (name, field, raw, fallback) => {
    const config = loadRagConfig({ [name]: raw });
    expect((config as unknown as Record<string, unknown>)[field]).toBe(fallback);
    loadRagConfig({ [name]: raw });
    const warnings = configWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(name);
  });

  test('the language variables are not parsed config (D-01)', () => {
    const env = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' } as Record<string, string>;
    const ingest = loadIngestConfig(env) as unknown as Record<string, unknown>;
    const rag = loadRagConfig(env) as unknown as Record<string, unknown>;
    for (const config of [ingest, rag]) {
      expect(JSON.stringify(config)).not.toContain('zh,en,it');
      expect(Object.keys(config).some((key) => /language/i.test(key) && key !== 'languageAwareIngest' && key !== 'captionLanguage')).toBe(false);
    }
  });

  test('all-off parity: pre-existing fields equal the snapshot from before Phase 3.2 (D-46)', () => {
    const ingest = loadIngestConfig({});
    expect({
      pipeline: ingest.pipeline,
      parser: ingest.parser,
      parsePollBudgetMs: ingest.parsePollBudgetMs,
      docTypeLlmDetect: ingest.docTypeLlmDetect,
      invoiceLlmExtract: ingest.invoiceLlmExtract,
      exactIdLookup: ingest.exactIdLookup,
      pdfImageChunks: ingest.pdfImageChunks,
      injectionScan: ingest.injectionScan,
      embeddingProfiles: ingest.embeddingProfiles,
      qwenFallback: ingest.qwenFallback,
      warnings: ingest.warnings,
    }).toEqual({
      pipeline: 'legacy',
      parser: 'llamaparse',
      parsePollBudgetMs: 45000,
      docTypeLlmDetect: false,
      invoiceLlmExtract: false,
      exactIdLookup: false,
      pdfImageChunks: false,
      injectionScan: 'off',
      embeddingProfiles: 'off',
      qwenFallback: 'openrouter',
      warnings: [],
    });

    const rag = loadRagConfig({});
    expect({
      pipeline: rag.pipeline,
      disabledStages: [...rag.disabledStages].sort(),
      timeouts: rag.timeouts,
      exactIdLookup: rag.exactIdLookup,
      v2: rag.v2,
      warnings: rag.warnings,
    }).toEqual({
      pipeline: 'legacy',
      disabledStages: ['compress', 'expand_parents', 'rerank', 'translate'],
      timeouts: PROFILE_STAGE_DEFAULTS,
      exactIdLookup: false,
      v2: {
        lexicalSearch: false,
        reranker: 'none',
        rerankTier: { chat: 'quality', voice: 'fast' },
        voyageModelByLang: {},
        refusalThreshold: false,
        refusalFloor: 'similarity',
        edgeOrder: false,
        compression: false,
        tokenBudget: 6000,
        parentChild: false,
        iterativeScan: 'off',
        exactScanCutoff: 0,
        lexicalTranslation: false,
        paramsOverride: {},
        hasCohereKey: false,
        hasVoyageKey: false,
        domainEmbeddings: { enabled: false, maxLegs: 2, timeoutMs: 800 },
      },
      warnings: [],
    });
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
