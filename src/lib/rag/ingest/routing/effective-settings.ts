import { getLanguagePack, registryOrder } from '../../lang/registry';
import { getLanguageSettings } from '../../lang/settings';
import type { IngestConfig } from '../config';
import type { ProcessingProfile } from '../profiles/load';
import type { JobSettingsSnapshotWire } from '../wire-defaults';

/** The language settings the effective values are computed from (lang/settings.ts, or a job's frozen snapshot). */
export interface EffectiveLanguageInput {
  configured: boolean;
  languages: readonly string[];
  primary: string | null;
}

export interface EffectiveIngestSettingsInput {
  ingestConfig: Pick<IngestConfig, 'languageAwareIngest' | 'tableHeaderRepeat' | 'tableRowSerialization'>;
  profile: ProcessingProfile;
  languageSettings: EffectiveLanguageInput;
}

export interface EffectiveIngestSettings {
  /** Language codes for the Docling request and the snapshot, in registry order; the profile's list when the languages are unset. */
  ocrLanguages: string[];
  /** The primary language ocrLanguages was built from; null when the profile's list applies. */
  ocrPrimaryLanguage: string | null;
  /** LlamaParse codes, primary first; empty when the languages are unset (the request then carries none). */
  llamaparseLanguages: string[];
  languageAware: boolean;
  /** The configured languages in registry order, only with RAG_LANGUAGE_AWARE_INGEST=on. */
  languages: string[];
  primaryLanguage: string | null;
  /** The header flag after RAG_TABLE_HEADER_REPEAT: true with `always`, the profile's repeat_table_header otherwise. */
  repeatTableHeader: boolean;
  /** RAG_TABLE_HEADER_REPEAT=always: the snapshot records the flag instead of leaving it to the profile. */
  repeatTableHeaderForced: boolean;
  carryTableHeader: boolean;
  rowSerialization: boolean;
}

const DEFAULT_SWITCHES: EffectiveIngestSettingsInput['ingestConfig'] = { languageAwareIngest: 'off', tableHeaderRepeat: 'profile', tableRowSerialization: false };
const UNSET: EffectiveLanguageInput = { configured: false, languages: [], primary: null };

/** The table-header part of the effective settings: the only input the chunkers need of RAG_TABLE_HEADER_REPEAT. */
export interface EffectiveTableHeader {
  /** True with `always`, the profile's repeat_table_header otherwise. */
  repeatTableHeader: boolean;
  repeatTableHeaderForced: boolean;
  /** D-20: a header-less continuation table takes the previous table's header; only with `always`. */
  carryTableHeader: boolean;
}

/** D-19: the effective header flag; `profile` (or absent) is the processing profile's own value, so chunking stays as today. */
export function effectiveTableHeader(
  mode: IngestConfig['tableHeaderRepeat'] | undefined,
  chunker: Pick<ProcessingProfile['chunker'], 'repeat_table_header'>,
): EffectiveTableHeader {
  const forced = mode === 'always';
  return { repeatTableHeader: forced ? true : chunker.repeat_table_header, repeatTableHeaderForced: forced, carryTableHeader: forced };
}

/** The language settings for an ingestion run: read only on the unified pipeline, so the legacy path never reads them (D-02). */
export function ingestLanguageSettings(config: Pick<IngestConfig, 'pipeline' | 'pipelineBlocked'>): EffectiveLanguageInput {
  if (config.pipeline !== 'unified' || config.pipelineBlocked !== null) return UNSET;
  return getLanguageSettings();
}

/** The configured languages that have OCR codes for both parsers, in registry order; empty when unset. */
function ocrCapable(settings: EffectiveLanguageInput): string[] {
  if (!settings.configured) return [];
  return registryOrder(settings.languages).filter((code) => {
    const pack = getLanguagePack(code);
    return pack?.ocr_codes.docling != null && pack.ocr_codes.llamaparse != null;
  });
}

/**
 * D-17, D-19, D-22: the one place the effective ingestion settings are decided. Docling and the snapshot get language codes in registry
 * order, never in the typed order, so parse-cache keys do not depend on it (research Pitfall 3); LlamaParse gets its own codes with the
 * primary first (research F-3). With the languages unset the profile's ocr_languages apply and LlamaParse gets none. The profile is never edited.
 */
export function effectiveIngestSettings(input: EffectiveIngestSettingsInput): EffectiveIngestSettings {
  const { ingestConfig, profile, languageSettings } = input;
  const codes = ocrCapable(languageSettings);
  const primary = languageSettings.primary !== null && codes.includes(languageSettings.primary) ? languageSettings.primary : null;
  const fromSettings = codes.length > 0 && primary !== null;
  const llamaparse = fromSettings
    ? [primary, ...codes.filter((code) => code !== primary)].map((code) => getLanguagePack(code)?.ocr_codes.llamaparse as string)
    : [];
  const languageAware = ingestConfig.languageAwareIngest === 'on';
  const aware = languageAware && languageSettings.configured ? registryOrder(languageSettings.languages) : [];
  const header = effectiveTableHeader(ingestConfig.tableHeaderRepeat, profile.chunker);
  return {
    ocrLanguages: fromSettings ? codes : [...profile.parser.ocr_languages],
    ocrPrimaryLanguage: fromSettings ? primary : null,
    llamaparseLanguages: [...new Set(llamaparse)],
    languageAware,
    languages: aware,
    primaryLanguage: languageSettings.primary !== null && aware.includes(languageSettings.primary) ? languageSettings.primary : null,
    ...header,
    rowSerialization: ingestConfig.tableRowSerialization,
  };
}

/** The effective settings of a queued job, rebuilt from its frozen snapshot: later changes of the variables do not reach it. */
export function effectiveIngestSettingsFromSnapshot(snapshot: JobSettingsSnapshotWire, profile: ProcessingProfile): EffectiveIngestSettings {
  const primary = snapshot.ocr_primary_language ?? null;
  const languageSettings: EffectiveLanguageInput =
    primary !== null && snapshot.ocr_languages.includes(primary) ? { configured: true, languages: snapshot.ocr_languages, primary } : UNSET;
  const fromSnapshot = effectiveIngestSettings({ ingestConfig: DEFAULT_SWITCHES, profile, languageSettings });
  const languages = snapshot.languages ?? [];
  const forced = snapshot.repeat_table_header_effective;
  return {
    ...fromSnapshot,
    // A snapshot written before D-17 has no primary: its own list is still what the job was enqueued with.
    ocrLanguages: [...snapshot.ocr_languages],
    languageAware: snapshot.language_aware === true,
    languages: [...languages],
    primaryLanguage: snapshot.primary_language ?? null,
    repeatTableHeader: forced === true || forced === false ? forced : profile.chunker.repeat_table_header,
    repeatTableHeaderForced: forced === true || forced === false,
    carryTableHeader: snapshot.carry_table_header === true,
    rowSerialization: snapshot.row_serialization === true,
  };
}
