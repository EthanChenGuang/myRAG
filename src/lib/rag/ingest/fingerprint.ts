import { createHash } from 'node:crypto';
import {
  IngestFingerprintPartsSchema,
  SettingsClassificationSchema,
  type IngestFingerprintParts,
  type SettingsClassification,
} from '@/lib/rag-eval/contracts.generated';
import { canonicalJson } from '@/lib/rag-eval/trace';
import rawClassification from '../../../../config/rag/settings-classification.json';
import { normalizeLanguageSettings } from '../../../../config/rag/validate-language-settings.cjs';
import { LEXICAL_VERSION } from '../lexical/chunk-text';
import { LEGACY_PROFILE } from '../embeddings/active-profile';
import { getLanguagePack, getLanguageRegistry, registryOrder } from '../lang/registry';
import { getLanguageSettings, type LanguageSettings } from '../lang/settings';
import { loadIngestConfig, type IngestConfig } from './config';
import { loadProcessingProfiles } from './profiles/load';
import { EMBEDDING_TEXT_VERSION } from './text/embedding-text';
import { requireIdentity, type StageContext } from './types';

/** The chunks of document_chunks are always the legacy chunker's; other chunking profiles are rebuilt from parse.md (Phase 4 D-21). */
export const FINGERPRINT_CHUNKING_PROFILE_ID = 'legacy';
/** Embedding profile rows are immutable: a different model or dimension is a new profile id, so every profile is at version 1. */
export const EMBEDDING_PROFILE_VERSION = 1;

const UNKNOWN = 'unknown';
const PART_TEXT_MAX = 128;

type Switches = IngestFingerprintParts['switches'];

/** D-10: sha256 over canonical sorted-key JSON of the validated parts; strings and integers only, so no float formatting moves it. */
export function buildIngestFingerprint(parts: IngestFingerprintParts): string {
  const valid = IngestFingerprintPartsSchema.parse(parts);
  return createHash('sha256').update(canonicalJson(valid), 'utf8').digest('hex');
}

/**
 * D-17: the configured supported set in registry order; unconfigured, the profile's own list. Never the order the operator typed
 * (research Pitfall 3), so the same set always gives the same codes.
 */
export function effectiveOcrLanguages(profileOcrLanguages: readonly string[], settings: LanguageSettings): string[] {
  if (settings.configured && settings.languages.length > 0) return registryOrder(settings.languages);
  return [...profileOcrLanguages];
}

function rapidOcrCode(language: string): string {
  return getLanguagePack(language)?.ocr_codes.docling?.rapidocr ?? language;
}

function llamaParseCode(language: string): string {
  return getLanguagePack(language)?.ocr_codes.llamaparse ?? language;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The languages whose OCR codes the parser actually used: RapidOCR reads the first language only (research F-4), LlamaParse all. */
export function ocrLanguagesUsed(parserUsed: string, ocrLanguages: readonly string[]): string[] {
  const first = ocrLanguages.slice(0, 1);
  switch (parserUsed) {
    case 'docling':
      return first;
    case 'llamaparse':
      return [...ocrLanguages];
    case 'mixed':
      return unique([...first, ...ocrLanguages]);
    default:
      return [];
  }
}

/** Engine codes of the parser that produced the document, prefixed by engine; a parser without OCR has none. */
export function ocrEngineCodes(parserUsed: string, ocrLanguages: readonly string[]): string[] {
  const docling = ocrLanguages.slice(0, 1).map((language) => `rapidocr:${rapidOcrCode(language)}`);
  const llamaparse = unique(ocrLanguages.map((language) => `llamaparse:${llamaParseCode(language)}`));
  switch (parserUsed) {
    case 'docling':
      return docling;
    case 'llamaparse':
      return llamaparse;
    case 'mixed':
      return [...docling, ...llamaparse];
    default:
      return [];
  }
}

/**
 * The packs this document was processed with: the languages behind its OCR codes, and with RAG_LANGUAGE_AWARE_INGEST=on every configured
 * language (per-chunk detection and sentence splitting read them all). A pack missing from the registry is left out.
 */
export function languagePackVersions(ocrLanguages: string[], settings: LanguageSettings, languageAware: Switches['language_aware_ingest']): Record<string, number> {
  const codes = new Set(ocrLanguages);
  if (languageAware === 'on' && settings.configured) for (const code of settings.languages) codes.add(code);
  const versions: Record<string, number> = {};
  for (const code of codes) {
    const pack = getLanguagePack(code);
    if (pack) versions[code] = pack.pack_version;
  }
  return versions;
}

export function switchesOf(config: Pick<IngestConfig, 'languageAwareIngest' | 'tableHeaderRepeat' | 'tableRowSerialization' | 'captionLanguage'>): Switches {
  return {
    language_aware_ingest: config.languageAwareIngest,
    table_header_repeat: config.tableHeaderRepeat,
    table_row_serialization: config.tableRowSerialization ? 'true' : 'false',
    caption_language: config.captionLanguage,
  };
}

function partText(value: string | null | undefined): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length === 0 ? UNKNOWN : text.slice(0, PART_TEXT_MAX);
}

/** A resumed run holds 'stored' in memory; the state keeps the version the parse reported. */
function parserVersionOf(ctx: StageContext): string {
  const inMemory = ctx.work.parserVersion;
  if (inMemory && inMemory !== 'stored') return partText(inMemory);
  return partText(ctx.state.parserVersion ?? ctx.state.typeChange?.reusedParser?.version ?? null);
}

/** D-10: the parts of the version this run publishes, from the run's own state and configuration (no read). */
export function collectFingerprintParts(ctx: StageContext): IngestFingerprintParts {
  const identity = requireIdentity(ctx, 'publish');
  const settings = getLanguageSettings();
  const parserUsed = partText(ctx.parserUsed);
  const switches = switchesOf(ctx.config);
  const ocrLanguages = effectiveOcrLanguages(identity.profile.parser.ocr_languages, settings);
  const used = ocrLanguagesUsed(parserUsed, ocrLanguages);
  return IngestFingerprintPartsSchema.parse({
    parser_used: parserUsed,
    parser_version: parserVersionOf(ctx),
    processing_profile_id: identity.profile.id,
    processing_profile_version: identity.profile.version,
    ocr_engine_codes: ocrEngineCodes(parserUsed, ocrLanguages),
    chunking_profile_id: FINGERPRINT_CHUNKING_PROFILE_ID,
    lexical_version: LEXICAL_VERSION,
    embedding_text_version: EMBEDDING_TEXT_VERSION,
    embedding_profile_id: partText(ctx.state.embeddingTargets[0] ?? LEGACY_PROFILE.id),
    embedding_profile_version: EMBEDDING_PROFILE_VERSION,
    language_pack_versions: languagePackVersions(used, settings, switches.language_aware_ingest),
    switches,
  });
}

const SWITCH_VARIABLES = ['RAG_LANGUAGE_AWARE_INGEST', 'RAG_TABLE_HEADER_REPEAT', 'RAG_TABLE_ROW_SERIALIZATION', 'RAG_CAPTION_LANGUAGE'] as const;
const LANGUAGE_VARIABLES = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;

function has(proposed: Record<string, string | undefined>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(proposed, name) && proposed[name] !== undefined;
}

function profileOcrLanguages(profileId: string): string[] | null {
  const profile = loadProcessingProfiles().profiles.find((candidate) => candidate.id === profileId);
  return profile ? [...profile.parser.ocr_languages] : null;
}

/**
 * The fingerprint a stored version would have under the proposed settings (plan 03.2-18): the switch parts take the proposed values, and
 * a proposed language set recomputes the OCR codes and packs of the version's own parser. Parts no setting controls stay as stored.
 */
export function expectedFingerprintFor(
  parts: IngestFingerprintParts,
  proposed: Record<string, string | undefined>,
): { parts: IngestFingerprintParts; fingerprint: string } {
  const stored = IngestFingerprintPartsSchema.parse(parts);
  let switches = stored.switches;
  if (SWITCH_VARIABLES.some((name) => has(proposed, name))) {
    const env: Record<string, string | undefined> = {
      RAG_LANGUAGE_AWARE_INGEST: stored.switches.language_aware_ingest,
      RAG_TABLE_HEADER_REPEAT: stored.switches.table_header_repeat,
      RAG_TABLE_ROW_SERIALIZATION: stored.switches.table_row_serialization,
      RAG_CAPTION_LANGUAGE: stored.switches.caption_language,
    };
    for (const name of SWITCH_VARIABLES) if (has(proposed, name)) env[name] = proposed[name];
    switches = switchesOf(loadIngestConfig(env));
  }

  let ocrCodes = stored.ocr_engine_codes;
  let packs = stored.language_pack_versions;
  const languagesChange = LANGUAGE_VARIABLES.some((name) => has(proposed, name));
  if (languagesChange || switches.language_aware_ingest !== stored.switches.language_aware_ingest) {
    const current = getLanguageSettings();
    const supported = has(proposed, 'RAG_SUPPORTED_LANGUAGES') ? proposed.RAG_SUPPORTED_LANGUAGES : current.languages.join(',');
    const primary = has(proposed, 'RAG_PRIMARY_LANGUAGE') ? proposed.RAG_PRIMARY_LANGUAGE : (current.primary ?? undefined);
    const settings: LanguageSettings = normalizeLanguageSettings(supported, primary, getLanguageRegistry());
    const fallback = profileOcrLanguages(stored.processing_profile_id);
    if (fallback !== null || settings.configured) {
      const ocrLanguages = effectiveOcrLanguages(fallback ?? [], settings);
      ocrCodes = ocrEngineCodes(stored.parser_used, ocrLanguages);
      packs = languagePackVersions(ocrLanguagesUsed(stored.parser_used, ocrLanguages), settings, switches.language_aware_ingest);
    }
  }

  const next = IngestFingerprintPartsSchema.parse({ ...stored, ocr_engine_codes: ocrCodes, language_pack_versions: packs, switches });
  return { parts: next, fingerprint: buildIngestFingerprint(next) };
}

export type RebuildMechanism = Extract<SettingsClassification['entries'][number], { mechanism: string }>['mechanism'];

let classification: SettingsClassification | null = null;

/** D-09: config/rag/settings-classification.json, validated once with the generated schema. */
export function getSettingsClassification(): SettingsClassification {
  if (!classification) classification = SettingsClassificationSchema.parse(rawClassification);
  return classification;
}

/** The proposed keys that are ingestion-side (or both), with their rebuild mechanism, sorted by name; query-side and unknown keys are left out. */
export function ingestionKeysOf(proposed: Record<string, unknown>): Array<{ name: string; mechanism: RebuildMechanism }> {
  const byName = new Map(getSettingsClassification().entries.map((entry) => [entry.name, entry]));
  const keys: Array<{ name: string; mechanism: RebuildMechanism }> = [];
  for (const name of Object.keys(proposed).sort()) {
    const entry = byName.get(name);
    if (entry && 'mechanism' in entry) keys.push({ name, mechanism: entry.mechanism });
  }
  return keys;
}
