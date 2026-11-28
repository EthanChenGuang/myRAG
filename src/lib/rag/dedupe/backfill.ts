import type { RpcClient } from '../backend/supabase-rpc';
import { isTenantKey } from '../ingest/writer';
import { DupClusterError, clusterChunksForTenantKey, listChunkText, recomputeForTenantKey } from './cluster';

export const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;

export interface DupBackfillBatchInfo {
  /** 1-based batch index within this call. */
  batch: number;
  hashed: number;
  clustered: number;
  /** Last chunk id of the batch (the keyset cursor for --resume-after). */
  cursor: string;
}

export interface DupBackfillInput {
  db: RpcClient;
  tenantKey: string;
  batchSize?: number;
  resumeAfter?: string | null;
  signal?: AbortSignal;
  onBatch?: (info: DupBackfillBatchInfo) => void | Promise<void>;
}

export interface DupBackfillReport {
  tenantKey: string;
  hashed: number;
  clustered: number;
  batches: number;
  recomputed: number;
  dissolved: number;
}

export interface DupBackfillDryRunReport {
  tenantKey: string;
  toHash: number;
}

function checkInput(input: { tenantKey: string; batchSize?: number }): number {
  if (!isTenantKey(input.tenantKey)) throw new DupClusterError('invalid_tenant_key');
  const size = input.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new DupClusterError('invalid_batch_size');
  return size;
}

/**
 * D-20: hashes the tenant's current, ready chunks that have no bands for the active embedding profile, in keyset batches, clusters
 * them and then recomputes the tenant's dirty clusters. Counts only; chunk text never leaves this function.
 */
export async function runDupBackfill(input: DupBackfillInput): Promise<DupBackfillReport> {
  const batchSize = checkInput(input);
  const signal = input.signal ?? new AbortController().signal;
  const report: DupBackfillReport = { tenantKey: input.tenantKey, hashed: 0, clustered: 0, batches: 0, recomputed: 0, dissolved: 0 };
  let after = input.resumeAfter ?? null;
  for (;;) {
    signal.throwIfAborted();
    const page = await listChunkText(input.db, input.tenantKey, { after, limit: batchSize }, signal);
    if (page.length === 0) break;
    const batch = await clusterChunksForTenantKey(input.tenantKey, page, { db: input.db, signal });
    report.batches += 1;
    report.hashed += batch.hashed;
    report.clustered += batch.clustered;
    const cursor = page[page.length - 1]?.id as string;
    await input.onBatch?.({ batch: report.batches, hashed: batch.hashed, clustered: batch.clustered, cursor });
    after = cursor;
    if (page.length < batchSize) break;
  }
  signal.throwIfAborted();
  const recompute = await recomputeForTenantKey(input.tenantKey, { db: input.db, signal });
  report.recomputed = recompute.recomputed;
  report.dissolved = recompute.dissolved;
  return report;
}

/** Counts the chunks a run would hash; writes nothing. */
export async function dryRunDupBackfill(input: Omit<DupBackfillInput, 'onBatch'>): Promise<DupBackfillDryRunReport> {
  const batchSize = checkInput(input);
  const signal = input.signal ?? new AbortController().signal;
  let after = input.resumeAfter ?? null;
  let toHash = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = await listChunkText(input.db, input.tenantKey, { after, limit: batchSize }, signal);
    toHash += page.length;
    if (page.length < batchSize) break;
    after = page[page.length - 1]?.id ?? after;
  }
  return { tenantKey: input.tenantKey, toHash };
}
