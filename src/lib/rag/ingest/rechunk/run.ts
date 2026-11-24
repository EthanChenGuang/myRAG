import type { RpcClient } from '../../backend/supabase-rpc';
import type { TenantScope } from '../../tenant/scope';
import type { RechunkCostReport } from './cost';

/** A request the job cannot start from (bad arguments, a profile it must not build, a run that does not match); nothing was changed. */
export class RechunkInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`[RAG Rechunk] ${code}`);
    this.name = 'RechunkInputError';
    this.code = code;
  }
}

export interface RechunkDocumentInfo {
  runId: string;
  documentId: string;
  tenantKey: string;
  /** 1-based number of the document within this call. */
  position: number;
  outcome: 'written' | 'gap';
}

export interface RechunkHooks {
  /** Runs after a document was written (or recorded as a gap) and the cursor committed with it. */
  afterDocument?: (info: RechunkDocumentInfo) => void | Promise<void>;
}

export interface RunRechunkInput {
  db: RpcClient;
  profileId?: string | null;
  /** Only needed when the same profile id exists for more than one document type. */
  docType?: string | null;
  tenantKey?: string | null;
  resumeRunId?: string | null;
  /** Documents read per page; default 20. */
  batchSize?: number;
  /** Stop after this many documents; the run stays open and the next call continues it. */
  maxDocuments?: number;
  /** Time budget of this call in milliseconds; the call stops at a document boundary when it runs out. */
  deadlineMs?: number;
  signal?: AbortSignal;
  hooks?: RechunkHooks;
  onProgress?: (line: string) => void;
  /** The tenant scope the writer of one document uses; null refuses the document. Default: the operator backfill scope resolver. */
  scopeFor?: (tenantKey: string, signal: AbortSignal) => Promise<TenantScope | null>;
}

export type RechunkRunStatus = 'running' | 'completed' | 'incomplete' | 'failed';

export interface RechunkGap {
  documentId: string;
  tenantKey: string;
  reason: string;
  detail: string | null;
}

export interface RechunkReport {
  runId: string;
  profileId: string;
  docType: string;
  tenantKey: string | null;
  /** running: a bounded call ended with documents left; completed: every document in scope has children; incomplete: some do not (see gaps). */
  status: RechunkRunStatus;
  /** Why a failed run stopped: embed_failed, embedding_profile_mismatch, provider_unconfigured, profile_write_failed, object_store_unavailable. */
  reason: string | null;
  profileStatus: string;
  resumed: boolean;
  documentsWritten: number;
  documentsGapped: number;
  parentsWritten: number;
  childrenWritten: number;
  docsDone: number;
  docsTotal: number;
  /** True while the run is still open: call again to continue. */
  more: boolean;
  cursor: string | null;
  tenants: Record<string, { documents: number; children: number; tokens: number }>;
  gaps: RechunkGap[];
  warnings: string[];
}

export interface DryRunRechunkInput {
  db: RpcClient;
  profileId: string;
  docType?: string | null;
  tenantKey?: string | null;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface DryRunRechunkTenant {
  tenantKey: string;
  /** Current ready documents with stored parse output: what a run would build. */
  eligibleDocuments: number;
  /** Current ready documents a run could not build (no stored parse output), listed for a budgeted re-ingest. */
  gapDocuments: number;
  parents: number;
  children: number;
  /** cl100k_base tokens of the embedding text of the children. */
  tokens: number;
}

export interface DryRunRechunkReport {
  profileId: string;
  docType: string;
  profileStatus: string;
  childTokens: number;
  parentMode: string;
  tenants: DryRunRechunkTenant[];
  gaps: RechunkGap[];
  /** The embedding profiles a run would embed for (active and backfilling) and what that costs. */
  embeddingProfiles: string[];
  cost: RechunkCostReport;
}

export async function runRechunk(input: RunRechunkInput): Promise<RechunkReport> {
  return {
    runId: '',
    profileId: input.profileId ?? '',
    docType: '',
    tenantKey: input.tenantKey ?? null,
    status: 'failed',
    reason: 'not_implemented',
    profileStatus: '',
    resumed: false,
    documentsWritten: 0,
    documentsGapped: 0,
    parentsWritten: 0,
    childrenWritten: 0,
    docsDone: 0,
    docsTotal: 0,
    more: false,
    cursor: null,
    tenants: {},
    gaps: [],
    warnings: [],
  };
}

export async function runRechunkBatch(input: RunRechunkInput): Promise<RechunkReport> {
  return runRechunk(input);
}

export async function dryRunRechunk(input: DryRunRechunkInput): Promise<DryRunRechunkReport> {
  return {
    profileId: input.profileId,
    docType: '',
    profileStatus: '',
    childTokens: 0,
    parentMode: '',
    tenants: [],
    gaps: [],
    embeddingProfiles: [],
    cost: { tenants: [], totals: { chunks: 0, tokens: 0, usd: 0 }, profiles: [], estimated: false, note: null },
  };
}
