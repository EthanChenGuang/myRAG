import { isMissingPhase4Function, markV2Unavailable, resolveEffectivePipeline } from '../../v2/readiness';
import { EmbeddingProfileMismatch } from '../../embeddings/mrl';
import { ProfileUnavailableError, type EmbeddingProfile } from '../../embeddings/active-profile';
import { canonicalModelId, getEmbeddingProviderFor } from '../../embeddings/registry';
import { resolveEmbeddingTargets, type EmbeddingTarget } from '../embedding-targets';
import { buildProfileChunks, liveProfilesByDocType, writeProfileChunks } from '../profile-chunks';
import { buildEmbeddingText, EMBEDDING_TEXT_VERSION, templateHeaderFor } from '../text/embedding-text';
import { effectiveEmbeddingTextVersion } from '../text/table-rows';
import {
  IngestStageError,
  requireDocument,
  requireIdentity,
  type EmbedProgress,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';
import { HiddenSpanWriteError, assertNoHiddenSpans, type SpanCheckedChunk } from '../../security/hidden-text';
import { IngestWriterError, chunkIdFor, profileRowIdFor, type ChunkWrite, type ProfileVectors } from '../writer';
import { indexDocumentForLookup } from '../write-indexers';

const MAX_BATCH_BYTES = 1_000_000;
const BYTES_PER_VECTOR_DIM = 20;

export function toWrites(ctx: Pick<StageContext, 'work'>): ChunkWrite[] {
  return ctx.work.chunks.map((draft, index) => ({
    content: draft.content,
    chunk_index: index,
    section_path: draft.section_path,
    chunk_kind: draft.chunk_kind,
    embedding_text_version: effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, draft.table_row_separator !== undefined),
    page_start: draft.page_start,
    page_end: draft.page_end,
    content_hash: draft.content_hash ?? null,
    lexical_text: draft.lexical_text ?? null,
    ...(draft.language !== undefined ? { language: draft.language } : {}),
    ...(draft.language_confidence !== undefined ? { language_confidence: draft.language_confidence } : {}),
    metadata: draft.metadata,
  }));
}

/**
 * The write-time assertion of F-17: a chunk that still holds a hidden span removed by the scan is never written; the stage fails and
 * nothing of the batch reaches the database. Only the count is logged.
 */
export function guardHiddenSpans(ctx: Pick<StageContext, 'state'>, chunks: readonly SpanCheckedChunk[]): void {
  const spans = ctx.state.hiddenText?.removedSpans ?? [];
  if (spans.length === 0) return;
  try {
    assertNoHiddenSpans(chunks, spans);
  } catch (error) {
    if (!(error instanceof HiddenSpanWriteError)) throw error;
    console.error('[RAG Security] a chunk still holds a removed hidden span; nothing is written', { chunks: error.chunks });
    throw new IngestStageError('embed', 'hidden_span_in_chunk');
  }
}

/** Batches sized by JSON bytes, vectors included, so a call stays near 1 MB whatever the chunk length. */
function batchByBytes(writes: ChunkWrite[], vectorBytes: number): ChunkWrite[][] {
  const batches: ChunkWrite[][] = [];
  let current: ChunkWrite[] = [];
  let bytes = 0;
  for (const write of writes) {
    const size = Buffer.byteLength(JSON.stringify(write), 'utf8') + vectorBytes;
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

type GapReason = 'provider_failed' | 'embedding_profile_mismatch';

interface TargetVectors {
  vectors: number[][];
  host: string | null;
}

/** A target that could not be embedded; mismatch means the provider answered with the wrong model or dimensions. */
class TargetFailure extends Error {
  readonly reason: GapReason;
  readonly cause: unknown;

  constructor(reason: GapReason, cause?: unknown) {
    super(`[Ingest] embedding target failed (${reason})`);
    this.name = 'TargetFailure';
    this.reason = reason;
    this.cause = cause;
  }
}

function assertShape(profile: EmbeddingProfile, vectors: number[][], count: number): void {
  if (vectors.length !== count || vectors.some((vector) => vector.length !== profile.dims)) throw new TargetFailure('embedding_profile_mismatch');
}

/** The configured provider must serve the profile's model (same-dimension swap guard) and support its dims. */
function assertProviderFits(profile: EmbeddingProfile): void {
  let provider;
  try {
    provider = getEmbeddingProviderFor(profile.provider, profile.model);
  } catch (error) {
    throw new TargetFailure('provider_failed', error);
  }
  if (canonicalModelId(provider.model) !== canonicalModelId(profile.model) || !provider.supportedDims.includes(profile.dims)) {
    throw new TargetFailure('embedding_profile_mismatch');
  }
}

async function embedForTarget(ctx: StageContext, target: EmbeddingTarget, texts: string[]): Promise<TargetVectors> {
  const { profile } = target;
  try {
    if (profile.storage === 'legacy_column') {
      if (ctx.config.pipeline === 'unified' || ctx.config.embeddingProfiles === 'on') assertProviderFits(profile);
      const vectors = await ctx.deps.embedDocuments(texts, { signal: ctx.signal });
      assertShape(profile, vectors, texts.length);
      return { vectors, host: null };
    }
    assertProviderFits(profile);
    const output = await getEmbeddingProviderFor(profile.provider, profile.model).embedDocuments(texts, { dims: profile.dims, signal: ctx.signal });
    if (canonicalModelId(output.model) !== canonicalModelId(profile.model)) throw new TargetFailure('embedding_profile_mismatch');
    assertShape(profile, output.vectors, texts.length);
    return { vectors: output.vectors, host: output.host };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof TargetFailure) throw error;
    throw new TargetFailure(error instanceof EmbeddingProfileMismatch ? 'embedding_profile_mismatch' : 'provider_failed', error);
  }
}

function logTargetFailure(target: EmbeddingTarget, failure: TargetFailure): void {
  const cause = failure.cause;
  console.warn('[Ingest] embedding target failed', {
    profile: target.profile.id,
    role: target.role,
    reason: failure.reason,
    ...(cause instanceof Error ? { error: cause.name } : {}),
  });
}

const PROFILE_EMBED_GROUP = 100;

/** Embeds the texts of a profile's children for one target in groups, so one provider request never carries a whole long document. */
async function embedGroups(ctx: StageContext, target: EmbeddingTarget, texts: string[]): Promise<TargetVectors> {
  const vectors: number[][] = [];
  let host: string | null = null;
  for (let start = 0; start < texts.length; start += PROFILE_EMBED_GROUP) {
    ctx.signal.throwIfAborted();
    const part = await embedForTarget(ctx, target, texts.slice(start, start + PROFILE_EMBED_GROUP));
    vectors.push(...part.vectors);
    host ??= part.host;
  }
  return { vectors, host };
}

function logProfileFailure(step: string, error: unknown): void {
  console.warn('[Ingest] chunking profile dual-write failed', {
    step,
    ...(error instanceof Error ? { error: error.name } : {}),
    ...(error instanceof IngestWriterError ? { rpc: error.rpc, code: error.code } : {}),
  });
}

/**
 * Under RAG_PIPELINE=v2 only (D-23): every non-legacy chunking profile of the document's type that is building, ready or active gets the
 * parents and children of this version, embedded for the same targets as the legacy chunks, so a new upload is complete in every built profile
 * before it is published (D-21). A failing active embedding target or a failing profile write fails the run, so no half-built version is
 * published; a failing other target leaves its vectors out and records a gap like the legacy chunks do.
 */
async function dualWriteProfiles(ctx: StageContext, documentId: string, targets: EmbeddingTarget[], failed: Map<string, TargetFailure>, templateHeader: string): Promise<void> {
  const identity = requireIdentity(ctx, 'embed');
  let rows;
  try {
    rows = await ctx.writer.listChunkingProfiles();
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    // D-07: a defaulted v2 on a database without the Phase 4 functions ingests as legacy; an explicit v2 still fails.
    if (error instanceof IngestWriterError && isMissingPhase4Function(error) && resolveEffectivePipeline().source === 'default') {
      markV2Unavailable(error.rpc);
      return;
    }
    logProfileFailure('list', error);
    throw new IngestStageError('embed', 'chunking_profiles_unavailable');
  }
  const profiles = liveProfilesByDocType(rows).get(identity.docType) ?? [];

  for (const profile of profiles) {
    ctx.signal.throwIfAborted();
    const built = buildProfileChunks(
      { filename: identity.filename, chunker: identity.profile.chunker, templateHeader, languageAwareIngest: ctx.config?.languageAwareIngest, tableHeaderRepeat: ctx.config?.tableHeaderRepeat },
      ctx.work.parseText ?? '',
      profile,
    );
    if (built.children.length === 0) continue;
    guardHiddenSpans(ctx, [...built.parents.map((parent) => ({ content: parent.content })), ...built.children]);

    const outcomes = await Promise.all(
      targets.map(async (target) => {
        const earlier = failed.get(target.profile.id);
        if (earlier) return { target, failure: earlier, result: null };
        try {
          return { target, failure: null, result: await embedGroups(ctx, target, built.embeddingTexts) };
        } catch (error) {
          if (!(error instanceof TargetFailure)) throw error;
          return { target, failure: error, result: null };
        }
      }),
    );
    ctx.signal.throwIfAborted();

    const embeddings: Record<string, ProfileVectors> = {};
    const missing: Array<{ target: EmbeddingTarget; reason: GapReason }> = [];
    for (const { target, failure, result } of outcomes) {
      if (failure || !result) {
        if (target.role === 'active') {
          logTargetFailure(target, failure as TargetFailure);
          throw new IngestStageError('embed', failure?.reason === 'embedding_profile_mismatch' ? 'embedding_profile_mismatch' : 'embed_failed');
        }
        if (!failed.has(target.profile.id)) logTargetFailure(target, failure as TargetFailure);
        failed.set(target.profile.id, failure as TargetFailure);
        missing.push({ target, reason: (failure as TargetFailure).reason });
        continue;
      }
      embeddings[target.profile.id] = target.profile.storage === 'legacy_column' ? result.vectors : { vectors: result.vectors, host: result.host };
    }

    try {
      await writeProfileChunks(ctx.writer, documentId, profile.id, built, embeddings);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      logProfileFailure('write', error);
      throw new IngestStageError('embed', 'profile_write_failed');
    }

    for (const { target, reason } of missing) {
      if (target.runId === null) continue;
      await ctx.writer.recordBackfillGap({
        runId: target.runId,
        chunkIds: built.children.map((child) => profileRowIdFor(documentId, profile.id, 'child', child.chunk_index)),
        profileId: target.profile.id,
        reason,
      });
    }
  }
}

function usableEmbedProgress(progress: EmbedProgress | undefined, targetIds: string[], total: number, batchCount: number): EmbedProgress | null {
  if (!progress) return null;
  if (progress.total !== total || progress.batchesDone <= 0 || progress.batchesDone >= batchCount) return null;
  if (progress.targets.length !== targetIds.length || progress.targets.some((id, index) => id !== targetIds[index])) return null;
  return progress;
}

/**
 * Embeds each batch once per target (active, backfilling, previous active, and the binding profiles of the document's doc type and tenant)
 * from the same embedding text and writes the vectors in one call. A failing active target fails the run (embed_failed, or embedding_profile_mismatch for a wrong model or dimensions); a failing other target
 * leaves its vectors out, stops being tried for the rest of the run, and records each affected chunk as a gap of its open run. With the
 * switch off the only target is the legacy profile, written exactly as before.
 */
async function runEmbed(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'embed');
  // Before any embedding call: a chunk that still holds a removed hidden span is neither embedded nor written.
  const writes = toWrites(ctx);
  guardHiddenSpans(ctx, writes);
  const identity = requireIdentity(ctx, 'embed');
  const dualWrite = resolveEffectivePipeline().pipeline !== 'legacy';
  let targets: EmbeddingTarget[];
  try {
    targets = await resolveEmbeddingTargets(ctx.writer, { docType: identity.docType, tenantKey: identity.tenantKey });
  } catch (error) {
    if (error instanceof ProfileUnavailableError) throw new IngestStageError('embed', 'embedding_profile_unavailable');
    throw error;
  }
  const vectorBytes = targets.reduce((sum, target) => sum + target.profile.dims * BYTES_PER_VECTOR_DIM, 0);
  const batches = batchByBytes(writes, vectorBytes);
  const failed = new Map<string, TargetFailure>();
  const targetIds = targets.map((target) => target.profile.id);
  // Chunk ids follow the document id and chunk index, so a resumed run that skips the batches an earlier call wrote rewrites nothing.
  const progress = usableEmbedProgress(ctx.state.embedProgress, targetIds, writes.length, batches.length);
  const gaps: Array<{ profileId: string; chunkIndex: number }> = progress ? progress.gaps.slice() : [];
  const templateHeader = templateHeaderFor(ctx.identity?.profile.embedding_text_template, ctx.work.templateRow);
  let written = progress ? progress.written : 0;
  const firstPosition = progress ? progress.batchesDone : 0;

  for (const [position, batch] of batches.entries()) {
    if (position < firstPosition) continue;
    ctx.signal.throwIfAborted();
    // At least one batch per call, so every call makes progress; then yield while there is no room for another batch.
    if (position > firstPosition && ctx.deadline - ctx.deps.now() < EMBED_MIN_MS) {
      ctx.state.embedProgress = { batchesDone: position, written, total: writes.length, targets: targetIds, gaps: gaps.slice() };
      ctx.work.chunksWritten = written;
      return { kind: 'yield', reason: 'deadline' };
    }
    const texts = batch.map((write) =>
      buildEmbeddingText({
        section_path: write.section_path,
        content: write.content,
        template_header: templateHeader,
        table_row_separator: ctx.work.chunks[write.chunk_index]?.table_row_separator ?? null,
      }),
    );
    const outcomes = await Promise.all(
      targets.map(async (target) => {
        const earlier = failed.get(target.profile.id);
        if (earlier) return { target, failure: earlier, result: null };
        try {
          return { target, failure: null, result: await embedForTarget(ctx, target, texts) };
        } catch (error) {
          if (!(error instanceof TargetFailure)) throw error;
          return { target, failure: error, result: null };
        }
      }),
    );
    ctx.signal.throwIfAborted();

    const embeddings: Record<string, ProfileVectors> = {};
    const missing: Array<{ target: EmbeddingTarget; reason: GapReason }> = [];
    for (const { target, failure, result } of outcomes) {
      if (failure || !result) {
        if (target.role === 'active') {
          logTargetFailure(target, failure as TargetFailure);
          throw new IngestStageError('embed', failure?.reason === 'embedding_profile_mismatch' ? 'embedding_profile_mismatch' : 'embed_failed');
        }
        if (!failed.has(target.profile.id)) logTargetFailure(target, failure as TargetFailure);
        failed.set(target.profile.id, failure as TargetFailure);
        missing.push({ target, reason: (failure as TargetFailure).reason });
        continue;
      }
      embeddings[target.profile.id] = target.profile.storage === 'legacy_column' ? result.vectors : { vectors: result.vectors, host: result.host };
    }

    const writeResult = await ctx.writer.writeChunks(document.id, batch, {
      embeddings,
      final: position === batches.length - 1,
      total: writes.length,
    });
    written += writeResult.chunksWritten;

    for (const { target, reason } of missing) {
      for (const write of batch) gaps.push({ profileId: target.profile.id, chunkIndex: write.chunk_index });
      if (target.runId !== null) {
        await ctx.writer.recordBackfillGap({
          runId: target.runId,
          chunkIds: batch.map((write) => chunkIdFor(document.id, write.chunk_index)),
          profileId: target.profile.id,
          reason,
        });
      }
    }
  }

  if (dualWrite) await dualWriteProfiles(ctx, document.id, targets, failed, templateHeader);

  ctx.work.chunksWritten = written;
  ctx.state.embeddingTargets = targetIds;
  ctx.state.embeddingGaps = gaps;
  delete ctx.state.embedProgress;
  const note: { fallbackReason?: string } = {};
  for (const profileId of failed.keys()) {
    const warning = `embedding_gap:${profileId}`;
    if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
    note.fallbackReason ??= warning;
  }
  return { kind: 'next', ...note };
}

/**
 * D-35, Batch API backfill: the embed stage writes the chunks without vectors and leaves the embedding to the rag:backfill process, which
 * fills every target profile by chunk id before the job is published. Children of chunking profiles (RAG_PIPELINE=v2) are still embedded
 * here, because the Batch API path fills document_chunks only. Its targets carry no document scope, like the orchestrator's: binding profiles
 * of such a document are filled by a scoped re-embed run.
 */
async function runDeferredEmbed(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'embed');
  // Before any embedding call: a chunk that still holds a removed hidden span is neither embedded nor written.
  const writes = toWrites(ctx);
  guardHiddenSpans(ctx, writes);
  const dualWrite = resolveEffectivePipeline().pipeline !== 'legacy';
  let targets: EmbeddingTarget[];
  try {
    targets = await resolveEmbeddingTargets(ctx.writer);
  } catch (error) {
    if (error instanceof ProfileUnavailableError) throw new IngestStageError('embed', 'embedding_profile_unavailable');
    throw error;
  }
  const batches = batchByBytes(writes, 0);
  let written = 0;
  for (const [position, batch] of batches.entries()) {
    ctx.signal.throwIfAborted();
    const result = await ctx.writer.writeChunks(document.id, batch, { embeddings: null, final: position === batches.length - 1, total: writes.length });
    written += result.chunksWritten;
  }
  if (dualWrite) {
    const templateHeader = templateHeaderFor(ctx.identity?.profile.embedding_text_template, ctx.work.templateRow);
    await dualWriteProfiles(ctx, document.id, targets, new Map(), templateHeader);
  }
  ctx.work.chunksWritten = written;
  ctx.state.embeddingTargets = targets.map((target) => target.profile.id);
  ctx.state.embeddingGaps = [];
  return { kind: 'next', outcome: 'deferred' };
}

/**
 * RAG_CAPTION_LANGUAGE=document (D-23): a picture caption inside a document keeps the language detected on the caption as written, not the
 * document's. Only drafts the images stage marked carry a language, so with the switch at en nothing is called. A picture document needs
 * no call: its document language is the caption's.
 */
async function writeCaptionLanguages(ctx: StageContext, documentId: string): Promise<void> {
  if (ctx.work.captionOnly || !ctx.writer.setImageChunkLanguages) return;
  const items: Array<{ imageUrl: string; language: string }> = [];
  for (const draft of ctx.work.chunks) {
    const imageUrl = draft.metadata.image_url;
    if (draft.chunk_kind === 'image' && draft.language && typeof imageUrl === 'string') items.push({ imageUrl, language: draft.language });
  }
  if (items.length > 0) await ctx.writer.setImageChunkLanguages(documentId, items);
}

/** RAG_TABLE_LOOKUP and RAG_IDENTIFIER_INDEX as the running process has them (the typed RAG configuration). */
async function lookupIndexSwitches(): Promise<{ tables: boolean; identifiers: boolean }> {
  const [{ loadRagConfig }, { getRagDeps }] = await Promise.all([import('../../config'), import('../../deps')]);
  const { v2 } = loadRagConfig(getRagDeps().ragEnv());
  return { tables: v2.tableLookup, identifiers: v2.identifierIndex };
}

/**
 * RET-12, RET-15 (D-15, D-28): with a switch on, the version's table rows and identifiers are written after its chunks, for every chunking
 * profile written at ingestion. Non-fatal: a failure leaves a warning code on the result and the backfills repair it; no new stage.
 */
async function indexForLookup(ctx: StageContext, documentId: string): Promise<void> {
  const switches = await lookupIndexSwitches();
  if (!switches.tables && !switches.identifiers) return;
  const report = await indexDocumentForLookup({ writer: ctx.writer, scope: ctx.input.scope, documentId, ...switches, signal: ctx.signal });
  for (const warning of report.warnings) if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
}

async function runWrite(ctx: StageContext): Promise<StageOutcome> {
  if (ctx.work.chunksWritten !== ctx.work.chunks.length) return { kind: 'fail', reason: 'write_incomplete' };
  // The text the chunker consumed (after the injection scan, which never changes it), stored once per version for the readers of documents.content.
  const document = requireDocument(ctx, 'write');
  if (ctx.work.parseText) await ctx.writer.setFields(document.id, { content: ctx.work.parseText });
  await writeCaptionLanguages(ctx, document.id);
  await indexForLookup(ctx, document.id);
  return { kind: 'next' };
}

/** Room for one embedding batch and its write; with less time left the run yields and resumes. */
const EMBED_MIN_MS = 5000;

export const embedStage: StageSpec = { name: 'embed', minMsNeeded: EMBED_MIN_MS, run: runEmbed };
export const writeStage: StageSpec = { name: 'write', minMsNeeded: 0, run: runWrite };
/** The embed stage of a Batch API backfill job (D-35): chunks are written without vectors. */
export const deferredEmbedStage: StageSpec = { name: 'embed', minMsNeeded: 0, run: runDeferredEmbed };
