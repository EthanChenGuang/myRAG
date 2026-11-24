import type { RpcClient } from '../../backend/supabase-rpc';
import type { ReembedCostReport } from './cost';

export class ReembedInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`[Re-embed] ${code}`);
    this.name = 'ReembedInputError';
    this.code = code;
  }
}

export type ReembedPhase = 'pass' | 'sweep' | 'derive';

export interface ReembedBatchInfo {
  runId: string;
  phase: ReembedPhase;
  /** 1-based number of the batch within this call. */
  batch: number;
  chunks: number;
}

export interface ReembedHooks {
  /** Runs after a batch was embedded and before it is written. */
  beforeWrite?: (info: ReembedBatchInfo) => void | Promise<void>;
  /** Runs after a batch was written and the cursor committed with it. */
  afterWrite?: (info: ReembedBatchInfo) => void | Promise<void>;
}

export interface RunReembedInput {
  db: RpcClient;
  profileId?: string | null;
  tenantKey?: string | null;
  batchSize?: number;
  resumeRunId?: string | null;
  deriveFrom?: string | null;
  actor?: string;
  signal?: AbortSignal;
  hooks?: ReembedHooks;
  onProgress?: (line: string) => void;
}

export interface ReembedReport {
  runId: string;
  profileId: string;
  status: 'completed' | 'failed';
  /** Why a failed run stopped: embedding_profile_mismatch, provider_failed, provider_unconfigured, incomplete, derive_source_incomplete or no_progress. */
  reason: string | null;
  derived: boolean;
  resumed: boolean;
  chunksEmbedded: number;
  chunksMissing: number;
  tokens: number;
  batches: number;
  cursor: string | null;
  tenants: Record<string, { chunks: number; tokens: number }>;
  hosts: Array<{ host: string; chunks: number; share: number }>;
  warnings: string[];
}

export interface DryRunInput {
  db: RpcClient;
  profileId: string;
  tenantKey?: string | null;
  deriveFrom?: string | null;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface DryRunReport {
  profileId: string;
  provider: string;
  model: string;
  dims: number;
  derived: boolean;
  cost: ReembedCostReport & { tenants: Array<ReembedCostReport['tenants'][number] & { chunksMissing: number }> };
}

export interface RollbackInput {
  db: RpcClient;
  runId: string;
  actor?: string;
  signal?: AbortSignal;
}

export async function runReembed(input: RunReembedInput): Promise<ReembedReport> {
  return {
    runId: '',
    profileId: input.profileId ?? '',
    status: 'failed',
    reason: null,
    derived: false,
    resumed: false,
    chunksEmbedded: 0,
    chunksMissing: 0,
    tokens: 0,
    batches: 0,
    cursor: null,
    tenants: {},
    hosts: [],
    warnings: [],
  };
}

export async function dryRunReembed(input: DryRunInput): Promise<DryRunReport> {
  return {
    profileId: input.profileId,
    provider: '',
    model: '',
    dims: 0,
    derived: false,
    cost: { tenants: [], totals: { chunks: 0, tokens: 0, usd: 0 }, estimated: false, note: null },
  };
}

export async function rollbackReembedRun(_input: RollbackInput): Promise<{ rowsDeleted: number; profileStatus: string }> {
  return { rowsDeleted: 0, profileStatus: '' };
}
