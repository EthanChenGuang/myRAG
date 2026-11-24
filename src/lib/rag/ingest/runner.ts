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
import { scanInjectionStage } from './stages/scan-injection';
import { storeOriginalStage } from './stages/store-original';
import {
  IngestStageError,
  type IngestResult,
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

/** Writes the resumable record of the run to the document row. Nothing is written before the row exists. */
async function persistState(ctx: StageContext, processingStatus: string): Promise<void> {
  if (!ctx.document) return;
  syncState(ctx);
  await ctx.writer.saveState(ctx.document.id, processingStatus, { ...ctx.state });
}

/** Stops the run before a stage and keeps the document resumable. Without a document row nothing can resume. */
async function yieldRun(ctx: StageContext, stage: StageName, reason: string): Promise<IngestResult> {
  if (!ctx.document) return failRun(ctx, stage, reason === 'deadline' ? 'deadline_exceeded' : reason);
  await persistState(ctx, 'processing');
  return processingResult(ctx, reason);
}

/** The terminal stage's state is recorded on a best-effort basis: the version is already published by then. */
async function recordFinalState(ctx: StageContext, stage: StageName, result: IngestResult): Promise<void> {
  if (result.status !== 'ready' && result.status !== 'quarantined') return;
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

/**
 * Runs the stages in D-02 order, starting after ctx.state.lastCompleted so a resumed run does not repeat
 * finished work. Before each stage the request deadline is checked: a stage that does not fit ends the
 * run as processing with the document resumable. Once the document row exists, every finished stage
 * persists processing_status and the state. A stage that fails, throws or meets an abort marks the
 * version failed; the run ends at the first stage that returns a result.
 */
export async function runIngestStages(ctx: StageContext, stages: readonly StageSpec[] = REGISTERED_STAGES): Promise<IngestResult> {
  void _everyStageListed;
  assertOrder(stages);
  const resumeAfter = ctx.state.lastCompleted === null ? -1 : INGEST_STAGES.indexOf(ctx.state.lastCompleted);
  for (const stage of stages) {
    if (INGEST_STAGES.indexOf(stage.name) <= resumeAfter) continue;
    try {
      ctx.signal.throwIfAborted();
      if (ctx.deadline - ctx.deps.now() < stage.minMsNeeded) return await yieldRun(ctx, stage.name, 'deadline');
      const outcome = await stage.run(ctx);
      if (outcome.kind === 'done') {
        await recordFinalState(ctx, stage.name, outcome.result);
        return outcome.result;
      }
      if (outcome.kind === 'fail') return await failRun(ctx, stage.name, outcome.reason);
      if (outcome.kind === 'yield') return await yieldRun(ctx, stage.name, outcome.reason);
      ctx.state.lastCompleted = stage.name;
      await persistState(ctx, 'processing');
    } catch (error) {
      return failRun(ctx, stage.name, failureReason(stage.name, error, ctx.signal), error);
    }
  }
  return failRun(ctx, 'publish', 'stage_list_incomplete');
}
