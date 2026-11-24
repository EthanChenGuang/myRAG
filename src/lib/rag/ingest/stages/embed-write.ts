import { buildEmbeddingText, EMBEDDING_TEXT_VERSION } from '../text/embedding-text';
import {
  IngestStageError,
  requireDocument,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';
import type { ChunkWrite } from '../writer';

const LEGACY_PROFILE_ID = 'openai-3-small-1536';
const LEGACY_DIMENSIONS = 1536;
const MAX_BATCH_BYTES = 1_000_000;
const APPROX_VECTOR_BYTES = LEGACY_DIMENSIONS * 20;

function toWrites(ctx: StageContext): ChunkWrite[] {
  return ctx.work.chunks.map((draft, index) => ({
    content: draft.content,
    chunk_index: index,
    section_path: draft.section_path,
    chunk_kind: draft.chunk_kind,
    embedding_text_version: EMBEDDING_TEXT_VERSION,
    page_start: draft.page_start,
    page_end: draft.page_end,
    content_hash: draft.content_hash ?? null,
    lexical_text: draft.lexical_text ?? null,
    metadata: draft.metadata,
  }));
}

/** Batches sized by JSON bytes, vectors included, so a call stays near 1 MB whatever the chunk length. */
function batchByBytes(writes: ChunkWrite[]): ChunkWrite[][] {
  const batches: ChunkWrite[][] = [];
  let current: ChunkWrite[] = [];
  let bytes = 0;
  for (const write of writes) {
    const size = Buffer.byteLength(JSON.stringify(write), 'utf8') + APPROX_VECTOR_BYTES;
    if (current.length > 0 && bytes + size > MAX_BATCH_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(write);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Embeds and writes in one batched loop so vectors never live outside the database. The legacy profile
 * is the only target here (multi-profile targets arrive with the profile write path).
 */
async function runEmbed(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'embed');
  const writes = toWrites(ctx);
  const batches = batchByBytes(writes);
  let written = 0;

  for (const [position, batch] of batches.entries()) {
    ctx.signal.throwIfAborted();
    const texts = batch.map((write) => buildEmbeddingText({ section_path: write.section_path, content: write.content }));
    const vectors = await ctx.deps.embedDocuments(texts, { signal: ctx.signal });
    ctx.signal.throwIfAborted();
    if (vectors.length !== batch.length || vectors.some((vector) => vector.length !== LEGACY_DIMENSIONS)) {
      throw new IngestStageError('embed', 'embedding_dimension_mismatch');
    }
    const result = await ctx.writer.writeChunks(document.id, batch, {
      embeddings: { [LEGACY_PROFILE_ID]: vectors },
      final: position === batches.length - 1,
      total: writes.length,
    });
    written += result.chunksWritten;
  }

  ctx.work.chunksWritten = written;
  ctx.state.embeddingTargets = [LEGACY_PROFILE_ID];
  return { kind: 'next' };
}

async function runWrite(ctx: StageContext): Promise<StageOutcome> {
  if (ctx.work.chunksWritten !== ctx.work.chunks.length) return { kind: 'fail', reason: 'write_incomplete' };
  return { kind: 'next' };
}

/** Room for one embedding batch and its write; with less time left the run yields and resumes. */
const EMBED_MIN_MS = 5000;

export const embedStage: StageSpec = { name: 'embed', minMsNeeded: EMBED_MIN_MS, run: runEmbed };
export const writeStage: StageSpec = { name: 'write', minMsNeeded: 0, run: runWrite };
