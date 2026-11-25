import type { EnhancedMetadata } from '@/lib/temporal-metadata-extractor';
import { extractDates, pickDocDate } from './dates';
import type { StageContext } from '../types';
import { computeEnhancedMetadata, extractFinancial } from './financial';
import { invoiceExtractor } from './invoice';

export { pickDocDate };

export interface DateCandidate {
  iso: string;
  confidence: number;
  position: number;
}

export interface ChunkExtractorInput {
  content: string;
  enhanced: EnhancedMetadata;
}

export interface ChunkExtraction {
  metadata: Record<string, unknown>;
  dateCandidates?: DateCandidate[];
}

export type ChunkExtractor = (input: ChunkExtractorInput) => ChunkExtraction;

/** An extractor that reads the whole document once, after the chunk-level extractors, and writes through the stage context. */
export interface DocumentExtractor {
  level: 'document';
  run(ctx: StageContext): Promise<void>;
}

export type Extractor = ChunkExtractor | DocumentExtractor;

/** Extractor names a processing profile may list, mapped to their implementation. `urls` is done by enrich. */
export const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  dates: extractDates,
  financial: extractFinancial,
  invoice: invoiceExtractor,
};

/** Keys storeDocument writes on every chunk whatever the document type, so legacy ranking sees them everywhere. */
function genericKeys(enhanced: EnhancedMetadata): Record<string, unknown> {
  return {
    section_type: enhanced.section_type,
    key_terms: enhanced.key_terms,
    chunk_semantic_type: enhanced.chunk_semantic_type,
  };
}

/**
 * Runs the listed extractors over one chunk. The legacy metadata is computed once; each listed extractor keeps its own keys and
 * the generic keys are always present. Names without an implementation here are skipped (the stage reports them).
 */
export function runChunkExtractors(
  names: readonly string[],
  chunk: { content: string },
): { metadata: Record<string, unknown>; dateCandidates: DateCandidate[] } {
  const enhanced = computeEnhancedMetadata(chunk.content);
  const metadata: Record<string, unknown> = genericKeys(enhanced);
  const dateCandidates: DateCandidate[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const extractor = Object.hasOwn(EXTRACTORS, name) ? EXTRACTORS[name] : undefined;
    if (typeof extractor !== 'function') continue;
    const result = extractor({ content: chunk.content, enhanced });
    Object.assign(metadata, result.metadata);
    if (result.dateCandidates) dateCandidates.push(...result.dateCandidates);
  }
  return { metadata, dateCandidates };
}

export function hasExtractor(name: string): boolean {
  return Object.hasOwn(EXTRACTORS, name);
}

/** The document-level extractors among the listed names, in profile order. */
export function documentExtractors(names: readonly string[]): DocumentExtractor[] {
  const out: DocumentExtractor[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const extractor = Object.hasOwn(EXTRACTORS, name) ? EXTRACTORS[name] : undefined;
    if (extractor && typeof extractor !== 'function') out.push(extractor);
  }
  return out;
}
