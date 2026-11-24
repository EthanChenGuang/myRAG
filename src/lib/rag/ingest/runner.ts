import { IngestWriterError, createIngestWriter } from './writer';
import { contentHashDedupStage, fileHashDedupStage } from './stages/dedup';
import { chunkStage } from './stages/chunk';
import { embedStage, writeStage } from './stages/embed-write';
import { identifyStage } from './stages/identify';
import { parseStage } from './stages/parse';
import { publishStage } from './stages/publish';
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

/** Registered stage modules in D-02 order. Plan 03-13b registers store_original, scan_injection, enrich, extract and images. */
const REGISTERED_STAGES: readonly StageSpec[] = [
  identifyStage,
  fileHashDedupStage,
  parseStage,
  contentHashDedupStage,
  chunkStage,
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

/**
 * Runs the registered stages in D-02 order. A stage that fails or throws marks the version failed with its
 * reason; the run ends at the first stage that returns a result. Plan 03-13b adds the deadline, state
 * persistence and resume.
 */
export async function runIngestStages(ctx: StageContext, stages: readonly StageSpec[] = REGISTERED_STAGES): Promise<IngestResult> {
  void _everyStageListed;
  assertOrder(stages);
  for (const stage of stages) {
    try {
      ctx.signal.throwIfAborted();
      const outcome = await stage.run(ctx);
      if (outcome.kind === 'done') return outcome.result;
      if (outcome.kind === 'fail') return await failRun(ctx, stage.name, outcome.reason);
      if (outcome.kind === 'yield') {
        return {
          status: 'processing',
          documentId: ctx.document?.id ?? null,
          version: ctx.document?.version ?? null,
          parserUsed: ctx.parserUsed,
          chunkCount: 0,
          warnings: ctx.warnings.slice(),
          reason: outcome.reason,
        };
      }
      ctx.state.lastCompleted = stage.name;
    } catch (error) {
      return failRun(ctx, stage.name, failureReason(stage.name, error, ctx.signal), error);
    }
  }
  return failRun(ctx, 'publish', 'stage_list_incomplete');
}
