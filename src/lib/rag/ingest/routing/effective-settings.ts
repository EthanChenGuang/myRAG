import { getLanguagePack, registryOrder } from '../../lang/registry';
import { getLanguageSettings, languageVariablesUnset } from '../../lang/settings';
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

/** The OCR-capable configured codes and the primary they are built around; primary is null when the settings do not apply. */
function ocrSelection(settings: EffectiveLanguageInput): { codes: string[]; primary: string | null } {
  const codes = ocrCapable(settings);
  const primary = settings.primary !== null && codes.includes(settings.primary) ? settings.primary : null;
  return { codes, primary: codes.length > 0 ? primary : null };
}

/** LlamaParse codes of the configured languages, primary first (research F-3); empty when the languages are unset. */
function llamaparseCodes(settings: EffectiveLanguageInput): string[] {
  const { codes, primary } = ocrSelection(settings);
  if (primary === null) return [];
  const ordered = [primary, ...codes.filter((code) => code !== primary)];
  return [...new Set(ordered.map((code) => getLanguagePack(code)?.ocr_codes.llamaparse as string))];
}

/**
 * D-16: the LlamaParse codes for the two legacy call sites, which run under either ingest pipeline. With both language variables blank it
 * returns [] without reading the settings (D-02), and the caller sends today's request byte for byte.
 */
export function legacyLlamaparseLanguages(): string[] {
  if (languageVariablesUnset()) return [];
  return llamaparseCodes(getLanguageSettings());
}

/**
 * D-17, D-19, D-22: the one place the effective ingestion settings are decided. Docling and the snapshot get language codes in registry
 * order, never in the typed order, so parse-cache keys do not depend on it (research Pitfall 3); LlamaParse gets its own codes with the
 * primary first (research F-3). With the languages unset the profile's ocr_languages apply and LlamaParse gets none. The profile is never edited.
 */
export function effectiveIngestSettings(input: EffectiveIngestSettingsInput): EffectiveIngestSettings {
  const { ingestConfig, profile, languageSettings } = input;
  const { codes, primary } = ocrSelection(languageSettings);
  const fromSettings = primary !== null;
  const languageAware = ingestConfig.languageAwareIngest === 'on';
  const aware = languageAware && languageSettings.configured ? registryOrder(languageSettings.languages) : [];
  const forced = ingestConfig.tableHeaderRepeat === 'always';
  return {
    ocrLanguages: fromSettings ? codes : [...profile.parser.ocr_languages],
    ocrPrimaryLanguage: fromSettings ? primary : null,
    llamaparseLanguages: llamaparseCodes(languageSettings),
    languageAware,
    languages: aware,
    primaryLanguage: languageSettings.primary !== null && aware.includes(languageSettings.primary) ? languageSettings.primary : null,
    repeatTableHeader: forced ? true : profile.chunker.repeat_table_header,
    repeatTableHeaderForced: forced,
    carryTableHeader: forced,
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
