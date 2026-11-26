import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  CORE_STAGES,
  OPTIONAL_STAGES,
  PROFILE_STAGE_DEFAULTS,
  QUERY_LAYER_STAGES,
  loadRagConfig,
  resetRagConfigForTests,
  resolveFinalResultCount,
  terminologyDenseFor,
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

function phase4Disabled(config: { disabledStages: ReadonlySet<string> }): string[] {
  const queryLayer = new Set<string>(QUERY_LAYER_STAGES);
  return [...config.disabledStages].filter((name) => !queryLayer.has(name)).sort();
}

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
  terminology: 50,
  dedupe: 1000,
  rerank: 600,
  refusal: 1000,
  expand_parents: 3000,
  compress: 1000,
  injection_check: 400,
  query_gate: 50,
  condense: 600,
  normalize_dates: 50,
  expand: 700,
  hyde: 900,
  decompose: 800,
  semantic_cache: 150,
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
      'query_gate',
      'condense',
      'normalize_dates',
      'expand',
      'hyde',
      'decompose',
      'semantic_cache',
      'terminology',
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
      terminology: 30,
    });
    expect(PROFILE_STAGE_DEFAULTS.eval.terminology).toBe(1000);
  });
});

describe('loadRagConfig', () => {
  test('empty values give legacy, v2 switch-off stages disabled and profile defaults', () => {
    const config = loadRagConfig({});
    expect(config.pipeline).toBe('legacy');
    expect(phase4Disabled(config)).toEqual(['compress', 'expand_parents', 'rerank', 'terminology', 'translate']);
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
    expect(phase4Disabled(config)).toEqual(['assemble', 'compress', 'expand_parents', 'legacy_rank', 'rerank', 'terminology', 'translate']);
  });

  test('a core stage in the disabled list is dropped and logged once', () => {
    const env = { RAG_DISABLED_STAGES: 'embed,legacy_rank,search' };
    const config = loadRagConfig(env);
    expect(phase4Disabled(config)).toEqual(['compress', 'expand_parents', 'legacy_rank', 'rerank', 'terminology', 'translate']);
    expect(configWarnings()).toHaveLength(2);
  });

  test('rerank is a valid optional stage name in RAG_DISABLED_STAGES', () => {
    const config = loadRagConfig({ RAG_DISABLED_STAGES: 'rerank,post_filter' });
    expect(phase4Disabled(config)).toEqual(['compress', 'expand_parents', 'post_filter', 'rerank', 'terminology', 'translate']);
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
    expect(phase4Disabled(config)).toEqual(['compress', 'expand_parents', 'terminology', 'translate']);
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
      disabledStages: phase4Disabled(rag),
      timeouts: rag.timeouts,
      exactIdLookup: rag.exactIdLookup,
      v2: rag.v2,
      warnings: rag.warnings,
    }).toEqual({
      pipeline: 'legacy',
      disabledStages: ['compress', 'expand_parents', 'rerank', 'terminology', 'translate'],
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
        terminology: false,
        terminologyDense: false,
        terminologyMining: false,
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

function queryLayerWarnings(prefix: '[Query Layer]' | '[Semantic Cache]'): string[] {
  return warn.mock.calls
    .filter((call) => String(call[0]).includes(prefix))
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
}

const PHASE4_CHAT_TIMEOUTS = Object.fromEntries(
  Object.entries(CHAT_DEFAULTS).filter(([name]) => !(QUERY_LAYER_STAGES as readonly string[]).includes(name)),
);

describe('query layer', () => {
  test('the default config disables every query-layer stage and keeps the Phase 4 fields for legacy and v2', () => {
    for (const pipeline of ['legacy', 'v2'] as const) {
      resetRagConfigForTests();
      const config = loadRagConfig({ RAG_PIPELINE: pipeline });
      for (const stage of QUERY_LAYER_STAGES) expect(config.disabledStages.has(stage)).toBe(true);
      expect(config.queryLayer.enabled).toBe(false);
      expect(config.semanticCache.backend).toBe('off');
      expect({
        disabled: phase4Disabled(config),
        chat: Object.fromEntries(Object.entries(config.timeouts.chat).filter(([name]) => name in PHASE4_CHAT_TIMEOUTS)),
        evalTranslate: config.timeouts.eval.translate,
        voiceTranslate: config.timeouts.voice.translate,
        v2: config.v2,
        warnings: config.warnings,
      }).toEqual({
        disabled: ['compress', 'expand_parents', 'rerank', 'terminology', 'translate'],
        chat: PHASE4_CHAT_TIMEOUTS,
        evalTranslate: 1000,
        voiceTranslate: 300,
        v2: loadRagConfig({}).v2,
        warnings: [],
      });
    }
    expect(queryLayerWarnings('[Query Layer]')).toEqual([]);
    expect(queryLayerWarnings('[Semantic Cache]')).toEqual([]);
  });

  test('v2 with RAG_QUERY_LAYER=true turns the layer on with the recommended profile', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' });
    expect(config.queryLayer).toEqual({
      enabled: true,
      framework: 'llamaindex',
      model: 'openai/gpt-4.1-nano',
      transforms: { condense: true, expand: true, decompose: true, translate: true, normalizeDates: true, hyde: false },
      translateDisabledProfiles: [],
      voiceTransforms: ['condense_history', 'normalize_dates'],
    });
    for (const stage of ['query_gate', 'condense', 'normalize_dates', 'expand', 'decompose'] as const) {
      expect(config.disabledStages.has(stage)).toBe(false);
    }
    expect(config.disabledStages.has('hyde')).toBe(true);
    expect(config.disabledStages.has('semantic_cache')).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  test('a sub-switch turned off disables only its stage while the layer is on', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_QUERY_EXPAND: 'false', RAG_QUERY_HYDE: 'true' });
    expect(config.queryLayer.transforms.expand).toBe(false);
    expect(config.disabledStages.has('expand')).toBe(true);
    expect(config.disabledStages.has('hyde')).toBe(false);
    expect(config.disabledStages.has('condense')).toBe(false);
  });

  test('the layer and the cache under legacy stay off with one warning each across calls', () => {
    const env = { RAG_PIPELINE: 'legacy', RAG_QUERY_LAYER: 'true', RAG_SEMANTIC_CACHE: 'pgvector' };
    const first = loadRagConfig(env);
    const second = loadRagConfig({ ...env, RAG_RERANK_TIER_CHAT: 'quality' });
    expect(second).not.toBe(first);
    for (const config of [first, second]) {
      expect(config.queryLayer.enabled).toBe(false);
      expect(config.semanticCache.backend).toBe('off');
      for (const stage of QUERY_LAYER_STAGES) expect(config.disabledStages.has(stage)).toBe(true);
    }
    expect(queryLayerWarnings('[Query Layer]')).toHaveLength(1);
    expect(queryLayerWarnings('[Semantic Cache]')).toHaveLength(1);
  });

  test('pgvector under v2 enables the semantic_cache stage without the layer', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_SEMANTIC_CACHE: 'pgvector' });
    expect(config.semanticCache).toEqual({ backend: 'pgvector', ttl: 3600, refusalTtl: 600, maxDistance: 0.05, embedStore: false });
    expect(config.disabledStages.has('semantic_cache')).toBe(false);
    expect(config.queryLayer.enabled).toBe(false);
  });

  test('an unknown framework falls back to llamaindex with one warning', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_QUERY_FRAMEWORK: 'bogus' });
    expect(config.queryLayer.framework).toBe('llamaindex');
    expect(queryLayerWarnings('[Query Layer]')).toHaveLength(1);
    expect(config.warnings).toHaveLength(1);
  });

  test('expand, hyde and decompose are dropped from the voice allow-list with one warning naming them', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_QUERY_VOICE_TRANSFORMS: 'condense_history,hyde,expand' });
    expect(config.queryLayer.voiceTransforms).toEqual(['condense_history']);
    const logged = queryLayerWarnings('[Query Layer]');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('hyde');
    expect(logged[0]).toContain('expand');
    expect(loadRagConfig({ RAG_QUERY_VOICE_TRANSFORMS: 'translate,normalize_dates' }).queryLayer.voiceTransforms).toEqual([
      'translate',
      'normalize_dates',
    ]);
  });

  test('translate-disabled profiles keep embedding-profile ids and drop malformed entries with a warning (D-24)', () => {
    const config = loadRagConfig({ RAG_QUERY_TRANSLATE_DISABLED_PROFILES: 'openai-3-small-1536, synthetic.profile_b,openai-3-small-1536,bad id,<x>' });
    expect(config.queryLayer.translateDisabledProfiles).toEqual(['openai-3-small-1536', 'synthetic.profile_b']);
    expect(queryLayerWarnings('[Query Layer]')).toHaveLength(1);
    expect(loadRagConfig({ RAG_QUERY_TRANSLATE_DISABLED_PROFILES: 'synthetic-profile-c' }).queryLayer.translateDisabledProfiles).toEqual(['synthetic-profile-c']);
  });

  test('profile timeouts follow D-27 and RAG_STAGE_TIMEOUTS overrides only the named profile', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_STAGE_TIMEOUTS: 'chat.condense=400' });
    for (const profile of ['chat', 'embed'] as const) {
      expect(config.timeouts[profile]).toMatchObject({
        translate: 600,
        expand: 700,
        decompose: 800,
        hyde: 900,
        semantic_cache: 150,
        query_gate: 50,
        normalize_dates: 50,
      });
    }
    expect(config.timeouts.chat.condense).toBe(400);
    expect(config.timeouts.embed.condense).toBe(600);
    expect(config.timeouts.voice).toMatchObject({ condense: 300, query_gate: 50, normalize_dates: 50, translate: 300 });
    for (const stage of [...QUERY_LAYER_STAGES, 'translate'] as const) expect(config.timeouts.eval[stage]).toBe(60000);
    expect(loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_STAGE_TIMEOUTS: 'translate=900' }).timeouts.chat.translate).toBe(900);
  });

  test('the cache distance is capped at 0.2 and TTLs are bounded', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_SEMANTIC_CACHE: 'pgvector', RAG_SEMANTIC_CACHE_MAX_DISTANCE: '0.5' });
    expect(config.semanticCache.maxDistance).toBe(0.05);
    expect(queryLayerWarnings('[Semantic Cache]')).toHaveLength(1);
    expect(loadRagConfig({ RAG_SEMANTIC_CACHE_MAX_DISTANCE: '0.12' }).semanticCache.maxDistance).toBe(0.12);
    expect(loadRagConfig({ RAG_SEMANTIC_CACHE_MAX_DISTANCE: '0' }).semanticCache.maxDistance).toBe(0.05);
    expect(loadRagConfig({ RAG_SEMANTIC_CACHE_TTL: '0' }).semanticCache.ttl).toBe(3600);
    expect(loadRagConfig({ RAG_SEMANTIC_CACHE_REFUSAL_TTL: '120', RAG_SEMANTIC_CACHE_EMBED_STORE: 'true' }).semanticCache).toMatchObject({
      refusalTtl: 120,
      embedStore: true,
    });
    expect(loadRagConfig({ RAG_SEMANTIC_CACHE: 'redis' }).semanticCache.backend).toBe('off');
  });

  test('a malformed model id falls back to the default and the warning does not echo it', () => {
    const config = loadRagConfig({ RAG_QUERY_LLM_MODEL: 'bad model<script>' });
    expect(config.queryLayer.model).toBe('openai/gpt-4.1-nano');
    expect(loadRagConfig({ RAG_QUERY_LLM_MODEL: 'mistralai/mistral-small-3.2-24b-instruct' }).queryLayer.model).toBe(
      'mistralai/mistral-small-3.2-24b-instruct',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('<script>');
  });

  test('the new switches are part of the memo key', () => {
    const off = loadRagConfig({ RAG_PIPELINE: 'v2' });
    const on = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' });
    expect(off).not.toBe(on);
    expect(loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_QUERY_HYDE: 'true' })).not.toBe(on);
  });
});

describe('retrieval backend (D-11, D-24)', () => {
  test('an empty env input gives pgvector for chat and voice and a 300 s lag bound', () => {
    expect(loadRagConfig({}).backend).toEqual({ default: 'pgvector', voice: 'pgvector', maxLagSeconds: 300 });
    expect(configWarnings()).toEqual([]);
  });

  test('parses the chat and voice backends separately, normalising case and spaces', () => {
    const config = loadRagConfig({ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_RETRIEVAL_BACKEND_VOICE: 'weaviate' });
    expect(config.backend.default).toBe('qdrant');
    expect(config.backend.voice).toBe('weaviate');
    const mixed = loadRagConfig({ RAG_RETRIEVAL_BACKEND: '  Weaviate ', RAG_RETRIEVAL_BACKEND_VOICE: ' QDRANT' });
    expect(mixed.backend).toMatchObject({ default: 'weaviate', voice: 'qdrant' });
    expect(configWarnings()).toEqual([]);
  });

  test('an unknown backend falls back to pgvector with one [RAG Config] warning naming the variable', () => {
    const env = { RAG_RETRIEVAL_BACKEND: 'milvus', QDRANT_READ_API_KEY: 'placeholder-read-key' };
    const config = loadRagConfig(env);
    expect(config.backend.default).toBe('pgvector');
    expect(config.backend.voice).toBe('pgvector');
    const warnings = configWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('RAG_RETRIEVAL_BACKEND');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('placeholder-read-key');
    loadRagConfig({ ...env });
    expect(configWarnings()).toHaveLength(1);
  });

  test('an unknown voice backend falls back to pgvector without touching the chat backend', () => {
    const config = loadRagConfig({ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_RETRIEVAL_BACKEND_VOICE: 'faiss' });
    expect(config.backend).toMatchObject({ default: 'qdrant', voice: 'pgvector' });
    expect(configWarnings()).toHaveLength(1);
    expect(configWarnings()[0]).toContain('RAG_RETRIEVAL_BACKEND_VOICE');
  });

  test.each(['0', '-5', 'abc', '1.5', ''])('a lag of %j falls back to 300', (value) => {
    expect(loadRagConfig({ RAG_VECTOR_SYNC_MAX_LAG_SECONDS: value }).backend.maxLagSeconds).toBe(300);
  });

  test('a positive integer lag is kept', () => {
    expect(loadRagConfig({ RAG_VECTOR_SYNC_MAX_LAG_SECONDS: ' 120 ' }).backend.maxLagSeconds).toBe(120);
  });

  test('RAG_PIPELINE=legacy still parses the backend values (the factory applies the legacy rule)', () => {
    const config = loadRagConfig({ RAG_PIPELINE: 'legacy', RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_VECTOR_SYNC_MAX_LAG_SECONDS: '60' });
    expect(config.pipeline).toBe('legacy');
    expect(config.backend).toEqual({ default: 'qdrant', voice: 'pgvector', maxLagSeconds: 60 });
  });

  test('the backend values are part of the memo key', () => {
    const base = loadRagConfig({});
    expect(loadRagConfig({ RAG_RETRIEVAL_BACKEND: 'qdrant' })).not.toBe(base);
    expect(loadRagConfig({ RAG_RETRIEVAL_BACKEND_VOICE: 'qdrant' })).not.toBe(base);
    expect(loadRagConfig({ RAG_VECTOR_SYNC_MAX_LAG_SECONDS: '60' })).not.toBe(base);
  });
});

describe('terminology switches (D-15, D-18, D-19)', () => {
  test('default env: switches off, stage disabled, timeouts in every profile', () => {
    const config = loadRagConfig({});
    expect(config.v2.terminology).toBe(false);
    expect(config.v2.terminologyDense).toBe(false);
    expect(config.v2.terminologyMining).toBe(false);
    expect(config.disabledStages.has('terminology')).toBe(true);
    expect(config.timeouts.chat.terminology).toBe(50);
    expect(config.timeouts.embed.terminology).toBe(50);
    expect(config.timeouts.voice.terminology).toBe(30);
    expect(config.timeouts.eval.terminology).toBe(1000);
    expect(config.warnings).toEqual([]);
  });

  test('RAG_TERMINOLOGY=true enables the stage whatever the pipeline value', () => {
    for (const pipeline of [undefined, 'legacy', 'v2']) {
      const config = loadRagConfig({ RAG_PIPELINE: pipeline, RAG_TERMINOLOGY: 'true' });
      expect(config.v2.terminology).toBe(true);
      expect(config.disabledStages.has('terminology')).toBe(false);
    }
  });

  test('an unparseable value warns and stays false', () => {
    const config = loadRagConfig({ RAG_TERMINOLOGY: 'yes-please' });
    expect(config.v2.terminology).toBe(false);
    expect(config.disabledStages.has('terminology')).toBe(true);
    expect(config.warnings).toHaveLength(1);
    expect(configWarnings()).toHaveLength(1);
    expect(loadRagConfig({ RAG_TERMINOLOGY: 'true', RAG_TERMINOLOGY_MINING: 'maybe' }).v2.terminologyMining).toBe(false);
  });

  test('RAG_TERMINOLOGY_DENSE without RAG_TERMINOLOGY is off with a warning', () => {
    const config = loadRagConfig({ RAG_TERMINOLOGY: 'false', RAG_TERMINOLOGY_DENSE: 'true' });
    expect(config.v2.terminologyDense).toBe(false);
    expect(config.warnings).toHaveLength(1);
    expect(configWarnings().join(' ')).toContain('RAG_TERMINOLOGY_DENSE');
  });

  test('the dense variant is ignored for the voice profile', () => {
    expect(typeof terminologyDenseFor).toBe('function');
    const config = loadRagConfig({ RAG_TERMINOLOGY: 'true', RAG_TERMINOLOGY_DENSE: 'true' });
    expect(config.v2.terminologyDense).toBe(true);
    expect(terminologyDenseFor(config, 'chat')).toBe(true);
    expect(terminologyDenseFor(config, 'embed')).toBe(true);
    expect(terminologyDenseFor(config, 'voice')).toBe(false);
    expect(terminologyDenseFor(loadRagConfig({ RAG_TERMINOLOGY_DENSE: 'true' }), 'chat')).toBe(false);
  });

  test('RAG_DISABLED_STAGES=terminology disables the stage while the switch is on', () => {
    const config = loadRagConfig({ RAG_TERMINOLOGY: 'true', RAG_DISABLED_STAGES: 'terminology' });
    expect(config.v2.terminology).toBe(true);
    expect(config.disabledStages.has('terminology')).toBe(true);
    expect(config.operatorDisabledStages?.has('terminology')).toBe(true);
  });

  test('RAG_STAGE_TIMEOUTS can set the terminology budget', () => {
    expect(loadRagConfig({ RAG_STAGE_TIMEOUTS: 'terminology=80' }).timeouts.chat.terminology).toBe(80);
  });

  test('the three switches are part of the memo key', () => {
    const base = { RAG_TERMINOLOGY: 'true' };
    expect(loadRagConfig({}).v2.terminology).toBe(false);
    expect(loadRagConfig(base).v2.terminology).toBe(true);
    expect(loadRagConfig({ ...base, RAG_TERMINOLOGY_DENSE: 'true' }).v2.terminologyDense).toBe(true);
    expect(loadRagConfig(base).v2.terminologyDense).toBe(false);
    expect(loadRagConfig({ ...base, RAG_TERMINOLOGY_MINING: 'true' }).v2.terminologyMining).toBe(true);
    expect(loadRagConfig(base).v2.terminologyMining).toBe(false);
  });
});
