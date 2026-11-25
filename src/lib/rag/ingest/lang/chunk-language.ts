import type { LanguageDetection } from '../../lang/detect';

export const UND = 'und';
export const UND_CONFIDENCE_FLOOR = 0.15;

export interface ChunkLanguageOptions {
  candidates: readonly string[];
  primary: string | null;
  monolingual: boolean;
}

export interface ChunkLanguage {
  language: string;
  confidence: number;
}

export interface DocumentLanguages {
  language: string | null;
  languages: string[];
}

export function roundConfidence(value: number): number {
  return value;
}

export function chunkLanguageFrom(_detection: LanguageDetection): ChunkLanguage {
  return { language: UND, confidence: 0 };
}

export function detectChunkLanguage(_text: string, _options: ChunkLanguageOptions): ChunkLanguage {
  return { language: UND, confidence: 0 };
}

export function detectChunkLanguages(chunks: readonly string[], options: ChunkLanguageOptions): ChunkLanguage[] {
  return chunks.map((text) => detectChunkLanguage(text, options));
}

export function processingLanguage(language: string, _primary: string | null): string | null {
  return language;
}

export function documentLanguages(_results: readonly ChunkLanguage[], _tokenCounts: readonly number[]): DocumentLanguages {
  return { language: null, languages: [] };
}
