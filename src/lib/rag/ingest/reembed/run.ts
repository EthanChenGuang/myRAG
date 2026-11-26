import type { RpcClient } from '../../backend/supabase-rpc';
import { requestTenantNightly } from '../../config-gate/eval-run-requests';
import { getBackfillingProfiles, isEmbeddingProfilesEnabled, listEmbeddingProfiles, refreshAfterOperation } from '../../embeddings/active-profile';
import { EmbeddingProfileMismatch } from '../../embeddings/mrl';
import { canonicalModelId, getEmbeddingProviderFor } from '../../embeddings/registry';
import type { EmbedOutput, EmbeddingProvider } from '../../embeddings/types';
import type { DocType } from '../profiles/load';
import { getProcessingProfile } from '../profiles/load';
import { buildEmbeddingText, templateHeaderFor } from '../text/embedding-text';
import { countTokens } from '../text/tokens';
import { ReembedWriterError, createReembedWriter, isTenantKey, type ReembedChunk, type ReembedRun } from '../writer';
import { estimateReembedCost, type ReembedCostReport } from './cost';

/** A request the job cannot start from (bad arguments, a run that does not match them); nothing was changed. */
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
  provider: string;
  status: 'completed' | 'failed';
  /** Why a failed run stopped: embedding_profile_mismatch, provider_failed, provider_unconfigured, incomplete, derive_source_incomplete or no_progress. */
  reason: string | null;
  derived: boolean;
  resumed: boolean;
  chunksEmbedded: number;
  chunksMissing: number;
  /** Tokens the provider reported for this call. */
  tokens: number;
  batches: number;
  cursor: string | null;
  /** Chunks written by this call and their cl100k_base token estimate, per tenant. */
  tenants: Record<string, { chunks: number; tokens: number }>;
  /** The share of rows this call wrote per serving host. */
  hosts: Array<{ host: string; chunks: number; share: number }>;
  warnings: string[];
  /** The profile's doc types; null for an unscoped profile. A scoped run fills only these and leaves the profile status alone. */
  scope: string[] | null;
  /** The profile status read after the run ended ('' when it could not be read): 'available' for a scoped profile. */
  profileStatus: string;
}

export interface DryRunInput {
  db: RpcClient;
  profileId: string;
  tenantKey?: string | null;
  deriveFrom?: string | null;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface DryRunTenant {
  tenantKey: string;
  /** Current ready chunks of the tenant. */
  chunksTotal: number;
  /** Of those, the chunks that have no vector of the profile yet: what a run would embed. */
  chunksToEmbed: number;
  contentChars: number;
}

export interface DryRunReport {
  profileId: string;
  provider: string;
  model: string;
  dims: number;
  derived: boolean;
  /** The profile's doc types; null for an unscoped profile. Counts and cost cover only these. */
  scope: string[] | null;
  tenants: DryRunTenant[];
  cost: ReembedCostReport;
}

export interface RollbackInput {
  db: RpcClient;
  runId: string;
  actor?: string;
  signal?: AbortSignal;
}

export const DEFAULT_BATCH_SIZE = 128;
export const MAX_BATCH_SIZE = 1000;
const DEFAULT_ACTOR = 'reembed-cli';
const MAX_SWEEP_ROUNDS = 4;
/** The vectors of one write call stay near 1 MB as a JSON body, as ingest's chunk writes do. */
const MAX_WRITE_BYTES = 1_000_000;
const BYTES_PER_VECTOR_DIM = 20;
const ROW_OVERHEAD_BYTES = 150;
const PROGRESS_EVERY_BATCHES = 10;

function checkBatchSize(value: number | undefined): number {
  const size = value ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new ReembedInputError('invalid_batch_size');
  return size;
}

function checkTenantKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isTenantKey(value)) throw new ReembedInputError('invalid_tenant_key');
  return value;
}

/** Keeps the in-process profile pointer in step with the status change the SQL made; never fails the job. */
async function refreshPointer(): Promise<void> {
  try {
    await refreshAfterOperation();
  } catch {
    // The registry may be unreadable from here; the pointer cache expires on its own.
  }
}

function switchIsOff(): boolean {
  try {
    return !isEmbeddingProfilesEnabled();
  } catch {
    return false;
  }
}

/**
 * The text ingest embeds for the chunk, rebuilt from stored columns only: the section path, the profile header rendered from the document's
 * stored columns, and the content. An unknown document type renders no header.
 */
export function embeddingTextOf(chunk: ReembedChunk, warnings: Set<string>): string {
  let header = '';
  if (chunk.docType) {
    try {
      header = templateHeaderFor(getProcessingProfile(chunk.docType as DocType).embedding_text_template, chunk.templateRow);
    } catch {
      warnings.add('unknown_doc_type');
    }
  }
  return buildEmbeddingText({ section_path: chunk.sectionPath, content: chunk.content, template_header: header });
}

/**
 * Fills one embedding profile from stored chunk text. A keyset pass by chunk id embeds the chunks that lack a vector of the profile, then a
 * sweep embeds whatever is still missing (chunks written behind the cursor meanwhile and dual-write gaps), and the run completes only when
 * the database confirms nothing is missing. Each write call upserts its vectors and moves the cursor in one transaction, so a process
 * killed at any point resumes (resumeRunId) without a duplicate and without a gap. The job reads stored text only: no parser, sidecar or
 * object-store call exists on this path. With deriveFrom the profile is filled from stored vectors of a larger profile of the same model.
 */
export async function runReembed(input: RunReembedInput): Promise<ReembedReport> {
  const signal = input.signal ?? new AbortController().signal;
  const writer = createReembedWriter({ db: input.db, signal });
  const batchSize = checkBatchSize(input.batchSize);
  const actor = input.actor ?? DEFAULT_ACTOR;
  const tenantKey = checkTenantKey(input.tenantKey);
  const deriveFrom = input.deriveFrom ?? null;
  const hooks = input.hooks ?? {};

  let run: ReembedRun;
  let resumed = false;
  if (input.resumeRunId) {
    const existing = await writer.get(input.resumeRunId);
    if (!existing) throw new ReembedInputError('run_not_found');
    const sameProfile = !input.profileId || input.profileId === existing.profileId;
    const sameTenant = tenantKey === null || tenantKey === existing.tenantKey;
    const sameSource = deriveFrom === null || deriveFrom === existing.derivedFrom;
    if (!sameProfile || !sameTenant || !sameSource) throw new ReembedInputError('resume_mismatch');
    run = await writer.resume(input.resumeRunId, actor);
    resumed = true;
  } else {
    if (!input.profileId) throw new ReembedInputError('profile_required');
    run = await writer.start({ profileId: input.profileId, tenantKey, actor, derivedFrom: deriveFrom });
  }
  await refreshPointer();
  // A scoped profile is never 'backfilling' (0440), so an unscoped run needs no scope read.
  const scope = run.profileStatus === 'backfilling' ? null : await writer.profileScope(run.profileId);
  let profileStatus = run.profileStatus;

  const warnings = new Set<string>();
  if (switchIsOff()) {
    warnings.add('profiles_switch_off');
  } else if (scope === null) {
    // With the switch on, ingestion dual-writes every backfilling profile; confirm this one is in that set so documents added during the run are covered.
    try {
      if (!(await getBackfillingProfiles()).some((profile) => profile.id === run.profileId)) warnings.add('dual_write_not_active');
    } catch {
      warnings.add('dual_write_unverified');
    }
  }
  const tenants: Record<string, { chunks: number; tokens: number }> = {};
  const hosts = new Map<string, number>();
  let embedded = 0;
  let tokens = 0;
  let batches = 0;
  let missing = 0;
  let cursor = run.cursorChunkId;
  if (scope !== null) input.onProgress?.(`scope: ${scope.join(', ')}`);
  input.onProgress?.(
    `run ${run.runId} ${resumed ? 'resumed' : 'started'}: profile ${run.profileId}, ${run.derivedFrom ? `derived from ${run.derivedFrom}` : `${run.provider} ${run.dims} dims`}, ${
      run.tenantKey ? `tenant ${run.tenantKey}` : 'all tenants'
    }`,
  );

  function build(status: 'completed' | 'failed', reason: string | null): ReembedReport {
    const total = [...hosts.values()].reduce((sum, count) => sum + count, 0);
    return {
      runId: run.runId,
      profileId: run.profileId,
      provider: run.provider,
      status,
      reason,
      derived: run.derivedFrom !== null,
      resumed,
      chunksEmbedded: embedded,
      chunksMissing: missing,
      tokens,
      batches,
      cursor,
      tenants,
      hosts: [...hosts.entries()].map(([host, chunks]) => ({ host, chunks, share: total === 0 ? 0 : chunks / total })),
      warnings: [...warnings].sort(),
      scope,
      profileStatus,
    };
  }

  /** Reads the profile status the SQL left; a scoped profile stays 'available'. */
  async function readProfileStatus(): Promise<void> {
    try {
      profileStatus = (await writer.get(run.runId))?.profileStatus ?? profileStatus;
    } catch {
      // The status is informational; the run outcome stands either way.
    }
  }

  async function fail(reason: string): Promise<ReembedReport> {
    try {
      await writer.finish(run.runId, 'failed');
    } catch {
      // A run that cannot be marked failed stays running, and a resume works on it either way.
    }
    await refreshPointer();
    await readProfileStatus();
    return build('failed', reason);
  }

  async function complete(): Promise<ReembedReport> {
    const done = await writer.finish(run.runId, 'completed');
    missing = done.missing;
    await refreshPointer();
    await readProfileStatus();
    const report = build('completed', null);
    await requestNightlies(report);
    return report;
  }

  /** D-19: one tenant nightly request per tenant this run embedded (or the run's own tenant); never fails the run. */
  async function requestNightlies(report: ReembedReport): Promise<void> {
    const keys = new Set(Object.keys(report.tenants));
    if (run.tenantKey) keys.add(run.tenantKey);
    for (const key of [...keys].sort()) {
      await requestTenantNightly(input.db, { tenantKey: key, reason: 'reembed_completed', refId: run.runId });
    }
  }

  function progress(): void {
    if (batches % PROGRESS_EVERY_BATCHES === 0) input.onProgress?.(`progress: ${embedded} chunks written in ${batches} batches`);
  }

  if (run.derivedFrom !== null) {
    for (;;) {
      signal.throwIfAborted();
      const result = await writer.deriveBatch(run.runId, batchSize);
      if (result.derived === 0) break;
      batches += 1;
      embedded += result.derived;
      cursor = result.cursor ?? cursor;
      progress();
      await hooks.afterWrite?.({ runId: run.runId, phase: 'derive', batch: batches, chunks: result.derived });
    }
    missing = await writer.remaining(run.runId);
    if (missing > 0) return fail('derive_source_incomplete');
    return complete();
  }

  let provider: EmbeddingProvider;
  try {
    provider = getEmbeddingProviderFor(run.provider, run.model);
  } catch {
    return fail('provider_unconfigured');
  }
  if (canonicalModelId(provider.model) !== canonicalModelId(run.model) || !provider.supportedDims.includes(run.dims)) {
    return fail('embedding_profile_mismatch');
  }

  const rowsPerWrite = Math.max(1, Math.floor(MAX_WRITE_BYTES / (run.dims * BYTES_PER_VECTOR_DIM + ROW_OVERHEAD_BYTES)));

  /** Embeds one batch and writes it; returns the failure reason, or null when the batch is stored. */
  async function processBatch(chunks: ReembedChunk[], phase: ReembedPhase, moveCursor: boolean): Promise<string | null> {
    signal.throwIfAborted();
    const texts = chunks.map((chunk) => embeddingTextOf(chunk, warnings));
    let output: EmbedOutput;
    try {
      output = await provider.embedDocuments(texts, { dims: run.dims, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      return error instanceof EmbeddingProfileMismatch ? 'embedding_profile_mismatch' : 'provider_failed';
    }
    const wellFormed =
      canonicalModelId(output.model) === canonicalModelId(run.model) &&
      output.vectors.length === texts.length &&
      output.vectors.every((vector) => vector.length === run.dims && vector.every((x) => Number.isFinite(x)));
    if (!wellFormed) return 'embedding_profile_mismatch';

    batches += 1;
    const info: ReembedBatchInfo = { runId: run.runId, phase, batch: batches, chunks: chunks.length };
    await hooks.beforeWrite?.(info);

    const reported = Number.isFinite(output.usage.tokens) && output.usage.tokens > 0 ? output.usage.tokens : texts.reduce((sum, text) => sum + countTokens(text), 0);
    for (let from = 0; from < chunks.length; from += rowsPerWrite) {
      const slice = chunks.slice(from, from + rowsPerWrite);
      const last = slice[slice.length - 1] as ReembedChunk;
      const result = await writer.writeBatch(
        run.runId,
        slice.map((chunk, index) => ({ chunkId: chunk.id, vector: output.vectors[from + index] as number[], host: output.host })),
        moveCursor ? last.id : null,
        from === 0 ? reported : 0,
      );
      embedded += result.written;
      cursor = result.cursor ?? cursor;
    }
    tokens += reported;
    hosts.set(output.host, (hosts.get(output.host) ?? 0) + chunks.length);
    for (const [index, chunk] of chunks.entries()) {
      const entry = (tenants[chunk.tenantKey] ??= { chunks: 0, tokens: 0 });
      entry.chunks += 1;
      entry.tokens += countTokens(texts[index] as string);
    }
    progress();
    await hooks.afterWrite?.(info);
    return null;
  }

  let after = run.cursorChunkId;
  for (;;) {
    signal.throwIfAborted();
    const chunks = await writer.nextBatch(run.runId, after, batchSize);
    if (chunks.length === 0) break;
    const failure = await processBatch(chunks, 'pass', true);
    if (failure) return fail(failure);
    after = (chunks[chunks.length - 1] as ReembedChunk).id;
  }

  const swept = new Set<string>();
  for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
    for (;;) {
      signal.throwIfAborted();
      const chunks = await writer.missingBatch(run.runId, null, batchSize);
      if (chunks.length === 0) break;
      if (chunks.some((chunk) => swept.has(chunk.id))) return fail('no_progress');
      for (const chunk of chunks) swept.add(chunk.id);
      const failure = await processBatch(chunks, 'sweep', false);
      if (failure) return fail(failure);
    }
    try {
      return await complete();
    } catch (error) {
      if (error instanceof ReembedWriterError && error.detail === 'incomplete') continue;
      throw error;
    }
  }
  return fail('incomplete');
}

/**
 * What a run would cost, per tenant, without writing anything: the chunks that lack a vector of the profile, their cl100k_base token count
 * (stored text is read here and counted in this process, nothing leaves it) and the registry price. Prints no text; the report has counts
 * and dollars only.
 */
export async function dryRunReembed(input: DryRunInput): Promise<DryRunReport> {
  const signal = input.signal ?? new AbortController().signal;
  const writer = createReembedWriter({ db: input.db, signal });
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  const profiles = await listEmbeddingProfiles();
  const profile = profiles.find((candidate) => candidate.id === input.profileId);
  if (!profile) throw new ReembedInputError('unknown_profile');
  if (profile.storage === 'legacy_column') throw new ReembedInputError('legacy_storage');

  const deriveFrom = input.deriveFrom ?? null;
  if (deriveFrom !== null) {
    const source = profiles.find((candidate) => candidate.id === deriveFrom);
    if (!source || source.id === profile.id || source.storage !== 'halfvec') throw new ReembedInputError('derive_source_invalid');
    if (source.provider !== profile.provider || canonicalModelId(source.model) !== canonicalModelId(profile.model)) throw new ReembedInputError('derive_model_mismatch');
    if (source.dims <= profile.dims) throw new ReembedInputError('derive_dims_not_smaller');
  }

  const scope = await writer.profileScope(profile.id);
  if (scope !== null && deriveFrom !== null) throw new ReembedInputError('derive_unsupported');
  const counts = await writer.count(profile.id, tenantKey);
  const totals: Record<string, { chunks: number; tokens: number }> = {};
  for (const row of counts) totals[row.tenantKey] = { chunks: row.chunksMissing, tokens: 0 };

  if (deriveFrom === null) {
    const warnings = new Set<string>();
    let after: string | null = null;
    for (;;) {
      signal.throwIfAborted();
      const chunks = await writer.previewBatch(profile.id, tenantKey, after, batchSize);
      if (chunks.length === 0) break;
      for (const chunk of chunks) {
        const entry = (totals[chunk.tenantKey] ??= { chunks: 0, tokens: 0 });
        entry.tokens += countTokens(embeddingTextOf(chunk, warnings));
      }
      after = (chunks[chunks.length - 1] as ReembedChunk).id;
    }
  }

  const cost = estimateReembedCost(profile.provider, totals, profile.model);
  if (deriveFrom !== null) {
    cost.note = 'Derived from stored vectors: no provider call, no provider cost.';
    cost.estimated = false;
  }
  return {
    profileId: profile.id,
    provider: profile.provider,
    model: profile.model,
    dims: profile.dims,
    derived: deriveFrom !== null,
    scope,
    tenants: counts.map((row) => ({ tenantKey: row.tenantKey, chunksTotal: row.chunks, chunksToEmbed: row.chunksMissing, contentChars: row.contentChars })),
    cost,
  };
}

/**
 * Deletes the target-profile rows a run wrote. The database refuses it for the active profile, within 10 minutes of a pointer flip, and for a
 * scoped profile while an active binding covers the run's tenant.
 */
export async function rollbackReembedRun(input: RollbackInput): Promise<{ rowsDeleted: number; profileStatus: string }> {
  const signal = input.signal ?? new AbortController().signal;
  const result = await createReembedWriter({ db: input.db, signal }).rollback(input.runId, input.actor ?? DEFAULT_ACTOR);
  await refreshPointer();
  return result;
}

