import { detectLanguageWithConfidence, type LanguageDetection } from '../lang/detect';
import type { RetrievalResult } from '../types';
import { toLanguageCode } from './query-codes';

const UNDETERMINED = 'und';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The single mapping from the detector to a stored confidence; Phase 7 may replace it with a calibrated score. */
export function queryLanguageConfidence(detection: LanguageDetection, storedLanguage: string | null): number | null {
  const detected = toLanguageCode(detection.language);
  if (detected === null || detected !== storedLanguage) return null;
  return detection.confident ? 1 : 0.5;
}

function chunkLanguages(result: RetrievalResult): string[] {
  const languageById = new Map<string, string | null>();
  for (const item of result.candidates) {
    if (!languageById.has(String(item.chunk_id))) languageById.set(String(item.chunk_id), toLanguageCode(item.language));
  }
  const ordered = result.kept
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => (finite(a.chunk.rank) && finite(b.chunk.rank) ? a.chunk.rank - b.chunk.rank : 0) || a.index - b.index);
  const languages: string[] = [];
  for (const { chunk } of ordered) {
    const language = languageById.get(String(chunk.chunk_id)) ?? UNDETERMINED;
    if (!languages.includes(language)) languages.push(language);
  }
  return languages;
}

/** The FBK-01 language codes of one request (D-03a); codes only, a value that is not a code is left out (null, or und for a chunk). */
export interface LogLanguageCodes {
  query_language: string | null;
  query_language_confidence: number | null;
  chunk_languages: string[];
  answer_language: string | null;
}

/** The one derivation of the logged languages, shared by the retrieval log row and the trace languages block (LANG-10). */
export function logLanguageCodes(result: RetrievalResult, query: string | undefined): LogLanguageCodes {
  const detection = detectLanguageWithConfidence(typeof query === 'string' ? query : '');
  const queryLanguage = toLanguageCode(result.queryLanguage) ?? toLanguageCode(detection.language);
  return {
    query_language: queryLanguage,
    query_language_confidence: queryLanguageConfidence(detection, queryLanguage),
    chunk_languages: chunkLanguages(result),
    answer_language: toLanguageCode(result.logOutcome?.answerLanguage),
  };
}
