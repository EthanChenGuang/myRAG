import { ParseResultSchema } from '@/lib/rag-eval/contracts.generated';
import { PARSE_ARTIFACT, PARSE_CHUNKS_ARTIFACT, PICTURES_ARTIFACT, isArtifactName, loadArtifact, originalName, versionPrefix } from './artifacts';
import { ObjectStoreError } from './object-store';
import { saveContextState } from './state-store';
import { IngestWriterError, createIngestWriter } from './writer';
import { chunkStage } from './stages/chunk';
import { contentHashDedupStage, fileHashDedupStage } from './stages/dedup';
import { embedStage, writeStage } from './stages/embed-write';
import { enrichStage } from './stages/enrich';
import { extractStage } from './stages/extract';
import { identifyStage } from './stages/identify';
import { imagesStage } from './stages/images';
import { parseStage } from './stages/parse';
import { publishStage } from './stages/publish';
import { reapplyHiddenTextRemoval, scanInjectionStage } from './stages/scan-injection';
import { storeOriginalStage } from './stages/store-original';
import type { IngestSpan, IngestSpanDetail, IngestSpanEnd, IngestTrace } from './trace';
import {
  IngestStageError,
  type IngestResult,
  type RehydrateResult,
  type StageContext,
  type StageName,
  type StageSpec,
} from './types';

/** The D-02 stages in order. */
export const INGEST_STAGES = [
  'identify',
  'file_hash_dedup',
  'store_original',
  'parse',
  'content_hash_dedup',
  'scan_injection',
  'chunk',
  'enrich',
  'extract',
  'images',
  'embed',
  'write',
  'publish',
] as const satisfies readonly StageName[];

const _everyStageListed: [Exclude<StageName, (typeof INGEST_STAGES)[number]>] extends [never] ? true : never = true;

/** The stage modules in D-02 order. */
export const REGISTERED_STAGES: readonly StageSpec[] = [
  identifyStage,
  fileHashDedupStage,
  storeOriginalStage,
  parseStage,
  contentHashDedupStage,
  scanInjectionStage,
  chunkStage,
  enrichStage,
  extractStage,
  imagesStage,
  embedStage,
  writeStage,
  publishStage,
];

type ParseResultChunks = NonNullable<StageContext['work']['parseChunks']>;

const CLEANUP_TIMEOUT_MS = 5000;

function assertOrder(stages: readonly StageSpec[]): void {
  let previous = -1;
  for (const stage of stages) {
    const position = INGEST_STAGES.indexOf(stage.name);
    if (position <= previous) throw new Error(`[Ingest] stage ${stage.name} is out of order or repeated`);
    previous = position;
  }
}

function failureReason(stage: StageName, error: unknown, signal: AbortSignal): string {
  if (error instanceof IngestStageError) return error.reason;
  if (signal.aborted) return 'aborted';
  return `${stage}_failed`;
}

function logFailure(stage: StageName, reason: string, error: unknown): void {
  const data: Record<string, unknown> = { stage, reason };
  if (error instanceof IngestWriterError) {
    data.error = error.name;
    data.rpc = error.rpc;
    data.code = error.code;
    if (error.reason) data.writer_reason = error.reason;
  } else if (error instanceof ObjectStoreError) {
    data.error = error.name;
    data.op = error.op;
    data.status = error.status;
  } else if (error instanceof Error) {
    data.error = error.name;
  }
  console.error('[Ingest] stage failed', data);
}

async function markFailed(ctx: StageContext, reason: string): Promise<void> {
  if (!ctx.document) return;
  try {
    let writer = ctx.writer;
    if (ctx.signal.aborted) {
      const db = ctx.deps.db();
      if (!db) return;
      writer = createIngestWriter({ db, scope: ctx.input.scope, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    }
    await writer.markFailed(ctx.document.id, reason);
  } catch (error) {
    console.error('[Ingest] could not mark the version failed', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof IngestWriterError ? { rpc: error.rpc, code: error.code } : {}),
    });
  }
}

async function failRun(ctx: StageContext, stage: StageName, reason: string, error?: unknown): Promise<IngestResult> {
  if (error !== undefined) logFailure(stage, reason, error);
  await markFailed(ctx, reason);
  return {
    status: 'failed',
    documentId: ctx.document?.id ?? null,
    version: ctx.document?.version ?? null,
    parserUsed: ctx.parserUsed,
    chunkCount: 0,
    warnings: ctx.warnings.slice(),
    reason,
  };
}

function processingResult(ctx: StageContext, reason: string): IngestResult {
  return {
    status: 'processing',
    documentId: ctx.document?.id ?? null,
    version: ctx.document?.version ?? null,
    parserUsed: ctx.parserUsed,
    chunkCount: ctx.work.chunksWritten,
    warnings: ctx.warnings.slice(),
    reason,
  };
}

function syncState(ctx: StageContext): void {
  if (ctx.identity) ctx.state.docTypeOrigin = ctx.identity.docTypeOrigin;
  if (ctx.work.chunksWritten > 0) ctx.state.chunkCount = ctx.work.chunksWritten;
}

/** Writes the resumable record of the run to its state store (the document row unless a queued run installed the ledger). Nothing is written before the row exists. */
async function persistState(ctx: StageContext, processingStatus: string): Promise<void> {
  if (!ctx.document) return;
  syncState(ctx);
  await saveContextState(ctx, processingStatus);
}

/** Stops the run before a stage and keeps the document resumable. Without a document row nothing can resume. */
async function yieldRun(ctx: StageContext, stage: StageName, reason: string): Promise<IngestResult> {
  if (!ctx.document) return failRun(ctx, stage, reason === 'deadline' ? 'deadline_exceeded' : reason);
  await persistState(ctx, 'processing');
  return processingResult(ctx, reason);
}

/** The terminal stage's state is recorded on a best-effort basis: the version is already published by then. */
async function recordFinalState(ctx: StageContext, stage: StageName, result: IngestResult): Promise<void> {
  if (result.status !== 'ready' && result.status !== 'quarantined' && result.status !== 'pending_review') return;
  ctx.state.lastCompleted = stage;
  try {
    await persistState(ctx, result.status);
  } catch (error) {
    console.error('[Ingest] could not record the final state', { stage, error: error instanceof Error ? error.name : 'unknown' });
  }
}

/** The first stage that has not completed: the one after lastCompleted, or the first when nothing completed. */
export function nextStageAfter(last: StageName | null): StageName | null {
  return INGEST_STAGES[last === null ? 0 : INGEST_STAGES.indexOf(last) + 1] ?? null;
}

export interface RunIngestOptions {
  /** Receives one span per stage that starts, named as the stage. */
  trace?: IngestTrace | null;
  /** The stage list is a prefix of the run (the enqueue stages): finishing it ends the run as processing instead of failing it. */
  partial?: boolean;
}

const DEDUP_STAGES: ReadonlySet<StageName> = new Set(['file_hash_dedup', 'content_hash_dedup']);

function pagesOf(ctx: StageContext): number | null {
  let pages = 0;
  for (const chunk of ctx.work.chunks) pages = Math.max(pages, chunk.page_end ?? 0);
  return pages > 0 ? pages : null;
}

function spanDetail(ctx: StageContext, extra: { fallbackReason?: string; outcome?: string }): IngestSpanDetail {
  const chunkCount = ctx.work.chunksWritten > 0 ? ctx.work.chunksWritten : ctx.work.chunks.length;
  return {
    parser_used: ctx.parserUsed,
    pages: pagesOf(ctx),
    chunk_count: chunkCount > 0 ? chunkCount : null,
    doc_type: ctx.identity?.docType ?? null,
    doc_type_origin: ctx.identity?.docTypeOrigin ?? ctx.state.docTypeOrigin,
    fallback_reason: extra.fallbackReason ?? null,
    outcome: extra.outcome ?? null,
  };
}

/**
 * Runs the stages in D-02 order, starting after ctx.state.lastCompleted so a resumed run does not repeat
 * finished work. Before each stage the request deadline is checked: a stage that does not fit ends the
 * run as processing with the document resumable. Once the document row exists, every finished stage
 * persists processing_status and the state. A stage that fails, throws or meets an abort marks the
 * version failed; the run ends at the first stage that returns a result. Each stage that starts is one
 * span on the trace.
 */
export async function runIngestStages(
  ctx: StageContext,
  stages: readonly StageSpec[] = REGISTERED_STAGES,
  options: RunIngestOptions = {},
): Promise<IngestResult> {
  void _everyStageListed;
  assertOrder(stages);
  const resumeAfter = ctx.state.lastCompleted === null ? -1 : INGEST_STAGES.indexOf(ctx.state.lastCompleted);
  for (const stage of stages) {
    if (INGEST_STAGES.indexOf(stage.name) <= resumeAfter) continue;
    const span: IngestSpan | undefined = options.trace?.start(stage.name);
    const warningsBefore = ctx.warnings.length;
    const close = (end: Omit<IngestSpanEnd, 'detail'>, extra: { fallbackReason?: string; outcome?: string } = {}): void =>
      span?.end({ ...end, detail: spanDetail(ctx, { ...extra, fallbackReason: extra.fallbackReason ?? ctx.warnings[warningsBefore] }) });
    try {
      ctx.signal.throwIfAborted();
      if (ctx.deadline - ctx.deps.now() < stage.minMsNeeded) {
        const result = await yieldRun(ctx, stage.name, 'deadline');
        close({ status: 'timeout', reason: 'timeout' }, { fallbackReason: 'deadline', outcome: result.status === 'processing' ? 'yielded' : 'failed' });
        return result;
      }
      const outcome = await stage.run(ctx);
      if (outcome.kind === 'done') {
        await recordFinalState(ctx, stage.name, outcome.result);
        close({ status: 'ok' }, { outcome: outcome.result.status });
        return outcome.result;
      }
      if (outcome.kind === 'fail') {
        const result = await failRun(ctx, stage.name, outcome.reason);
        close({ status: 'error', reason: 'failed' }, { fallbackReason: outcome.reason, outcome: 'failed' });
        return result;
      }
      if (outcome.kind === 'yield') {
        const result = await yieldRun(ctx, stage.name, outcome.reason);
        close({ status: 'skipped' }, { fallbackReason: outcome.reason, outcome: 'yielded' });
        return result;
      }
      ctx.state.lastCompleted = stage.name;
      await persistState(ctx, 'processing');
      close(outcome.disabled ? { status: 'disabled', reason: 'disabled' } : { status: 'ok' }, {
        ...(outcome.fallbackReason !== undefined ? { fallbackReason: outcome.fallbackReason } : {}),
        ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : DEDUP_STAGES.has(stage.name) ? { outcome: 'unique' } : {}),
      });
    } catch (error) {
      const reason = failureReason(stage.name, error, ctx.signal);
      close(ctx.signal.aborted ? { status: 'aborted', reason: 'aborted' } : { status: 'error', reason: 'failed' }, { fallbackReason: reason, outcome: 'failed' });
      return failRun(ctx, stage.name, reason, error);
    }
  }
  if (options.partial) return processingResult(ctx, 'stages_complete');
  return failRun(ctx, 'publish', 'stage_list_incomplete');
}

const reached = (last: StageName, stage: StageName): boolean => INGEST_STAGES.indexOf(last) >= INGEST_STAGES.indexOf(stage);

/** The name of the stored original, from documents.original_path when it lies under this version's prefix; null when it lies elsewhere. */
function storedOriginalName(ctx: StageContext, prefix: string, filename: string): string | null {
  const path = ctx.document?.originalPath ?? null;
  if (path === null) return originalName(filename);
  const name = path.startsWith(prefix) ? path.slice(prefix.length) : '';
  return isArtifactName(name) ? name : null;
}

/** Runs a deterministic stage again on a resumed run; returns the reason when it did not simply continue. */
async function rerun(stage: StageSpec, ctx: StageContext): Promise<string | null> {
  const outcome = await stage.run(ctx);
  if (outcome.kind === 'next') return null;
  return outcome.kind === 'fail' ? outcome.reason : 'rehydrate_failed';
}

/** The parser's own chunks stored next to parse.md (Docling), so a resumed run chunks like an uninterrupted one; null when there are none or they do not validate. */
async function loadParseChunks(ctx: StageContext): Promise<ParseResultChunks | null> {
  const stored = await loadArtifact(ctx, PARSE_CHUNKS_ARTIFACT);
  if (!stored) return null;
  try {
    const parsed = ParseResultSchema.shape.chunks.safeParse(JSON.parse(new TextDecoder('utf-8').decode(stored.bytes)));
    return parsed.success && parsed.data.length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The pictures the parser found, stored next to parse.md when RAG_PDF_IMAGE_CHUNKS was on; null when there are none or they do not validate. */
async function loadPictures(ctx: StageContext): Promise<StageContext['work']['pictures']> {
  const stored = await loadArtifact(ctx, PICTURES_ARTIFACT);
  if (!stored) return null;
  try {
    const parsed = ParseResultSchema.shape.pictures.safeParse(JSON.parse(new TextDecoder('utf-8').decode(stored.bytes)));
    return parsed.success && parsed.data.length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Rebuilds what the stages after ctx.state.lastCompleted read from memory, from the stored artifacts and no upload.
 * Parse output comes from parse.md; without it the stored original is parsed again, and without that the run fails
 * as original_unavailable. chunk, enrich and extract are deterministic, so each one that had already finished is
 * run again on the parse output; stage outputs that are not deterministic live in processing_state. A run that
 * stopped before store_original has no stored input, so nothing can be rebuilt (false).
 */
export async function rehydrateFromStore(ctx: StageContext): Promise<RehydrateResult> {
  const last = ctx.state.lastCompleted;
  const { identity, document } = ctx;
  if (last === null || !identity || !document || !reached(last, 'store_original')) return false;

  let originalFile: string | null;
  try {
    originalFile = storedOriginalName(ctx, versionPrefix(identity.tenantKey, document.lineageId, document.version), identity.filename);
  } catch {
    return false;
  }
  if (originalFile === null) return { failed: 'original_unavailable' };

  async function loadOriginal(name: string): Promise<boolean> {
    const stored = await loadArtifact(ctx, name);
    if (!stored || !identity) return false;
    identity.bytes = stored.bytes;
    if (stored.contentType) ctx.input.mimeType = stored.contentType;
    return true;
  }

  if (reached(last, 'parse')) {
    const parsed = await loadArtifact(ctx, PARSE_ARTIFACT);
    if (parsed) {
      ctx.work.parseText = new TextDecoder('utf-8').decode(parsed.bytes);
      ctx.work.parserVersion = ctx.work.parserVersion ?? 'stored';
      ctx.work.parseChunks = await loadParseChunks(ctx);
      if (ctx.config.pdfImageChunks) ctx.work.pictures = await loadPictures(ctx);
    } else {
      if (!(await loadOriginal(originalFile))) return { failed: 'original_unavailable' };
      const failure = await rerun(parseStage, ctx);
      if (failure !== null) return { failed: failure };
    }
  } else if (!(await loadOriginal(originalFile))) {
    return { failed: 'original_unavailable' };
  }
  // D-34: the stored parse text still holds zero-width characters the scan removed before chunking.
  if (reached(last, 'scan_injection')) reapplyHiddenTextRemoval(ctx);

  const deterministic: StageSpec[] = [chunkStage, enrichStage, extractStage];
  for (const stage of deterministic) {
    if (!reached(last, stage.name)) break;
    const failure = await rerun(stage, ctx);
    if (failure !== null) return { failed: failure };
  }

  // The vectors of a finished embed stage are already written; the write stage compares the count the state recorded with the rebuilt chunks.
  if (reached(last, 'embed')) ctx.work.chunksWritten = ctx.state.chunkCount ?? 0;

  // The caption of a picture document is its only chunk, and the pictures of a PDF add chunks: both are read back from the stored
  // captions (and the public keys follow from the lineage), so no model is called again.
  if ((ctx.work.captionOnly || ctx.config.pdfImageChunks) && reached(last, 'images')) {
    const outcome = await imagesStage.run(ctx);
    if (outcome.kind === 'yield') return false;
    if (outcome.kind !== 'next') return { failed: outcome.kind === 'fail' ? outcome.reason : 'rehydrate_failed' };
  }
  return true;
}
