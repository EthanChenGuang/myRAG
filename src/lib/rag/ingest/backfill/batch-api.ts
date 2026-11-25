import OpenAI, { toFile } from 'openai';
import type { Uploadable } from 'openai/uploads';
import { env } from '@/lib/env';
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

function buildFiles(chunks: BatchChunk[], profile: BatchProfile, limits: BatchLimits, maxFiles: number): BatchFile[] {
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
      if (files.length >= maxFiles) return files;
      current = { lines: [], customIds: [], bytes: 0 };
    }
    current.lines.push(line);
    current.customIds.push(customId);
    current.bytes += size;
  }
  if (current.lines.length > 0) files.push(current);
  return files;
}

/** One /v1/embeddings request per chunk, split by the provider's input-count and file-size limits. */
export function buildBatchLines(chunks: BatchChunk[], profile: BatchProfile, limits: BatchLimits = {}): BatchFile[] {
  return buildFiles(chunks, profile, limits, Number.POSITIVE_INFINITY);
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
  /** Empty when `onVectors` took the vectors. */
  vectors: Map<string, number[]>;
  embedded: number;
  unresolved: string[];
  batchesSubmitted: number;
}

const POLL_INTERVAL_MS = 60_000;
const DEFAULT_OPEN_BATCHES = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const PROVIDER = 'openai';
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'validating',
  'failed',
  'in_progress',
  'finalizing',
  'completed',
  'expired',
  'cancelling',
  'cancelled',
]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'expired', 'cancelled']);

export class EmbedBatchError extends Error {
  readonly stage: string;
  readonly code: string;
  /** Set when the provider accepted a batch that could not be recorded, so an operator can find it. */
  readonly providerBatchId: string | null;

  constructor(stage: string, code: string, providerBatchId: string | null = null) {
    super(`[Backfill] embed batch ${stage} failed (${code})`);
    this.name = 'EmbedBatchError';
    this.stage = stage;
    this.code = code;
    this.providerBatchId = providerBatchId;
  }
}

export function createBatchApiClient(): BatchApiClient {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY }) as unknown as BatchApiClient;
}

const realClock: BatchClock = {
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  },
};

const isTerminal = (status: string): boolean => TERMINAL_STATUSES.has(status);

async function rpcRow(deps: BatchApiDeps, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  deps.signal.throwIfAborted();
  const response = await deps.rpc.rpc(fn, args).abortSignal(deps.signal);
  deps.signal.throwIfAborted();
  if (response.error) throw new EmbedBatchError(fn, response.error.code ?? 'rpc_error');
  const data = response.data as unknown;
  if (data === null || data === undefined) return [];
  return (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
}

async function updateRow(
  deps: BatchApiDeps,
  rowId: string,
  status: string,
  extra: { outputFileId?: string | null; errorFileId?: string | null; error?: string } = {},
): Promise<void> {
  const args: Record<string, unknown> = { p_embed_batch_id: rowId, p_status: status };
  if (extra.outputFileId) args.p_output_file_id = extra.outputFileId;
  if (extra.errorFileId) args.p_error_file_id = extra.errorFileId;
  if (extra.error) args.p_error = extra.error;
  await rpcRow(deps, 'rag_update_embed_batch', args);
}

/** Uploads one request file, creates the batch and records it before anything polls it. */
export async function submitBatch(
  deps: BatchApiDeps,
  input: { batchId: string; profile: BatchProfile; file: BatchFile },
): Promise<SubmittedBatch> {
  const { client, signal } = deps;
  const content = Buffer.from(`${input.file.lines.join('\n')}\n`, 'utf8');
  const uploaded = await client.files.create(
    { file: await toFile(content, 'embeddings-batch.jsonl'), purpose: 'batch' },
    { signal },
  );
  const remote = await client.batches.create(
    { input_file_id: uploaded.id, endpoint: '/v1/embeddings', completion_window: '24h' },
    { signal },
  );
  const status = KNOWN_STATUSES.has(remote.status) ? remote.status : 'validating';
  let rowId: string;
  try {
    const [row] = await rpcRow(deps, 'rag_record_embed_batch', {
      p_batch_id: input.batchId,
      p_profile_id: input.profile.id,
      p_provider: PROVIDER,
      p_provider_batch_id: remote.id,
      p_input_file_id: uploaded.id,
      p_input_count: input.file.customIds.length,
      p_status: status,
    });
    if (!row || typeof row.id !== 'string') throw new EmbedBatchError('rag_record_embed_batch', 'no_row');
    rowId = row.id;
  } catch (error) {
    const code = error instanceof EmbedBatchError ? error.code : 'record_failed';
    throw new EmbedBatchError('record', code, remote.id);
  }
  return {
    rowId,
    providerBatchId: remote.id,
    status,
    inputFileId: uploaded.id,
    customIds: input.file.customIds,
  };
}

async function refresh(deps: BatchApiDeps, target: BatchTarget): Promise<RemoteBatch> {
  const remote = await deps.client.batches.retrieve(target.providerBatchId, { signal: deps.signal });
  if (remote.status !== target.status && KNOWN_STATUSES.has(remote.status) && !isTerminal(remote.status)) {
    await updateRow(deps, target.rowId, remote.status);
  }
  target.status = remote.status;
  return remote;
}

async function* readLines(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  const body = response.body as unknown as AsyncIterable<Uint8Array | string> | null;
  if (!body) {
    for (const line of (await response.text()).split('\n')) if (line.trim()) yield line;
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    signal.throwIfAborted();
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield line;
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

interface OutputLine {
  custom_id?: unknown;
  response?: { status_code?: unknown; body?: { data?: Array<{ embedding?: unknown }> } } | null;
  error?: unknown;
}

function parseLine(raw: string): OutputLine | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as OutputLine) : null;
  } catch {
    return null;
  }
}

function validVector(value: unknown, dims: number): value is number[] {
  return Array.isArray(value) && value.length === dims && value.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** Results are matched by custom_id only; ids that were not requested are ignored. */
async function collectOutput(
  deps: BatchApiDeps,
  remote: RemoteBatch,
  target: BatchTarget,
  options: { profile: BatchProfile; expected?: string[] },
): Promise<CollectResult> {
  const expected = options.expected ? new Set(options.expected) : null;
  const vectors = new Map<string, number[]>();
  const errored = new Set<string>();
  const rejected = new Set<string>();
  const seen = new Set<string>();
  const outputFileId = remote.output_file_id ?? null;
  const errorFileId = remote.error_file_id ?? null;

  if (outputFileId) {
    const response = await deps.client.files.content(outputFileId, { signal: deps.signal });
    for await (const raw of readLines(response, deps.signal)) {
      const line = parseLine(raw);
      const id = line?.custom_id;
      if (!line || typeof id !== 'string' || (expected && !expected.has(id)) || seen.has(id)) continue;
      seen.add(id);
      if (line.error || line.response?.status_code !== 200) {
        errored.add(id);
        continue;
      }
      const embedding = line.response?.body?.data?.[0]?.embedding;
      if (validVector(embedding, options.profile.dims)) vectors.set(id, embedding);
      else rejected.add(id);
    }
  }
  if (errorFileId) {
    const response = await deps.client.files.content(errorFileId, { signal: deps.signal });
    for await (const raw of readLines(response, deps.signal)) {
      const id = parseLine(raw)?.custom_id;
      if (typeof id !== 'string' || (expected && !expected.has(id)) || vectors.has(id) || rejected.has(id)) continue;
      errored.add(id);
    }
  }

  const missing = expected
    ? [...expected].filter((id) => !vectors.has(id))
    : [...new Set([...errored, ...rejected])].filter((id) => !vectors.has(id));
  return {
    rowId: target.rowId,
    providerBatchId: target.providerBatchId,
    status: remote.status,
    vectors,
    missing,
    errored: [...errored],
    rejected: [...rejected],
    outputFileId,
    errorFileId,
  };
}

/** Polls one batch until it ends, then reads its files. The row is closed separately, after the vectors are stored. */
export async function pollAndCollect(
  deps: BatchApiDeps,
  target: BatchTarget,
  options: { profile: BatchProfile; expected?: string[] },
): Promise<CollectResult> {
  const clock = deps.clock ?? realClock;
  const pollMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const tracked: BatchTarget = { ...target };
  for (;;) {
    const remote = await refresh(deps, tracked);
    if (isTerminal(remote.status)) return collectOutput(deps, remote, tracked, options);
    await clock.sleep(pollMs, deps.signal);
  }
}

/** Closes the row of a finished batch: completed stays completed, anything else is superseded by a resubmission. */
async function closeRow(deps: BatchApiDeps, result: CollectResult): Promise<void> {
  const files = { outputFileId: result.outputFileId, errorFileId: result.errorFileId };
  if (result.status === 'completed') await updateRow(deps, result.rowId, 'completed', files);
  else if (result.status === 'cancelled') await updateRow(deps, result.rowId, 'cancelled', files);
  else await updateRow(deps, result.rowId, 'cancelled', { ...files, error: `superseded:${result.status}` });
}

/** Sends only the inputs the finished batch did not deliver, then closes its row. */
export async function resubmitMissing(
  deps: BatchApiDeps,
  input: {
    batchId: string;
    profile: BatchProfile;
    chunks: BatchChunk[];
    result: CollectResult;
    openSlots?: number;
    limits?: BatchLimits;
  },
): Promise<SubmittedBatch[]> {
  const wanted = new Set(input.result.missing);
  const todo = input.chunks.filter((chunk) => wanted.has(batchCustomId(chunk)));
  const files = buildBatchLines(todo, input.profile, input.limits);
  if (files.length > (input.openSlots ?? 1)) throw new EmbedBatchError('resubmit', 'open_limit');
  const submitted: SubmittedBatch[] = [];
  for (const file of files) submitted.push(await submitBatch(deps, { batchId: input.batchId, profile: input.profile, file }));
  await closeRow(deps, input.result);
  return submitted;
}

/** Open rows of this backfill batch and profile, for resuming after a restart. */
export async function listOpenBatches(deps: BatchApiDeps, batchId: string, profileId: string): Promise<EmbedBatchRow[]> {
  const rows = await rpcRow(deps, 'rag_open_embed_batches', { p_batch_id: batchId });
  return rows.filter(
    (row): row is EmbedBatchRow & Record<string, unknown> =>
      row.profile_id === profileId && typeof row.id === 'string' && typeof row.provider_batch_id === 'string',
  );
}

interface ActiveBatch {
  target: BatchTarget;
  /** The custom ids this process sent; null for a batch picked up from an earlier run. */
  ids: string[] | null;
}

/**
 * Embeds every chunk through the Batch API: drains batches left open by an earlier run, then submits new
 * ones with at most `openLimit` open, collects them and resubmits whatever did not come back.
 * With `onVectors`, vectors are handed over per batch and not kept in the result.
 */
export async function embedViaBatchApi(deps: BatchApiDeps, input: EmbedViaBatchApiInput): Promise<EmbedViaBatchApiResult> {
  const { batchId, profile } = input;
  const openLimit = Math.max(1, Math.floor(input.openLimit ?? DEFAULT_OPEN_BATCHES));
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const clock = deps.clock ?? realClock;
  const pollMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const byId = new Map<string, BatchChunk>();
  for (const chunk of input.chunks) byId.set(batchCustomId(chunk), chunk);

  const vectors = new Map<string, number[]>();
  const done = new Set<string>();
  const unresolved = new Set<string>();
  const attempts = new Map<string, number>();
  let submittedCount = 0;

  let active: ActiveBatch[] = (await listOpenBatches(deps, batchId, profile.id)).map((row) => ({
    target: { rowId: row.id, providerBatchId: row.provider_batch_id as string, status: row.status },
    ids: null,
  }));
  let released = active.length === 0;
  let queue: BatchChunk[] = released ? [...byId.values()] : [];

  for (;;) {
    if (!released && !active.some((entry) => entry.ids === null)) {
      released = true;
      queue = [...byId].filter(([id]) => !done.has(id) && !unresolved.has(id)).map(([, chunk]) => chunk);
    }
    while (released && active.length < openLimit && queue.length > 0) {
      const [file] = buildFiles(queue, profile, input.limits ?? {}, 1);
      if (!file) break;
      queue.splice(0, file.customIds.length);
      for (const id of file.customIds) attempts.set(id, (attempts.get(id) ?? 0) + 1);
      const submitted = await submitBatch(deps, { batchId, profile, file });
      submittedCount += 1;
      active.push({ target: submitted, ids: file.customIds });
    }
    if (active.length === 0) break;

    for (const entry of [...active]) {
      const remote = await refresh(deps, entry.target);
      if (!isTerminal(remote.status)) continue;
      const result = await collectOutput(deps, remote, entry.target, {
        profile,
        expected: entry.ids ?? undefined,
      });
      const fresh = new Map<string, number[]>();
      for (const [id, vector] of result.vectors) {
        if (byId.has(id) && !done.has(id)) fresh.set(id, vector);
      }
      for (const id of fresh.keys()) done.add(id);
      if (input.onVectors) {
        if (fresh.size > 0) await input.onVectors(fresh);
      } else {
        for (const [id, vector] of fresh) vectors.set(id, vector);
      }
      await closeRow(deps, result);
      active = active.filter((other) => other !== entry);
      if (!entry.ids) continue;
      for (const id of result.missing) {
        const chunk = byId.get(id);
        if (!chunk || done.has(id)) continue;
        if ((attempts.get(id) ?? 0) >= maxAttempts) unresolved.add(id);
        else queue.push(chunk);
      }
    }
    if (active.length > 0) await clock.sleep(pollMs, deps.signal);
  }

  return { vectors, embedded: done.size, unresolved: [...unresolved], batchesSubmitted: submittedCount };
}
