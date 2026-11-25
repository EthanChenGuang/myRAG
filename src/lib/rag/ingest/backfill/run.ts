import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { BackfillBatchRef, InventoryEntry } from './inventory';
import type { SourceItem } from './sources';

export type RunEntry = InventoryEntry & Pick<SourceItem, 'open'>;

export interface RunDeps {
  rpc?: RpcClient;
  signal: AbortSignal;
}

export interface EnqueueRunOptions extends RunDeps {
  snapshot?: () => import('../queue-config').QueueConfig;
  kind?: 'ingest' | 'dry_run';
}

export interface EnqueueRunResult {
  enqueued: number;
  existing: number;
  refused: Record<string, number>;
}

export interface BatchProgress {
  spentUsd: number;
  leased: number;
  counts: Record<string, Record<string, number>>;
}

export interface MonitorOptions extends RunDeps {
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (progress: BatchProgress) => void;
}

export interface BackfillEndReport {
  batchId: string;
  ingest: { total: number; byStatus: Record<string, number> };
  sample: { total: number; byStatus: Record<string, number> };
  failures: Array<{ sourceKey: string; errorClass: string | null; deadLetter: boolean }>;
  needsReview: Array<{ sourceKey: string; documentId: string | null; reason: string | null }>;
  cost: { projectedUsd: number | null; actualUsd: number; spentUsd: number; differenceUsd: number | null };
}

export function stagedOriginalKey(tenantKey: string, batchId: string, entry: Pick<InventoryEntry, 'fileSha256' | 'filename'>): string {
  void tenantKey;
  void batchId;
  void entry;
  return '';
}

export async function enqueueRun(batch: BackfillBatchRef, entries: readonly RunEntry[], options: EnqueueRunOptions): Promise<EnqueueRunResult> {
  void batch;
  void entries;
  void options;
  return { enqueued: 0, existing: 0, refused: {} };
}

export function openJobs(progress: BatchProgress): number {
  void progress;
  return 0;
}

export async function monitor(batch: BackfillBatchRef, options: MonitorOptions): Promise<BatchProgress> {
  void batch;
  void options;
  return { spentUsd: 0, leased: 0, counts: {} };
}

export async function endReport(batch: BackfillBatchRef, deps: RunDeps): Promise<BackfillEndReport> {
  void deps;
  return { batchId: batch.id, ingest: { total: 0, byStatus: {} }, sample: { total: 0, byStatus: {} }, failures: [], needsReview: [], cost: { projectedUsd: null, actualUsd: 0, spentUsd: 0, differenceUsd: null } };
}

export async function releaseStagedOriginals(batch: BackfillBatchRef, deps: RunDeps): Promise<number> {
  void batch;
  void deps;
  return 0;
}
