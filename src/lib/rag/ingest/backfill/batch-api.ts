import type { Uploadable } from 'openai/uploads';
import type { RpcClient } from '../../backend/supabase-rpc';
import type { EmbeddingProfile } from '../../embeddings/active-profile';
import { OPENAI_NATIVE_DIMS } from '../../embeddings/types';

export const MAX_BATCH_INPUTS = 50_000;
export const MAX_BATCH_BYTES = 190 * 1024 * 1024;

export type BatchProfile = Pick<EmbeddingProfile, 'id' | 'provider' | 'model' | 'dims'>;

export interface BatchChunk {
  chunkId: string;
  embeddingTextVersion: number;
  text: string;
}

export interface BatchFile {
  lines: string[];
  customIds: string[];
  bytes: number;
}

export interface BatchLimits {
  maxInputs?: number;
  maxBytes?: number;
}

export function batchCustomId(chunk: Pick<BatchChunk, 'chunkId' | 'embeddingTextVersion'>): string {
  return `${chunk.chunkId}:${chunk.embeddingTextVersion}`;
}

/** One /v1/embeddings request per chunk, split by the provider's input-count and file-size limits. */
export function buildBatchLines(chunks: BatchChunk[], profile: BatchProfile, limits: BatchLimits = {}): BatchFile[] {
  const maxInputs = limits.maxInputs ?? MAX_BATCH_INPUTS;
  const maxBytes = limits.maxBytes ?? MAX_BATCH_BYTES;
  const files: BatchFile[] = [];
  let current: BatchFile = { lines: [], customIds: [], bytes: 0 };
  for (const chunk of chunks) {
    const customId = batchCustomId(chunk);
    const body: Record<string, unknown> = { model: profile.model, input: chunk.text };
    if (profile.dims !== OPENAI_NATIVE_DIMS) body.dimensions = profile.dims;
    const line = JSON.stringify({ custom_id: customId, method: 'POST', url: '/v1/embeddings', body });
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (size > maxBytes) throw new Error('[Backfill] batch input too_large for one file');
    if (current.lines.length > 0 && (current.lines.length >= maxInputs || current.bytes + size > maxBytes)) {
      files.push(current);
      current = { lines: [], customIds: [], bytes: 0 };
    }
    current.lines.push(line);
    current.customIds.push(customId);
    current.bytes += size;
  }
  if (current.lines.length > 0) files.push(current);
  return files;
}

export type BatchStatus =
  | 'validating'
  | 'failed'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'expired'
  | 'cancelling'
  | 'cancelled';

export interface RemoteBatch {
  id: string;
  status: BatchStatus | string;
  input_file_id?: string | null;
  output_file_id?: string | null;
  error_file_id?: string | null;
}

interface RequestOptions {
  signal?: AbortSignal;
}

/** The slice of the OpenAI client the Batch API path uses; the real `OpenAI` client satisfies it. */
export interface BatchApiClient {
  files: {
    create(body: { file: Uploadable; purpose: 'batch' }, options?: RequestOptions): PromiseLike<{ id: string }>;
    content(fileId: string, options?: RequestOptions): PromiseLike<Response>;
  };
  batches: {
    create(
      body: { input_file_id: string; endpoint: '/v1/embeddings'; completion_window: '24h' },
      options?: RequestOptions,
    ): PromiseLike<RemoteBatch>;
    retrieve(batchId: string, options?: RequestOptions): PromiseLike<RemoteBatch>;
  };
}

export interface BatchClock {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface BatchApiDeps {
  rpc: RpcClient;
  client: BatchApiClient;
  signal: AbortSignal;
  clock?: BatchClock;
  pollIntervalMs?: number;
}

export interface BatchTarget {
  rowId: string;
  providerBatchId: string;
  status?: string;
}

export interface SubmittedBatch extends BatchTarget {
  inputFileId: string;
  customIds: string[];
}

export interface CollectResult {
  rowId: string;
  providerBatchId: string;
  status: BatchStatus | string;
  vectors: Map<string, number[]>;
  /** Expected ids without a usable vector (errored, rejected or absent). Without `expected`, errored plus rejected. */
  missing: string[];
  errored: string[];
  rejected: string[];
  outputFileId: string | null;
  errorFileId: string | null;
}

export interface EmbedBatchRow {
  id: string;
  profile_id: string;
  provider_batch_id: string | null;
  input_file_id: string | null;
  status: string;
}

export interface EmbedViaBatchApiInput {
  batchId: string;
  profile: BatchProfile;
  chunks: BatchChunk[];
  openLimit?: number;
  maxAttempts?: number;
  limits?: BatchLimits;
  /** Awaited with each batch's vectors before that batch's row is closed, so a crash cannot lose them. */
  onVectors?: (vectors: Map<string, number[]>) => Promise<void>;
}

export interface EmbedViaBatchApiResult {
  vectors: Map<string, number[]>;
  unresolved: string[];
  batchesSubmitted: number;
}

const NOT_IMPLEMENTED = '[Backfill] batch api not implemented';

export async function submitBatch(
  _deps: BatchApiDeps,
  _input: { batchId: string; profile: BatchProfile; file: BatchFile },
): Promise<SubmittedBatch> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function pollAndCollect(
  _deps: BatchApiDeps,
  _target: BatchTarget,
  _options: { profile: BatchProfile; expected?: string[] },
): Promise<CollectResult> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function resubmitMissing(
  _deps: BatchApiDeps,
  _input: {
    batchId: string;
    profile: BatchProfile;
    chunks: BatchChunk[];
    result: CollectResult;
    openSlots?: number;
    limits?: BatchLimits;
  },
): Promise<SubmittedBatch[]> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function embedViaBatchApi(
  _deps: BatchApiDeps,
  _input: EmbedViaBatchApiInput,
): Promise<EmbedViaBatchApiResult> {
  throw new Error(NOT_IMPLEMENTED);
}
