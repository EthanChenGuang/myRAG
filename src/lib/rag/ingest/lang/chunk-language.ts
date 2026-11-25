import { detectLanguageWithConfidence, type LanguageDetection } from '../../lang/detect';
import { registryOrder } from '../../lang/registry';

/** The stored language of a chunk whose language could not be told (no letters, or below the confidence floor). */
export const UND = 'und';

/**
 * Below this (4-decimal) confidence a chunk is `und`. Fitted on tests/fixtures/ingest/lang-vectors.json: the lowest confidence of a
 * vector marked confident is 0.1667 (two stopwords against one), and a stopword tie is 0, so every confident vector stays detected.
 */
export const UND_CONFIDENCE_FLOOR = 0.15;

/** A document language is listed in documents.languages when it holds at least 1/LISTED_SHARE_DIVISOR of the detected tokens. */
const LISTED_SHARE_DIVISOR = 10;

export interface ChunkLanguageOptions {
  /** The enabled languages (RAG_SUPPORTED_LANGUAGES). */
  candidates: readonly string[];
  /** RAG_PRIMARY_LANGUAGE: the pack a `und` chunk is processed with. */
  primary: string | null;
  /** D-03: one enabled language; every chunk gets it with confidence 1 and `und` is never written. */
  monolingual: boolean;
}

export interface ChunkLanguage {
  language: string;
  /** 0..1, rounded to 4 decimals. */
  confidence: number;
}

export function roundConfidence(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return Math.round(value * 10000) / 10000;
}

export function detectChunkLanguage(text: string, options: ChunkLanguageOptions): ChunkLanguage {
  const candidates = registryOrder(options.candidates);
  if (options.monolingual && candidates.length > 0) return { language: candidates[0]!, confidence: 1 };
  if (candidates.length === 0) return { language: UND, confidence: 0 };
  return chunkLanguageFrom(detectLanguageWithConfidence(text, candidates));
}

/** The floor rule on a detector answer: `und` without a confident language or below the floor, compared on the stored 4 decimals. */
export function chunkLanguageFrom(detection: LanguageDetection): ChunkLanguage {
  const confidence = roundConfidence(detection.confidence);
  if (detection.language === null || !detection.confident || confidence < UND_CONFIDENCE_FLOOR) return { language: UND, confidence };
  return { language: detection.language, confidence };
}

/** D-13: each chunk's own language among the enabled languages, `und` below the floor or without letters. */
export function detectChunkLanguages(chunks: readonly string[], options: ChunkLanguageOptions): ChunkLanguage[] {
  return chunks.map((text) => detectChunkLanguage(text, options));
}

/** The pack a chunk is processed with: its own language, the primary language for `und`. */
export function processingLanguage(language: string, primary: string | null): string | null {
  return language === UND ? primary : language;
}

export interface DocumentLanguages {
  /** The dominant language by cl100k_base tokens; null when no chunk has a detected language. */
  language: string | null;
  /** Every language with at least 10% of the detected tokens, in registry order. */
  languages: string[];
}

/**
 * The document language and language list from the per-chunk results and their token counts (lined up). `und` tokens count for no
 * language and are left out of the total, so the dominant language is always listed. Equal totals go to the earlier registry language.
 */
export function documentLanguages(results: readonly ChunkLanguage[], tokenCounts: readonly number[]): DocumentLanguages {
  const tokens = new Map<string, number>();
  let total = 0;
  results.forEach((result, index) => {
    if (result.language === UND) return;
    const count = Math.max(0, Math.trunc(tokenCounts[index] ?? 0));
    tokens.set(result.language, (tokens.get(result.language) ?? 0) + count);
    total += count;
  });
  if (total === 0) return { language: null, languages: [] };
  const ordered = registryOrder([...tokens.keys()]);
  let language: string | null = null;
  let best = 0;
  for (const code of ordered) {
    const count = tokens.get(code) ?? 0;
    if (count > best) {
      best = count;
      language = code;
    }
  }
  const languages = ordered.filter((code) => {
    const count = tokens.get(code) ?? 0;
    return count > 0 && count * LISTED_SHARE_DIVISOR >= total;
  });
  return { language, languages };
}
