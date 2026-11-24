import { advanceJob, type LedgerDeps } from './ledger';
import type { StageContext, StageName } from './types';

/**
 * Where a run keeps its resumable state: the document row (inline runs, the default) or the ledger row (a queued job).
 * For a queued job the ledger is the only state authority and documents.processing_state is never written (D-01, A-1).
 */
export interface StateStore {
  save(ctx: StageContext, processingStatus: string): Promise<void>;
}

/** Today's store: the whole state slice goes to the document row once the row exists. */
export const documentRowStateStore: StateStore = {
  async save(ctx, processingStatus) {
    if (!ctx.document) return;
    await ctx.writer.saveState(ctx.document.id, processingStatus, { ...ctx.state });
  },
};

/** Writes the state of the run to the store it uses; every stage and the runner go through here. */
export async function saveContextState(ctx: StageContext, processingStatus: string): Promise<void> {
  await (ctx.store ?? documentRowStateStore).save(ctx, processingStatus);
}

/** A store that writes nothing: the enqueue stages run before the ledger row exists and must not touch processing_state either. */
export const nullStateStore: StateStore = {
  async save() {},
};

export interface LedgerStateStoreInput {
  jobId: string;
  worker: string;
  signal: AbortSignal;
  now: () => number;
  ledgerDeps?: LedgerDeps;
}

/** The ledger status each post-parse stage maps to (the SQL pairs in rag_ingest_job_status_for_stage). */
const LEDGER_STATUS: Partial<Record<StageName, string>> = {
  parse: 'parsing',
  content_hash_dedup: 'chunking',
  scan_injection: 'chunking',
  chunk: 'chunking',
  enrich: 'chunking',
  extract: 'chunking',
  images: 'chunking',
  embed: 'embedding',
  write: 'embedding',
  publish: 'embedding',
};

export function ledgerStatusForStage(stage: StageName): string | null {
  return LEDGER_STATUS[stage] ?? null;
}

/**
 * The ledger store of a queued run. Each save is one advance of the job: the stage that finished, its status, the state slice
 * (with `cursor` set to that stage, which the next advance call must name) and the time since the previous save, counted once
 * per stage. The terminal advance (ready, failed, skipped_duplicate) is the callback's, so a final save here keeps the job in
 * its last working stage.
 */
export function createLedgerStateStore(input: LedgerStateStoreInput): StateStore {
  let mark = input.now();
  let timedStage: StageName | null = null;
  return {
    async save(ctx) {
      const stage = ctx.state.lastCompleted ?? 'parse';
      const status = ledgerStatusForStage(stage);
      if (status === null) return;
      const now = input.now();
      const timingMs = stage !== timedStage ? Math.max(0, Math.round(now - mark)) : null;
      await advanceJob(
        {
          jobId: input.jobId,
          worker: input.worker,
          stage,
          status,
          // Before parse has finished (a pending parse job) the run has no post-parse position to resume from.
          stageState: ctx.state.lastCompleted === null ? { ...ctx.state } : { ...ctx.state, cursor: stage },
          timingMs,
        },
        { signal: input.signal, ...(input.ledgerDeps ? { deps: input.ledgerDeps } : {}) },
      );
      if (stage !== timedStage) {
        timedStage = stage;
        mark = now;
      }
    },
  };
}
