import type { LanguageSettings } from './settings';

export const LANGUAGES_NOT_CONFIGURED = 'languages_not_configured';
export type LanguagesNotConfigured = typeof LANGUAGES_NOT_CONFIGURED;

export type RetrievalPipeline = 'legacy' | 'v2';
export type IngestPipelineChoice = 'legacy' | 'unified';
export type PipelineSource = 'explicit' | 'default';

export interface RawPipelineEnv {
  RAG_PIPELINE?: string;
  RAG_INGEST_PIPELINE?: string;
}

export interface ShippedPipelineDefaults {
  retrieval: RetrievalPipeline;
  ingest: IngestPipelineChoice;
}

export interface PathResolution<T extends string> {
  pipeline: T | LanguagesNotConfigured;
  source: PipelineSource;
  /** True when the variable was unset, the shipped default asked for the new pipeline and the languages are not chosen. */
  servedLegacyBecauseUnset: boolean;
}

export interface PipelineResolution {
  retrieval: PathResolution<RetrievalPipeline>;
  ingest: PathResolution<IngestPipelineChoice>;
  servedLegacyBecauseUnset: boolean;
  /** Configured with exactly one language (D-03); false whenever the settings were not read. */
  monolingual: boolean;
  /** Whether the language settings were read at all; false when both paths resolve to legacy without them. */
  languagesRead: boolean;
}

type LanguageSource = LanguageSettings | (() => LanguageSettings);

/** D-07, D-24: the one rule for whether a pipeline variable was set. An empty or whitespace-only value counts as unset. */
export function pipelineSourceOf(raw: string | undefined): PipelineSource {
  return (raw ?? '').trim() === '' ? 'default' : 'explicit';
}

function requestedRetrieval(raw: string | undefined, shipped: RetrievalPipeline): { requested: RetrievalPipeline; source: PipelineSource } {
  if (pipelineSourceOf(raw) === 'default') return { requested: shipped, source: 'default' };
  return { requested: (raw ?? '').trim() === 'v2' ? 'v2' : 'legacy', source: 'explicit' };
}

function requestedIngest(raw: string | undefined, shipped: IngestPipelineChoice): { requested: IngestPipelineChoice; source: PipelineSource } {
  if (pipelineSourceOf(raw) === 'default') return { requested: shipped, source: 'default' };
  return { requested: (raw ?? '').trim().toLowerCase() === 'unified' ? 'unified' : 'legacy', source: 'explicit' };
}

function resolvePath<T extends string>(
  requested: T,
  source: PipelineSource,
  legacy: T,
  languages: () => LanguageSettings,
): PathResolution<T> {
  if (requested === legacy) return { pipeline: legacy, source, servedLegacyBecauseUnset: false };
  if (languages().configured) return { pipeline: requested, source, servedLegacyBecauseUnset: false };
  if (source === 'default') return { pipeline: legacy, source, servedLegacyBecauseUnset: true };
  return { pipeline: LANGUAGES_NOT_CONFIGURED, source, servedLegacyBecauseUnset: false };
}

/**
 * D-02, research F-18: which pipeline serves each path. A legacy request (set or defaulted) never reads the language
 * settings. With the languages not chosen, an unset variable whose shipped default is the new pipeline serves legacy;
 * an explicit v2 or unified gives languages_not_configured. Pure: the raw variables, the shipped defaults and the
 * settings (or a reader called at most once) are parameters.
 */
export function resolvePipelines(raw: RawPipelineEnv, defaults: ShippedPipelineDefaults, languages: LanguageSource): PipelineResolution {
  let read: LanguageSettings | null = null;
  const settings = (): LanguageSettings => {
    if (read === null) read = typeof languages === 'function' ? languages() : languages;
    return read;
  };

  const r = requestedRetrieval(raw.RAG_PIPELINE, defaults.retrieval);
  const i = requestedIngest(raw.RAG_INGEST_PIPELINE, defaults.ingest);
  const retrieval = resolvePath<RetrievalPipeline>(r.requested, r.source, 'legacy', settings);
  const ingest = resolvePath<IngestPipelineChoice>(i.requested, i.source, 'legacy', settings);
  const current = read as LanguageSettings | null;
  return {
    retrieval,
    ingest,
    servedLegacyBecauseUnset: retrieval.servedLegacyBecauseUnset || ingest.servedLegacyBecauseUnset,
    monolingual: current !== null && current.configured && current.monolingual,
    languagesRead: current !== null,
  };
}
