import type { RpcClient } from '../backend/supabase-rpc';
import { getActiveProfile } from '../embeddings/active-profile';
import { originalName, saveArtifact } from './artifacts';
import { loadIngestConfig } from './config';
import { getIngestDeps, type IngestDeps } from './deps';
import { blockedIngestResult, ingest } from './index';
import { enqueueJob } from './ledger';
import { ORIGINALS_BUCKET } from './object-store';
import { QUEUED_INPUT_ARTIFACT, encodeQueuedInput, type QueuedInputRecord } from './queued-context';
import { queueConfigFromProcessEnv, type QueueConfig } from './queue-config';
import { loadRoutingConfig } from './routing/config';
import { ingestLanguageSettings } from './routing/effective-settings';
import { buildJobSettings } from './routing/settings-snapshot';
import { effectiveTierBounds } from './routing/tier-bounds';
import { runIngestStages } from './runner';
import { fileHashDedupStage } from './stages/dedup';
import { identifyStage } from './stages/identify';
import { storeOriginalStage } from './stages/store-original';
import { nullStateStore } from './state-store';
import { DEFAULT_INGEST_DEADLINE_MS, emptyIngestState, type IngestInput, type IngestResult, type StageContext } from './types';
import { createIngestWriter } from './writer';

export interface EnqueueResult {
  jobId: string | null;
  documentId: string | null;
  status: 'queued' | 'skipped_duplicate' | 'failed';
  reason?: string;
}

export interface EnqueueIngestOptions {
  /** Defaults to 100, the incremental upload priority (D-23). */
  priority?: number;
  batchId?: string | null;
  /** The batch publishes its versions only at activation (ingestion_batches.hold_publish, D-12); needs batchId. */
  holdPublish?: boolean;
  /** The queue switches the job snapshot is built from. Defaults to the process environment. */
  queueConfig?: () => QueueConfig;
}

function failedResult(documentId: string | null, reason: string): EnqueueResult {
  return { jobId: null, documentId, status: 'failed', reason };
}

/** The queued-input record of a run whose identify, file_hash_dedup and store_original stages are done. */
export function queuedInputRecordOf(input: IngestInput, ctx: StageContext): QueuedInputRecord {
  return {
    v: 1,
    source: input.source,
    sourceKey: input.sourceKey,
    filename: input.filename,
    mimeType: input.mimeType,
    kind: input.text !== undefined ? 'text' : 'file',
    ...(input.docType ? { docType: input.docType } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.typeChange !== undefined ? { typeChange: input.typeChange } : {}),
    // What the earlier stages decided and the ledger has no column for; the position (lastCompleted) is the ledger's own.
    state: {
      docTypeOrigin: ctx.state.docTypeOrigin,
      docTypeDetection: ctx.state.docTypeDetection,
      images: ctx.state.images,
      artifacts: { ...ctx.state.artifacts },
    },
  };
}

/** The stage context of the enqueue-time stages (no state store: the ledger is the state authority of a queued job). */
export function enqueueStageContext(input: IngestInput, deps: IngestDeps, db: RpcClient): StageContext {
  const ctx: StageContext = {
    input,
    deps,
    writer: createIngestWriter({ db, scope: input.scope, signal: input.signal }),
    config: loadIngestConfig(deps.ingestEnv()),
    signal: input.signal,
    deadline: deps.now() + (input.deadlineMs ?? DEFAULT_INGEST_DEADLINE_MS),
    state: emptyIngestState(),
    store: nullStateStore,
    warnings: [],
    identity: null,
    document: null,
    parserUsed: null,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  };
  if (input.typeChange) ctx.state.typeChange = { ...input.typeChange };
  return ctx;
}

/** identify, file_hash_dedup and store_original: the processing version and its stored original, or the duplicate it would be. */
export async function runEnqueueStages(ctx: StageContext): Promise<IngestResult> {
  return runIngestStages(ctx, [identifyStage, fileHashDedupStage, storeOriginalStage], { partial: true });
}

/** The embedding provider a backfill snapshot is built for; a registry that cannot be read never selects the OpenAI Batch API. */
export async function backfillEmbedProvider(): Promise<string> {
  try {
    return (await getActiveProfile()).provider;
  } catch {
    console.warn('[Ingest] active embedding profile unavailable; backfill embeds in sync');
    return 'unknown';
  }
}

/**
 * The queued counterpart of ingest() (D-22): runs identify, file_hash_dedup and store_original in the app, which leaves the not-current
 * processing version and the stored original, then inserts the ledger row with the settings snapshot and returns at once. An unchanged
 * file returns skipped_duplicate with the existing document and a terminal ledger row. These stages write nothing to
 * documents.processing_state: from here on the ledger is the only state authority of the job (D-01, A-1).
 */
export async function enqueueIngest(input: IngestInput, options: EnqueueIngestOptions = {}): Promise<EnqueueResult> {
  const deps = getIngestDeps();
  const db = deps.db();
  if (!db) {
    console.error('[Ingest] admin client unavailable');
    return failedResult(null, 'db_unavailable');
  }
  const ctx = enqueueStageContext(input, deps, db);
  const result = await runEnqueueStages(ctx);
  if (result.status === 'failed') return failedResult(result.documentId, result.reason ?? 'enqueue_failed');
  const identity = ctx.identity;
  if (!identity) return failedResult(null, 'identity_missing');

  const abandon = async (reason: string, error: unknown): Promise<EnqueueResult> => {
    console.error('[Ingest] enqueue failed', { reason, error: error instanceof Error ? error.name : 'unknown' });
    if (ctx.document) await ctx.writer.markFailed(ctx.document.id, reason).catch(() => undefined);
    return failedResult(ctx.document?.id ?? null, reason);
  };

  try {
    const queueConfig = (options.queueConfig ?? queueConfigFromProcessEnv)();
    // A job of a backfill batch gets the backfill snapshot: never progressive, Batch API embeddings only when asked for (D-30, D-35).
    const isBackfill = options.batchId !== undefined && options.batchId !== null;
    const settings = buildJobSettings({
      queueConfig,
      profile: identity.profile,
      bounds: await effectiveTierBounds(identity.docType),
      routingConfig: loadRoutingConfig(),
      isBackfill,
      ...(isBackfill ? { embedProfileProvider: await backfillEmbedProvider() } : {}),
      approval: ctx.state.approval ?? null,
      ...(isBackfill && options.holdPublish === true ? { holdPublish: true } : {}),
      // Frozen at enqueue: a later change of the variables reaches neither this job's requests nor its parse-cache key (D-17).
      ingestConfig: ctx.config,
      languageSettings: ingestLanguageSettings(ctx.config),
      hiddenTextCheck: ctx.config.hiddenTextCheck,
    });
    const base = {
      source: input.source,
      sourceKey: input.sourceKey,
      fileSha256: identity.fileSha256,
      filename: identity.filename,
      mimeType: input.mimeType,
      settings,
      priority: options.priority ?? 100,
      ...(options.batchId !== undefined ? { batchId: options.batchId } : {}),
    };

    if (result.status === 'skipped_duplicate' && result.duplicateOf) {
      const job = await enqueueJob(input.scope, { ...base, documentId: result.duplicateOf, status: 'skipped_duplicate' }, { signal: input.signal });
      return { jobId: job.id, documentId: result.duplicateOf, status: 'skipped_duplicate' };
    }

    const document = ctx.document;
    const originalKey = ctx.state.artifacts[originalName(identity.filename)];
    if (!document || !originalKey) return await abandon('original_unavailable', null);
    await saveArtifact(ctx, QUEUED_INPUT_ARTIFACT, encodeQueuedInput(queuedInputRecordOf(input, ctx)), 'application/json');
    const job = await enqueueJob(
      input.scope,
      { ...base, originalRef: { bucket: ORIGINALS_BUCKET, path: originalKey }, documentId: document.id },
      { signal: input.signal },
    );
    return { jobId: job.id, documentId: document.id, status: 'queued' };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return await abandon('enqueue_failed', error);
  }
}

/** The switch of the write paths (D-22): the inline pipeline with RAG_INGEST_ASYNC off, the queue with it on. */
export async function submitIngest(input: IngestInput, options: EnqueueIngestOptions = {}): Promise<IngestResult | EnqueueResult> {
  const blocked = loadIngestConfig(getIngestDeps().ingestEnv()).pipelineBlocked;
  if (blocked) return blockedIngestResult(blocked);
  const config = (options.queueConfig ?? queueConfigFromProcessEnv)();
  return config.ingestAsync ? enqueueIngest(input, options) : ingest(input);
}
