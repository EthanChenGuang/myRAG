import type { ChunkWithScore } from '../rerank/local-hybrid';
import type { VoiceChunk } from '../voice/keyword-fallback';
import type { PackingSummary } from '../types';
import { IMAGE_EXTENSIONS } from './assemble';
import { packByRank } from './pack';
import { wrapDocuments, type WrapDoc } from './wrap';

export interface VoiceResult extends ChunkWithScore {
  image_url: string | null;
}

export interface VoiceSourceImage {
  url: string;
  name: string;
  type: string;
}

export interface VoiceResults {
  results: VoiceResult[];
  source_images: VoiceSourceImage[];
  /** The tagged context over the final results; present only with RAG_CONTEXT_TAGGING=true and at least one result. */
  context?: string;
}

const PERSON_TERMS = ['carlos', 'marcial', 'creator', 'founder', 'maker', 'author'];

function imageMeta(chunk: VoiceResult): string {
  return `${chunk.metadata?.name || ''} ${chunk.metadata?.image_context || ''}`.toLowerCase();
}

/** Normalises candidates for the local reranker; the metadata suffix lets "logo" in a filename count. */
export function enrichVoiceCandidates(chunks: VoiceChunk[]): ChunkWithScore[] {
  return chunks
    .filter((c) => c)
    .map((c) => ({
      chunk_id: c.id || c.chunk_id || 'unknown',
      document_id: c.document_id || 'unknown',
      content: `${c.content || ''}\n[Metadata: ${c.metadata?.image_context || ''} ${c.metadata?.name || ''} ${c.metadata?.document_title || ''}]`,
      similarity: c.similarity || 0,
      metadata: c.metadata || {},
    }));
}

/** The voice results plus, only when a document budget was given, what packing did; callers keep packing off the wire payload. */
export type VoiceAssembly = VoiceResults & { packing?: PackingSummary };

/**
 * D-83: the ranked voice chunks packed to the budget in their order, sized as the agent renders them; each position is its own
 * unit, since voice chunks carry no parent and may share the placeholder id.
 */
function packVoiceChunks(chunks: ChunkWithScore[], budget: number): { chunks: ChunkWithScore[]; packing: PackingSummary } {
  const units = chunks.map((chunk, index) => ({
    chunk_id: String(index),
    document_id: chunk.document_id,
    document_filename: String(chunk.metadata?.filename ?? chunk.metadata?.name ?? ''),
    content: chunk.content,
    parent_id: null,
  }));
  const packed = packByRank(units, budget, (unit) => untaggedVoiceContext([unit]), { imageExtensions: IMAGE_EXTENSIONS, order: 'input' });
  const kept = packed.selected.map((unit) => {
    const chunk = chunks[Number(unit.chunk_id)]!;
    const content = packed.contentOverrides.get(unit.chunk_id);
    return content === undefined ? chunk : { ...chunk, content };
  });
  return {
    chunks: kept,
    packing: { documentBudget: packed.documentBudget, droppedDocuments: packed.droppedDocuments, keptParents: packed.keptParents },
  };
}

export function assembleVoiceResults(input: {
  query: string;
  chunks: ChunkWithScore[];
  matchCount: number;
  /** D-83: absent or null leaves the results exactly as today. */
  documentTokenBudget?: number | null;
}): VoiceAssembly {
  const { query, matchCount } = input;
  const top = input.chunks.slice(0, matchCount);
  const budget = input.documentTokenBudget ?? null;
  const packedVoice = budget === null ? null : packVoiceChunks(top, budget);
  const results: VoiceResult[] = (packedVoice?.chunks ?? top).map((c) => ({
    ...c,
    similarity: c.rerankScore || c.similarity,
    image_url: c.metadata?.image_url || null,
  }));

  let imageChunks = results.filter((r) => r.image_url);

  const qLower = query.toLowerCase();
  const isPersonIntent = ['who', 'creator', 'founder', 'created', 'maker', 'author'].some((w) => qLower.includes(w));
  const isLogoIntent = qLower.includes('logo');

  if (isPersonIntent) {
    const personImages = imageChunks.filter((r) => PERSON_TERMS.some((t) => imageMeta(r).includes(t)));
    if (personImages.length > 0) imageChunks = personImages;
  } else if (isLogoIntent) {
    const logoImages = imageChunks.filter((r) => imageMeta(r).includes('logo'));
    if (logoImages.length > 0) imageChunks = logoImages;
  } else if (imageChunks.some((r) => imageMeta(r).includes('logo'))) {
    imageChunks = imageChunks.filter((r) => !PERSON_TERMS.some((t) => imageMeta(r).includes(t)));
  }

  const source_images: VoiceSourceImage[] = imageChunks.map((r) => ({
    url: r.image_url as string,
    name: r.metadata?.name || r.metadata?.filename || 'Source Image',
    type: r.metadata?.type || 'image/jpeg',
  }));

  return packedVoice ? { results, source_images, packing: packedVoice.packing } : { results, source_images };
}

function voiceSource(result: VoiceResult): string | undefined {
  const metadata = result.metadata ?? {};
  for (const value of [metadata.filename, metadata.document_title, metadata.name]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** The wrapped voice context: one <doc id="c<n>"> per final result in order, the document filename as source. */
export function voiceContext(results: readonly VoiceResult[], flaggedChunkIds?: ReadonlySet<string>): string | null {
  const docs: WrapDoc[] = results.map((result, index) => {
    const doc: WrapDoc = { id: `c${index + 1}`, text: result.content };
    const source = voiceSource(result);
    if (source) doc.source = source;
    if (flaggedChunkIds?.has(result.chunk_id)) doc.flagged = true;
    return doc;
  });
  return wrapDocuments(docs);
}

/**
 * The context string the voice agent builds itself when the response carries none (voice-agent/src/rag_client.ts). Phase 5.2
 * D-07 sends it with the voice block appended when tagging is off, so the agent reads the same context and needs no change.
 */
export function untaggedVoiceContext(results: ReadonlyArray<Pick<VoiceResult, 'document_id' | 'content'>>): string {
  return results.map((result) => `[Context from document ${result.document_id}]: ${result.content}`).join('\n\n');
}
