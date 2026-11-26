import { resolveAnswerLanguage } from '../lang/answer-language';
import { getLanguageSettings, languageVariablesUnset } from '../lang/settings';
import { fixedText } from '../lang/texts';

/** The document columns the labels read (0301 version and doc_date, 0801 effective_from, 0941 version_label). */
export interface VersionSource {
  version?: number | null;
  version_label?: string | null;
  effective_from?: string | null;
  doc_date?: string | null;
}

/** While no language is configured the label texts come from the English pack, as fixedText falls back. */
const UNCONFIGURED_LANGUAGE = 'en';
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/;

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value.trim());
  return match ? match[1]! : null;
}

/** D-49: documents.version_label, else the integer version through labels.version; null when neither exists. */
export function versionLabelOf(row: VersionSource, language: string): string | null {
  const label = typeof row.version_label === 'string' ? row.version_label.trim() : '';
  if (label.length > 0) return label;
  if (typeof row.version === 'number' && Number.isSafeInteger(row.version)) {
    return fixedText('labels.version', language, { version: String(row.version) });
  }
  return null;
}

/** D-49: effective_from, else the stored document date, else null; always ISO YYYY-MM-DD. */
export function effectiveDateOf(row: VersionSource): string | null {
  return isoDate(row.effective_from) ?? isoDate(row.doc_date);
}

/** D-50: the version and effective-date labels appended to a block title; empty when neither value exists. */
export function versionHeaderSuffix(row: VersionSource, language: string): string {
  const parts: string[] = [];
  const version = versionLabelOf(row, language);
  if (version !== null) parts.push(version);
  const date = effectiveDateOf(row);
  if (date !== null) parts.push(fixedText('labels.effective_from', language, { date }));
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

/**
 * The label language: the question's language among the enabled languages, else RAG_PRIMARY_LANGUAGE (the answer-language
 * resolver without the conversation and UI steps); English while the languages are unset. The question is never logged.
 */
export function versionLabelLanguage(question: unknown): string {
  if (languageVariablesUnset()) return UNCONFIGURED_LANGUAGE;
  const settings = getLanguageSettings();
  if (!settings.configured || !settings.primary) return UNCONFIGURED_LANGUAGE;
  return resolveAnswerLanguage({
    question: typeof question === 'string' ? question : '',
    previousTurnLanguage: null,
    uiLanguage: null,
    enabled: settings.languages,
    primary: settings.primary,
  }).language;
}
