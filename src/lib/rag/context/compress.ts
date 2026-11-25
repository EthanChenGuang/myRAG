import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import type { RerankSpan } from '@/lib/rag/rerank/types';

export const MIN_COMPRESS_TOKENS = 150;

export interface CompressibleChunk {
  chunk_id: string;
  content: string;
  chunk_kind?: string | null;
  metadata?: Record<string, unknown> | null;
  language?: string | null;
  mergedParent?: boolean;
}

export interface CompressOptions {
  query: string;
  spansByChunk?: Map<string, RerankSpan[]>;
  prefixLengthByChunk?: Map<string, number>;
  enabled: boolean;
  keepRatio?: number;
}

function isCompressible(chunk: CompressibleChunk): boolean {
  if (chunk.mergedParent) return false;
  if (chunk.chunk_kind === 'table' || chunk.chunk_kind === 'image') return false;
  if (chunk.metadata && typeof chunk.metadata.image_url === 'string' && chunk.metadata.image_url) return false;
  if (countTokens(chunk.content) < MIN_COMPRESS_TOKENS) return false;
  return true;
}

function applySpans(content: string, spans: RerankSpan[], prefixLength: number): string | null {
  const units = [...content];
  const parts: string[] = [];
  for (const span of spans) {
    if (span.end <= prefixLength) continue;
    const start = Math.max(span.start, prefixLength);
    const end = Math.min(span.end, units.length);
    if (start >= end) continue;
    parts.push(units.slice(start, end).join(''));
  }
  if (parts.length === 0) return null;
  return parts.join(' ');
}

interface SentencePiece {
  text: string;
  index: number;
}

function splitSentences(text: string, language: string | null | undefined): SentencePiece[] {
  const locale = language && language.length >= 2 ? language : 'en';
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const pieces: SentencePiece[] = [];
  let index = 0;
  for (const part of segmenter.segment(text)) {
    const sentence = part.segment;
    if (!sentence.trim()) continue;
    pieces.push({ text: sentence, index });
    index += 1;
  }
  return pieces;
}

function scoreSentences(sentences: SentencePiece[], queryTokens: string[]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const sentence of sentences) {
    const normalized = sentence.text.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (token && normalized.includes(token)) score += 1;
    }
    scores.set(sentence.index, score);
  }
  return scores;
}

function compressLocal(chunk: CompressibleChunk, query: string, keepRatio: number): string {
  const sentences = splitSentences(chunk.content, chunk.language);
  if (sentences.length === 0) return chunk.content;
  const queryTokens = queryLexicalTokens(query);
  const scores = scoreSentences(sentences, queryTokens);
  const keepCount = Math.max(1, Math.ceil(sentences.length * keepRatio));
  const ranked = [...sentences].sort((a, b) => {
    const ds = (scores.get(b.index) ?? 0) - (scores.get(a.index) ?? 0);
    return ds !== 0 ? ds : a.index - b.index;
  });
  const kept = new Set(ranked.slice(0, keepCount).map((s) => s.index));
  return sentences
    .filter((s) => kept.has(s.index))
    .map((s) => s.text)
    .join('');
}

export function compressChunks(chunks: CompressibleChunk[], options: CompressOptions): CompressibleChunk[] {
  if (!options.enabled) return chunks;

  const keepRatio = options.keepRatio ?? 0.5;
  return chunks.map((chunk) => {
    if (!isCompressible(chunk)) return chunk;
    const spans = options.spansByChunk?.get(chunk.chunk_id);
  const prefixLength = options.prefixLengthByChunk?.get(chunk.chunk_id) ?? 0;
    if (spans && spans.length > 0) {
      const spanText = applySpans(chunk.content, spans, prefixLength);
      if (spanText !== null) {
        return { ...chunk, content: spanText };
      }
      return chunk;
    }
    const compressed = compressLocal(chunk, options.query, keepRatio);
    return { ...chunk, content: compressed };
  });
}