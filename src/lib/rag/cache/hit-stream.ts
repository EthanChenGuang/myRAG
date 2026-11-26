import type { UIMessageChunk, UIMessageStreamWriter } from 'ai';
import { writeCustomChunk } from '@/lib/ui-stream-chunks';
import { capQuotes } from '../generation/citations/record';
import type { CacheHit } from './types';

export interface StreamCachedAnswerOptions {
  writer: Pick<UIMessageStreamWriter, 'write'>;
  /** Added to the start metadata after ragTraceId and cache (e.g. answerId, refusal). */
  startMetadata?: Record<string, unknown>;
  /** Added to the finish metadata after ragTraceId and cache. */
  finishMetadata?: Record<string, unknown>;
  textId?: string;
}

/** The metadata every part of a hit carries (D-32): the trace that produced the answer and the hit marker. */
export function cacheHitMetadata(hit: CacheHit): { ragTraceId: string; cache: 'hit' } {
  return { ragTraceId: hit.answer.trace_id, cache: 'hit' };
}

const WORDS_PER_DELTA = 4;

/** D-27: a stored answer as text deltas of a few words each; the deltas concatenate to the stored text exactly. */
export function cachedAnswerDeltas(text: string): string[] {
  const words = text.match(/\s*\S+\s*/g);
  if (!words || words.length <= 1) return [text];
  const deltas: string[] = [];
  for (let index = 0; index < words.length; index += WORDS_PER_DELTA) {
    deltas.push(words.slice(index, index + WORDS_PER_DELTA).join(''));
  }
  return deltas;
}

/**
 * D-32: writes a cached answer through the normal UI message stream: start metadata, the sources part, the answer text and the
 * finish metadata with the (re-resolved) citations. No retrieval and no model call happen here.
 */
export function streamCachedAnswer(hit: CacheHit, options: StreamCachedAnswerOptions): void {
  const { writer } = options;
  const base = cacheHitMetadata(hit);
  const answer = hit.answer;
  writer.write({ type: 'start', messageMetadata: { ...base, ...options.startMetadata } } as UIMessageChunk);

  const sources = answer.is_refusal ? [] : (answer.sources ?? []);
  if (sources.length > 0) {
    writeCustomChunk(writer, {
      type: 'metadata',
      usedDocuments: sources.map((source) => ({ type: 'document' as const, id: source.document_id, name: source.name, filename: source.name })),
    });
  }

  const textId = options.textId ?? `text-${Date.now()}`;
  writer.write({ type: 'text-start', id: textId });
  for (const delta of cachedAnswerDeltas(answer.answer_text)) writer.write({ type: 'text-delta', id: textId, delta });
  writer.write({ type: 'text-end', id: textId });

  const citations = answer.is_refusal ? [] : (answer.citations ?? []);
  const citationFields =
    citations.length > 0 ? { citations: capQuotes(citations), citationStrategy: citations[0].strategy, invalidCitations: 0 } : {};
  writer.write({ type: 'finish', messageMetadata: { ...base, ...options.finishMetadata, ...citationFields } } as UIMessageChunk);
}
