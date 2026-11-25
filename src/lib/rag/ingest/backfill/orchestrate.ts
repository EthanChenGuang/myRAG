import type { BackfillDryRunReport } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { QueueConfig } from '../queue-config';
import type { ProjectionProfile } from './report';
import type { BackfillEndReport } from './run';
import type { RunnerHandle, RunnerIo, RunnerName } from './runners';
import type { BackfillSourceDeps, SourceKind } from './sources';
import type { BackfillBatchRef } from './inventory';

export const EXIT = { ok: 0, failed: 1, reportOnly: 2, overBudget: 3, usage: 64 } as const;

export interface BackfillRequest {
  scope: TenantScope;
  source: { kind: SourceKind; ref: string } | null;
  root: string | null;
  budgetUsd: number | null;
  concurrency: number;
  dryRun: boolean;
  resumeBatchId: string | null;
  runner: RunnerName;
}

export interface OrchestrateDeps {
  rpc?: RpcClient;
  signal: AbortSignal;
  io: RunnerIo;
  sourceDeps?: BackfillSourceDeps;
  snapshot?: () => QueueConfig;
  profiles?: () => Promise<ProjectionProfile[]>;
  startRunner?: (runner: RunnerName, batchId: string) => RunnerHandle;
  monitorIntervalMs?: number;
  monitorTimeoutMs?: number;
}

export interface BackfillOutcome {
  exitCode: number;
  batchId: string | null;
  report: BackfillDryRunReport | null;
  end: BackfillEndReport | null;
}

export async function runBackfill(_request: BackfillRequest, _deps: OrchestrateDeps): Promise<BackfillOutcome> {
  return { exitCode: EXIT.failed, batchId: null, report: null, end: null };
}

export async function finishBatch(batch: BackfillBatchRef, _deps: Pick<OrchestrateDeps, 'rpc' | 'signal' | 'io'>): Promise<BackfillEndReport> {
  return {
    batchId: batch.id,
    ingest: { total: 0, byStatus: {} },
    sample: { total: 0, byStatus: {} },
    failures: [],
    needsReview: [],
    cost: { projectedUsd: null, actualUsd: 0, spentUsd: 0, differenceUsd: null },
  };
}
