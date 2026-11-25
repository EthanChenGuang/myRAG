import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { loadIngestConfig, resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import { LANGUAGES_NOT_CONFIGURED, resolvePipelines, type ShippedPipelineDefaults } from '@/lib/rag/lang/resolve';
import { getLanguageSettings, resetLanguageSettingsForTests, type LanguageSettings } from '@/lib/rag/lang/settings';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';

vi.mock('@/lib/rag/lang/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/lang/settings')>();
  return { ...actual, getLanguageSettings: vi.fn(actual.getLanguageSettings) };
});

const CONFIGURED: LanguageSettings = { configured: true, languages: ['zh', 'en', 'it'], primary: 'en', monolingual: false };
const MONOLINGUAL: LanguageSettings = { configured: true, languages: ['en'], primary: 'en', monolingual: true };
const UNSET: LanguageSettings = { configured: false, languages: [], primary: null, monolingual: false };

const LEGACY_DEFAULTS: ShippedPipelineDefaults = { retrieval: 'legacy', ingest: 'legacy' };
const NEW_DEFAULTS: ShippedPipelineDefaults = { retrieval: 'v2', ingest: 'unified' };

type Raw = string | undefined;

// languages x raw value x shipped default, for each path; expected pipeline and the served-legacy flag.
const RETRIEVAL_TABLE: Array<[LanguageSettings, Raw, ShippedPipelineDefaults, string, boolean]> = [
  [UNSET, undefined, LEGACY_DEFAULTS, 'legacy', false],
  [UNSET, undefined, NEW_DEFAULTS, 'legacy', true],
  [UNSET, '', NEW_DEFAULTS, 'legacy', true],
  [UNSET, '  ', NEW_DEFAULTS, 'legacy', true],
  [UNSET, 'legacy', LEGACY_DEFAULTS, 'legacy', false],
  [UNSET, 'legacy', NEW_DEFAULTS, 'legacy', false],
  [UNSET, 'v2', LEGACY_DEFAULTS, LANGUAGES_NOT_CONFIGURED, false],
  [UNSET, 'v2', NEW_DEFAULTS, LANGUAGES_NOT_CONFIGURED, false],
  [CONFIGURED, undefined, LEGACY_DEFAULTS, 'legacy', false],
  [CONFIGURED, undefined, NEW_DEFAULTS, 'v2', false],
  [CONFIGURED, 'legacy', NEW_DEFAULTS, 'legacy', false],
  [CONFIGURED, 'v2', LEGACY_DEFAULTS, 'v2', false],
  [CONFIGURED, 'v2', NEW_DEFAULTS, 'v2', false],
  [UNSET, 'V2', LEGACY_DEFAULTS, 'legacy', false],
];

const INGEST_TABLE: Array<[LanguageSettings, Raw, ShippedPipelineDefaults, string, boolean]> = [
  [UNSET, undefined, LEGACY_DEFAULTS, 'legacy', false],
  [UNSET, undefined, NEW_DEFAULTS, 'legacy', true],
  [UNSET, 'legacy', NEW_DEFAULTS, 'legacy', false],
  [UNSET, 'unified', LEGACY_DEFAULTS, LANGUAGES_NOT_CONFIGURED, false],
  [UNSET, 'Unified', NEW_DEFAULTS, LANGUAGES_NOT_CONFIGURED, false],
  [CONFIGURED, undefined, NEW_DEFAULTS, 'unified', false],
  [CONFIGURED, 'unified', LEGACY_DEFAULTS, 'unified', false],
  [CONFIGURED, 'legacy', NEW_DEFAULTS, 'legacy', false],
];

function label(settings: LanguageSettings): string {
  return settings.configured ? 'languages set' : 'languages unset';
}

describe('resolvePipelines (D-02, research F-18)', () => {
  it.each(RETRIEVAL_TABLE.map((row) => [label(row[0]), String(row[1]), row[2].retrieval, ...row] as const))(
    'retrieval: %s, RAG_PIPELINE=%s, shipped default %s',
    (_l, _r, _d, settings, raw, defaults, expected, servedLegacy) => {
      const result = resolvePipelines({ RAG_PIPELINE: raw }, defaults, settings);
      expect(result.retrieval.pipeline).toBe(expected);
      expect(result.retrieval.servedLegacyBecauseUnset).toBe(servedLegacy);
      expect(result.retrieval.source).toBe((raw ?? '').trim() === '' ? 'default' : 'explicit');
    },
  );

  it.each(INGEST_TABLE.map((row) => [label(row[0]), String(row[1]), row[2].ingest, ...row] as const))(
    'ingest: %s, RAG_INGEST_PIPELINE=%s, shipped default %s',
    (_l, _r, _d, settings, raw, defaults, expected, servedLegacy) => {
      const result = resolvePipelines({ RAG_INGEST_PIPELINE: raw }, defaults, settings);
      expect(result.ingest.pipeline).toBe(expected);
      expect(result.ingest.servedLegacyBecauseUnset).toBe(servedLegacy);
    },
  );

  it('both variables explicit with the languages unset fail on both paths independently', () => {
    const result = resolvePipelines({ RAG_PIPELINE: 'v2', RAG_INGEST_PIPELINE: 'unified' }, LEGACY_DEFAULTS, UNSET);
    expect(result.retrieval.pipeline).toBe(LANGUAGES_NOT_CONFIGURED);
    expect(result.ingest.pipeline).toBe(LANGUAGES_NOT_CONFIGURED);
    expect(result.servedLegacyBecauseUnset).toBe(false);
  });

  it('one explicit path fails while the unset path with a new shipped default serves legacy', () => {
    const result = resolvePipelines({ RAG_PIPELINE: 'v2' }, NEW_DEFAULTS, UNSET);
    expect(result.retrieval.pipeline).toBe(LANGUAGES_NOT_CONFIGURED);
    expect(result.ingest.pipeline).toBe('legacy');
    expect(result.servedLegacyBecauseUnset).toBe(true);
  });

  it('legacy on both paths never reads the language settings', () => {
    const reader = vi.fn(() => {
      throw new Error('settings must not be read');
    });
    for (const raw of [{}, { RAG_PIPELINE: 'legacy' }, { RAG_PIPELINE: 'legacy', RAG_INGEST_PIPELINE: 'legacy' }, { RAG_PIPELINE: '' }]) {
      const result = resolvePipelines(raw, LEGACY_DEFAULTS, reader);
      expect(result.retrieval.pipeline).toBe('legacy');
      expect(result.ingest.pipeline).toBe('legacy');
      expect(result.languagesRead).toBe(false);
      expect(result.monolingual).toBe(false);
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads the settings at most once when both paths need them', () => {
    const reader = vi.fn(() => CONFIGURED);
    const result = resolvePipelines({ RAG_PIPELINE: 'v2', RAG_INGEST_PIPELINE: 'unified' }, LEGACY_DEFAULTS, reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.languagesRead).toBe(true);
  });

  it('reports monolingual only for a configured single-language set (D-03)', () => {
    expect(resolvePipelines({ RAG_PIPELINE: 'v2' }, LEGACY_DEFAULTS, MONOLINGUAL).monolingual).toBe(true);
    expect(resolvePipelines({ RAG_PIPELINE: 'v2' }, LEGACY_DEFAULTS, CONFIGURED).monolingual).toBe(false);
    expect(resolvePipelines({ RAG_PIPELINE: 'v2' }, LEGACY_DEFAULTS, UNSET).monolingual).toBe(false);
  });
});

const LANGUAGE_VARS = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;

function setLanguages(supported: string | null, primary: string | null): void {
  if (supported === null) delete process.env.RAG_SUPPORTED_LANGUAGES;
  else process.env.RAG_SUPPORTED_LANGUAGES = supported;
  if (primary === null) delete process.env.RAG_PRIMARY_LANGUAGE;
  else process.env.RAG_PRIMARY_LANGUAGE = primary;
  resetLanguageSettingsForTests();
  resetRagConfigForTests();
  resetIngestConfigForTests();
}

describe('the config loaders apply the resolver (D-02, D-03)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of LANGUAGE_VARS) saved[name] = process.env[name];
    vi.mocked(getLanguageSettings).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setLanguages(saved.RAG_SUPPORTED_LANGUAGES ?? null, saved.RAG_PRIMARY_LANGUAGE ?? null);
    vi.restoreAllMocks();
  });

  it('a legacy pipeline, set or unset, never reads the language settings and is unchanged', () => {
    setLanguages(null, null);
    for (const env of [{}, { RAG_PIPELINE: 'legacy' }, { RAG_PIPELINE: '' }, { RAG_PIPELINE: 'unknown' }]) {
      const config = loadRagConfig(env);
      expect(config.pipelineBlocked).toBeNull();
      expect(config.monolingual).toBe(false);
    }
    for (const env of [{}, { RAG_INGEST_PIPELINE: 'legacy' }, { RAG_INGEST_PIPELINE: 'other' }]) {
      expect(loadIngestConfig(env).pipelineBlocked).toBeNull();
    }
    expect(getLanguageSettings).not.toHaveBeenCalled();
  });

  it('explicit v2 and unified without languages are blocked; with languages they run', () => {
    setLanguages(null, null);
    expect(loadRagConfig({ RAG_PIPELINE: 'v2' })).toMatchObject({ pipeline: 'v2', pipelineBlocked: LANGUAGES_NOT_CONFIGURED });
    expect(loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified' })).toMatchObject({ pipeline: 'unified', pipelineBlocked: LANGUAGES_NOT_CONFIGURED });
    setLanguages('zh,en,it', 'en');
    expect(loadRagConfig({ RAG_PIPELINE: 'v2' })).toMatchObject({ pipeline: 'v2', pipelineBlocked: null, monolingual: false });
    expect(loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified' })).toMatchObject({ pipeline: 'unified', pipelineBlocked: null });
  });

  it('monolingual forces lexical translation off and disables the translate stage', () => {
    setLanguages('en', 'en');
    const mono = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_TRANSLATION: 'true' });
    expect(mono.monolingual).toBe(true);
    expect(mono.v2.lexicalTranslation).toBe(false);
    expect(mono.disabledStages.has('translate')).toBe(true);

    setLanguages('zh,en,it', 'en');
    const multi = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_TRANSLATION: 'true' });
    expect(multi.monolingual).toBe(false);
    expect(multi.v2.lexicalTranslation).toBe(true);
    expect(multi.disabledStages.has('translate')).toBe(false);
  });

  it('the monolingual flag changes the retrieval config hash; a multilingual hash is unchanged', () => {
    const base: RetrievalConfigHashInput = {
      backendId: 'pgvector',
      embeddingProfileId: 'legacy',
      lexicalVersion: 1,
      rerankTextVersion: 1,
      params: {} as RetrievalConfigHashInput['params'],
      reranker: { id: 'none', model: '' },
      thresholdsConfigHash: null,
      activeChunkingProfiles: null,
      switches: {
        lexicalSearch: false,
        refusalThreshold: false,
        edgeOrder: false,
        compression: false,
        tokenBudget: 6000,
        parentChild: false,
        iterativeScan: 'off',
        exactScanCutoff: 0,
        lexicalTranslation: false,
        exactIdLookup: false,
        rerankTierChat: 'quality',
        rerankTierVoice: 'fast',
      },
    };
    const mono = { ...base, switches: { ...base.switches, monolingual: true as const } };
    expect(computeRetrievalConfigHash(mono)).not.toBe(computeRetrievalConfigHash(base));
  });
});
