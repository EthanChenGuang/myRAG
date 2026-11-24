import type { LedgerDeps } from './ledger';
import type { StageContext } from './types';

/** Where a run keeps its resumable state: the document row (inline runs) or the ledger row (queued jobs, D-01, A-1). */
export interface StateStore {
  save(ctx: StageContext, processingStatus: string): Promise<void>;
}

export const documentRowStateStore: StateStore = {
  async save() {
    throw new Error('not implemented');
  },
};

export async function saveContextState(ctx: StageContext, processingStatus: string): Promise<void> {
  await (ctx.store ?? documentRowStateStore).save(ctx, processingStatus);
}

export interface LedgerStateStoreInput {
  jobId: string;
  worker: string;
  signal: AbortSignal;
  now: () => number;
  ledgerDeps?: LedgerDeps;
}

export function createLedgerStateStore(_input: LedgerStateStoreInput): StateStore {
  return {
    async save() {
      throw new Error('not implemented');
    },
  };
}
