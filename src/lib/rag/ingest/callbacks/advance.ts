import type { AdvanceRequest, AdvanceResponse, IngestionJob } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';
import { getActiveProfile } from '../../embeddings/active-profile';
import { backfillDocumentScope } from '../../tenant/backfill-scope';
import { scopeFromIngestionJob } from '../../tenant/ingestion-job';
import { scopeKey } from '../../tenant/scope';
import { isArtifactName, loadArtifact, originalName, saveArtifact, type ArtifactContext } from '../artifacts';
import { loadIngestConfig } from '../config';
import { getIngestDeps } from '../deps';
import { callerDocumentMetadata } from '../document-metadata';
import { enqueueStageContext, queuedInputRecordOf, runEnqueueStages } from '../enqueue';
import { fileSha256 } from '../hash';
import { IngestLedgerError, advanceJob, beginProgressiveFinal, clearProvisional, deferEmbedding, failJob, getJobInternal, markProvisional, publishDeferredJob } from '../ledger';
import { ORIGINALS_BUCKET, assertObjectKey, getObjectStore } from '../object-store';
import { originFields } from '../origin';
import { getProcessingProfile, profileFor, type DocType } from '../profiles/load';
import { finishQueueIngestTrace } from '../queue-trace';
import { uploadScopesEnabled, writeUploadScopes } from '../scopes/upload';
import { readParseResultForJob } from '../parse-cache';
import { QUEUED_INPUT_ARTIFACT, buildQueuedContext, decodeQueuedInput, encodeQueuedInput } from '../queued-context';
import { INGEST_STAGES, REGISTERED_STAGES, rehydrateFromStore, runIngestStages } from '../runner';
import { chunkStage } from '../stages/chunk';
import { deferredEmbedStage } from '../stages/embed-write';
import { versionContentHash } from '../stages/dedup';
import { applyParseResult, stripBom } from '../stages/parse';
import { createLedgerStateStore, saveContextState } from '../state-store';
import { ingestStateFromRecord } from '../status';
import { createIngestWriter } from '../writer';
import { workerHiddenTextReport } from '../../security/hidden-text';
import { INGEST_SOURCES, type ChunkDraft, type IngestInput, type IngestResult, type IngestSource, type StageContext, type StageName, type StageSpec } from '../types';
import { isTerminal, leaseHolds, mapError, refuse, type CallbackResult } from './common';

/** One advance call runs stages for at most this long (D-07); the worker calls again with the cursor it was given. */
export const ADVANCE_SLICE_MS = 40_000;
/** The wait the worker is asked to keep when the stage inputs of a resumed slice are not readable yet. */
const REHYDRATE_RETRY_MS = 1_000;

type Reply = CallbackResult<AdvanceResponse>;

/** `status` is only given with `done`: it is the terminal ledger status. */
function reply(workerId: string, fields: { stage: string; done: boolean; status?: IngestionJob['status']; wait_ms?: number; reason?: string }): Reply {
  return { status: 200, body: { worker_id: workerId, ...fields } as AdvanceResponse };
}

/** The position of a job between calls: the stage whose slice finished last (null before the first slice of the post-parse phase). */
function positionOf(job: IngestionJob): string | null {
  const cursor = (job.stage_state as Record<string, unknown> | undefined)?.cursor;
  return typeof cursor === 'string' && cursor !== '' ? cursor : null;
}

function isStageName(value: string | null): value is StageName {
  return value !== null && (INGEST_STAGES as readonly string[]).includes(value);
}

function pageParserMap(job: IngestionJob): Map<number, string> | null {
  const ranges = job.page_ranges;
  if (!ranges?.length) return null;
  const map = new Map<number, string>();
  for (const range of ranges) {
    const parser = range.parser;
    if (!parser) continue;
    for (let page = range.start; page <= range.end; page += 1) map.set(page, parser);
  }
  return map.size > 0 ? map : null;
}

function parsersOf(job: IngestionJob): string[] {
  const set = new Set<string>();
  for (const range of job.page_ranges ?? []) {
    if (range.parser) set.add(range.parser);
  }
  return [...set].sort();
}

function parserForChunk(chunk: ChunkDraft, map: Map<number, string> | null): string | null {
  if (!map) return null;
  const page = chunk.page_start ?? chunk.page_end;
  if (page === null || page === undefined) return null;
  return map.get(page) ?? null;
}

function annotateChunkParsers(ctx: StageContext, job: IngestionJob): void {
  const map = pageParserMap(job);
  const parsers = parsersOf(job);
  if (parsers.length > 1) {
    ctx.parserUsed = 'mixed';
    const document = ctx.document;
    if (document) {
      void ctx.writer
        .setFields(document.id, {
          parser_used: 'mixed',
          metadata: { parsers },
        })
        .catch(() => undefined);
    }
  } else if (parsers.length === 1) {
    ctx.parserUsed = parsers[0] ?? ctx.parserUsed;
  }
  if (!map) return;
  for (const draft of ctx.work.chunks) {
    const parser = parserForChunk(draft, map);
    if (parser) draft.metadata = { ...draft.metadata, parser_used: parser };
  }
}

/**
 * The stages of one slice. Every call must make progress however small the budget is: the first stage that will run is exempt from
 * the deadline check (the runner yields when the time left is below minMsNeeded, and a spent budget is negative), so a 1 ms budget
 * still moves the job one stage instead of yielding for ever.
 */
function sliceStages(last: StageName | null, job: IngestionJob, deferred = false): StageSpec[] {
  const firstToRun = last === null ? 0 : INGEST_STAGES.indexOf(last) + 1;
  return REGISTERED_STAGES.map((registered, index) => {
    const stage = deferred ? (DEFERRED_STAGES.get(registered.name) ?? registered) : registered;
    const spec = index === firstToRun ? { ...stage, minMsNeeded: Number.NEGATIVE_INFINITY } : stage;
    if (stage.name !== 'chunk') return spec;
    return {
      ...spec,
      async run(ctx: StageContext) {
        const outcome = await chunkStage.run(ctx);
        if (outcome.kind === 'next') annotateChunkParsers(ctx, job);
        return outcome;
      },
    };
  });
}

/** The stage a Batch API backfill job stops at: chunks written without vectors, not published, lease released (D-35). */
export const EMBED_DEFERRED_STAGE = 'embed_deferred';

/** In batch_api mode publish does not run in advance; the rag:backfill process publishes once the vectors are written. */
const deferredPublishStage: StageSpec = {
  name: 'publish',
  minMsNeeded: 0,
  async run() {
    return { kind: 'yield', reason: EMBED_DEFERRED_STAGE };
  },
};

const DEFERRED_STAGES: ReadonlyMap<StageName, StageSpec> = new Map([
  ['embed', deferredEmbedStage],
  ['publish', deferredPublishStage],
]);

/**
 * D-35: only a backfill ingest job whose snapshot says batch_api, and only while the active profile is an OpenAI one, defers its
 * embeddings. Incremental jobs, sync snapshots and other providers embed in the Phase 3 order; a registry that cannot be read means sync.
 */
async function defersEmbedding(job: IngestionJob): Promise<boolean> {
  if (job.kind !== 'ingest' || !job.batch_id || job.settings.embed_mode !== 'batch_api') return false;
  try {
    return (await getActiveProfile()).provider === 'openai';
  } catch {
    return false;
  }
}

type TerminalStatus = 'ready' | 'quarantined' | 'skipped_duplicate' | 'pending_review';

function terminalStatusOf(result: IngestResult): TerminalStatus | null {
  if (result.status === 'ready' || result.status === 'quarantined' || result.status === 'skipped_duplicate' || result.status === 'pending_review') {
    return result.status;
  }
  return null;
}

/**
 * The decisions a queued job carries in its snapshot, laid over the run state: the approval made at enqueue (D-56; not the current
 * mode, so a later change of RAG_UPLOAD_APPROVAL does not re-decide a job) and the batch publish hold (D-12).
 */
export function applySnapshotDecisions(ctx: StageContext, job: IngestionJob): void {
  const approval = job.settings.approval ?? null;
  if (approval) ctx.state.approval = approval;
  else delete ctx.state.approval;
  if (job.settings.hold_publish === true && job.batch_id) ctx.state.publishHold = { batchId: job.batch_id };
  else delete ctx.state.publishHold;
}

/**
 * The hidden-text report the worker made at preflight (D-33), handed to scan_injection so it makes no sidecar call. It is used only while
 * the check is on and only for this job's original; a report that fails validation is kept as null, which the stage treats as a checker
 * that could not answer.
 */
export function applyWorkerHiddenText(ctx: StageContext, job: IngestionJob, raw: unknown): void {
  if (raw === undefined || raw === null || ctx.config.hiddenTextCheck === 'off' || !job.file_sha256) return;
  ctx.workerHiddenText = workerHiddenTextReport(raw, job.file_sha256);
}

function parseHasText(ctx: StageContext): boolean {
  return (ctx.work.parseText?.trim().length ?? 0) > 0 || ctx.work.chunks.length > 0 || ctx.work.captionOnly === true;
}

async function finish(
  job: IngestionJob,
  jobId: string,
  workerId: string,
  ctx: StageContext,
  scope: Awaited<ReturnType<typeof scopeFromIngestionJob>>,
  status: TerminalStatus,
  signal: AbortSignal,
): Promise<Reply> {
  const fields: Record<string, unknown> = {};
  if (status !== 'skipped_duplicate') {
    const parsers = parsersOf(job);
    if (parsers.length > 1) fields.parser_used = 'mixed';
    else if (ctx.parserUsed) fields.parser_used = ctx.parserUsed;
    if (ctx.work.parserVersion) fields.parser_version = ctx.work.parserVersion;
  }
  const ledgerStatus = job.needs_review_reason && status === 'ready' ? 'needs_review' : status;
  if (ledgerStatus === 'needs_review' && job.needs_review_reason) {
    fields.needs_review_reason = job.needs_review_reason;
  }
  const updated = await advanceJob(
    { jobId, worker: workerId, stage: ledgerStatus, status: ledgerStatus, stageState: { ...ctx.state, cursor: ctx.state.lastCompleted }, fields },
    { signal },
  );
  if (scope) finishQueueIngestTrace({ scope, job: updated, status: ledgerStatus });
  return reply(workerId, { stage: ledgerStatus, done: true, status: ledgerStatus });
}

/** Records the write stage's state and parser fields, then parks the job at embed_deferred with its lease released. */
async function parkDeferred(job: IngestionJob, jobId: string, workerId: string, ctx: StageContext, signal: AbortSignal): Promise<Reply> {
  const fields: Record<string, unknown> = {};
  const parsers = parsersOf(job);
  if (parsers.length > 1) fields.parser_used = 'mixed';
  else if (ctx.parserUsed) fields.parser_used = ctx.parserUsed;
  if (ctx.work.parserVersion) fields.parser_version = ctx.work.parserVersion;
  await advanceJob(
    { jobId, worker: workerId, stage: 'write', status: 'embedding', stageState: { ...ctx.state, cursor: ctx.state.lastCompleted }, fields },
    { signal },
  );
  await deferEmbedding(jobId, workerId, { signal });
  return reply(workerId, { stage: EMBED_DEFERRED_STAGE, done: true });
}

async function finishNeedsReviewEmpty(
  job: IngestionJob,
  jobId: string,
  workerId: string,
  ctx: StageContext,
  scope: NonNullable<Awaited<ReturnType<typeof scopeFromIngestionJob>>>,
  signal: AbortSignal,
): Promise<Reply> {
  const documentId = ctx.document?.id ?? job.document_id ?? '';
  const updated = await advanceJob(
    {
      jobId,
      worker: workerId,
      stage: 'needs_review',
      status: 'needs_review',
      stageState: { ...ctx.state, cursor: ctx.state.lastCompleted },
      fields: { needs_review_reason: job.needs_review_reason ?? 'empty_text' },
    },
    { signal },
  );
  if (documentId) await ctx.writer.markFailed(documentId, 'needs_review_empty').catch(() => undefined);
  finishQueueIngestTrace({ scope, job: updated, status: 'needs_review' });
  return reply(workerId, { stage: 'needs_review', done: true, status: 'needs_review', reason: job.needs_review_reason ?? undefined });
}

/** The answer to a provisional run that published its version: done for this run, and the job stays open for the routed run (D-30). */
const PROVISIONAL_STAGE = 'provisional';

/** Progressive mode is for incremental ingest jobs whose snapshot has it on; a backfill job never runs it (D-30). */
function provisionalAllowed(job: IngestionJob): boolean {
  return job.kind === 'ingest' && (job.batch_id ?? null) === null && job.settings.progressive === true;
}

async function completeProvisional(jobId: string, workerId: string, signal: AbortSignal): Promise<Reply> {
  await markProvisional(jobId, workerId, { signal });
  return reply(workerId, { stage: PROVISIONAL_STAGE, done: true });
}

type Scope = NonNullable<Awaited<ReturnType<typeof scopeFromIngestionJob>>>;
type FinalStart = { kind: 'continue'; job: IngestionJob } | { kind: 'reply'; reply: Reply };

function profileOf(source: Parameters<typeof profileFor>[0], docType: string): ReturnType<typeof profileFor> {
  try {
    return profileFor(source, docType as DocType);
  } catch {
    return getProcessingProfile('general');
  }
}

/**
 * The first call of the routed run of a progressive job, while the job still points at its provisional version. A routed text with the
 * same normalised content as a current version of the same lineage is unchanged (A-9, F-10): the flags are cleared in place and the
 * job ends without a new version. Otherwise the next version of the lineage is begun (the original and the queued input are copied
 * to its prefix) and the job is pointed at it, so the routed result is published through the Phase 3 swap (D-11).
 */
async function startProgressiveFinal(
  job: IngestionJob,
  workerId: string,
  cacheId: string,
  scope: Scope,
  db: RpcClient,
  signal: AbortSignal,
): Promise<FinalStart> {
  const writer = createIngestWriter({ db, scope, signal });
  const documentId = job.document_id;
  const row = documentId ? await writer.getDocument(documentId) : null;
  if (!documentId || !row || row.status !== 'ready') return { kind: 'continue', job };
  const origin = await writer.getOrigin(documentId);
  if (!origin?.lineageId) return { kind: 'reply', reply: refuse(404, 'lineage_missing') };
  const lineageId = origin.lineageId;

  const tenantKey = scopeKey(scope).toLowerCase();
  const from: ArtifactContext = { identity: { tenantKey }, document: { lineageId, version: row.version }, signal, state: { artifacts: {} } };
  const stored = await loadArtifact(from, QUEUED_INPUT_ARTIFACT);
  const record = stored ? decodeQueuedInput(stored.bytes) : null;
  if (!record) return { kind: 'reply', reply: refuse(404, 'queued_input_missing') };

  const cached = await readParseResultForJob(job, cacheId, signal);
  const profile = profileOf(record.source, row.docType);
  const hash = versionContentHash(profile.chunker.kind, job.file_sha256 ?? '', stripBom(cached.result.markdown));
  const duplicateOf = await writer.findContentDuplicate(hash, null);
  const sameLineage =
    duplicateOf !== null && (duplicateOf === documentId || (await writer.getOrigin(duplicateOf))?.lineageId === lineageId);
  if (sameLineage) {
    await clearProvisional(job.id, { signal });
    const ledgerStatus = job.needs_review_reason ? 'needs_review' : 'ready';
    const updated = await advanceJob(
      {
        jobId: job.id,
        worker: workerId,
        stage: ledgerStatus,
        status: ledgerStatus,
        ...(job.needs_review_reason ? { fields: { needs_review_reason: job.needs_review_reason } } : {}),
      },
      { signal },
    );
    finishQueueIngestTrace({ scope, job: updated, status: ledgerStatus });
    return { kind: 'reply', reply: reply(workerId, { stage: ledgerStatus, done: true, status: ledgerStatus }) };
  }

  // The job scope of an organization tenant has no user, and a multi-tenant version needs an owner: the same rule as a backfill begin.
  const documentScope = await backfillDocumentScope(scope, { signal });
  if (!documentScope) return { kind: 'reply', reply: await failBegin(job, workerId, 'organization_owner_missing', scope, signal) };
  const versionWriter = documentScope === scope ? writer : createIngestWriter({ db, scope: documentScope, signal });
  const state = ingestStateFromRecord({ ...record.state, typeChange: record.typeChange });
  const begun = await versionWriter.begin({
    source: record.source,
    sourceKey: record.sourceKey,
    filename: row.filename,
    fileSha256: job.file_sha256 ?? null,
    docType: row.docType,
    docTypeOrigin: state.docTypeOrigin ?? 'fallback',
    profileId: job.settings.profile_id,
    profileVersion: job.settings.profile_version,
    forceNewVersion: true,
  });
  if (begun.outcome === 'skipped_duplicate' || begun.lineageId !== lineageId) {
    return { kind: 'reply', reply: refuse(409, 'version_not_started') };
  }
  const to: ArtifactContext = { identity: { tenantKey }, document: { lineageId, version: begun.version }, signal, state: { artifacts: {} } };
  const artifacts: Record<string, string> = {};
  if (origin.originalPath) {
    const original = await getObjectStore().get(origin.originalPath, { signal });
    if (!original) return { kind: 'reply', reply: refuse(404, 'original_unavailable') };
    const basename = origin.originalPath.slice(origin.originalPath.lastIndexOf('/') + 1);
    const name = isArtifactName(basename) ? basename : originalName(row.filename);
    artifacts[name] = await saveArtifact(to, name, original.bytes, record.mimeType);
    await writer.setFields(begun.documentId, { original_path: artifacts[name] });
  }
  const callerMetadata = callerDocumentMetadata(record.options);
  if (callerMetadata) await writer.setFields(begun.documentId, { metadata: callerMetadata });
  const originValues = originFields(record.options);
  if (originValues !== null) await writer.setFields(begun.documentId, originValues);
  // D-40: the final version carries the upload's tags before its chunks are written, as the first version did.
  if (record.scopes && record.scopes.length > 0 && uploadScopesEnabled(loadIngestConfig(getIngestDeps().ingestEnv()))) {
    await writeUploadScopes(db, tenantKey, begun.documentId, record.scopes, signal);
  }
  await saveArtifact(to, QUEUED_INPUT_ARTIFACT, encodeQueuedInput({ ...record, state: { ...record.state, artifacts } }), 'application/json');
  return { kind: 'continue', job: await beginProgressiveFinal(job.id, workerId, begun.documentId, { signal }) };
}

function emitFailureTrace(
  job: IngestionJob,
  scope: Awaited<ReturnType<typeof scopeFromIngestionJob>>,
  reason: string,
): void {
  if (!scope) return;
  finishQueueIngestTrace({ scope, job, status: 'failed', errorClass: reason });
}

/** The ledger stage a backfill job is at once begin has given it its document: parsing proceeds from preflight. */
const BEGIN_STAGE = 'preflight';

/** The staged original of a backfill job: in the private bucket, under the job tenant's own prefix, or nothing (T-03.1-103). */
function stagedOriginalPath(job: IngestionJob, tenantKey: string): string | null {
  const ref = job.original_ref;
  if (!ref || ref.bucket !== ORIGINALS_BUCKET || !ref.path.startsWith(`${tenantKey}/`)) return null;
  try {
    assertObjectKey(ref.path);
  } catch {
    return null;
  }
  return ref.path;
}

function isIngestSource(value: string): value is IngestSource {
  return (INGEST_SOURCES as readonly string[]).includes(value);
}

function baseName(sourceKey: string): string {
  return sourceKey.slice(sourceKey.lastIndexOf('/') + 1) || sourceKey;
}

async function failBegin(job: IngestionJob, workerId: string, reason: string, scope: Scope, signal: AbortSignal): Promise<Reply> {
  const failed = await failJob(job.id, workerId, reason, false, { signal });
  emitFailureTrace(failed, scope, reason);
  return reply(workerId, { stage: 'failed', done: true, status: 'failed', reason });
}

/**
 * Phase begin (D-31): a backfill job is enqueued without a document row, so a batch that is never run leaves nothing in processing.
 * At its first claim the worker calls begin, which runs identify, file_hash_dedup and store_original for the job tenant from the
 * staged original, the job's filename and MIME type and the doc type of its snapshot, exactly as enqueueIngest does at upload,
 * then stores the queued-input record and records the document id on the job. A file the tenant already has ends the job
 * skipped_duplicate here, before any parse. A repeated call is safe: the version is resumed, and a job with a document answers at once.
 */
async function beginBackfillDocument(job: IngestionJob, workerId: string, scope: Scope, db: RpcClient, signal: AbortSignal): Promise<Reply> {
  if (job.kind !== 'ingest' || !job.batch_id) return refuse(409, 'begin_not_allowed');
  if (job.document_id) return reply(workerId, { stage: job.stage ?? BEGIN_STAGE, done: false });

  const path = stagedOriginalPath(job, scopeKey(scope).toLowerCase());
  const original = path ? await getObjectStore().get(path, { signal }) : null;
  if (!original) return failBegin(job, workerId, 'original_unavailable', scope, signal);
  if (!job.file_sha256 || fileSha256(original.bytes) !== job.file_sha256) return failBegin(job, workerId, 'original_changed', scope, signal);
  if (!isIngestSource(job.source)) return failBegin(job, workerId, 'invalid_source', scope, signal);
  const documentScope = await backfillDocumentScope(scope, { signal });
  if (!documentScope) return failBegin(job, workerId, 'organization_owner_missing', scope, signal);

  const input: IngestInput = {
    scope: documentScope,
    source: job.source,
    sourceKey: job.source_key,
    filename: job.filename ?? baseName(job.source_key),
    mimeType: job.mime_type ?? 'application/octet-stream',
    docType: job.settings.doc_type,
    file: original.bytes,
    signal,
  };
  const ctx = enqueueStageContext(input, getIngestDeps(), db);
  const result = await runEnqueueStages(ctx);
  if (result.status === 'skipped_duplicate') {
    const updated = await advanceJob({ jobId: job.id, worker: workerId, stage: 'skipped_duplicate', status: 'skipped_duplicate' }, { signal });
    finishQueueIngestTrace({ scope, job: updated, status: 'skipped_duplicate' });
    return reply(workerId, { stage: 'skipped_duplicate', done: true, status: 'skipped_duplicate' });
  }
  const document = ctx.document;
  if (result.status === 'failed' || !document) {
    const reason = result.reason ?? 'begin_failed';
    if (document) await ctx.writer.markFailed(document.id, reason).catch(() => undefined);
    return failBegin(job, workerId, reason, scope, signal);
  }
  await saveArtifact(ctx, QUEUED_INPUT_ARTIFACT, encodeQueuedInput(queuedInputRecordOf(input, ctx)), 'application/json');
  await advanceJob({ jobId: job.id, worker: workerId, stage: BEGIN_STAGE, status: BEGIN_STAGE, fields: { document_id: document.id } }, { signal });
  return reply(workerId, { stage: BEGIN_STAGE, done: false });
}

/**
 * The advance callback. Phase begin gives a backfill job its document row (above); phase post_parse reads the cached parse result (checked against the job's tenant in SQL), runs the
 * post-parse stages with the ledger as the state store inside one slice, and answers where the job stands. A call is idempotent per
 * (job, stage, cursor): a cursor that is not the job's position is a replay and changes nothing, and writes are the Phase 3
 * deterministic-id upserts with the final trim, so a repeated stage yields the same rows (D-25, F-4).
 */
/** The advance body; `provisional` defaults to false when the caller leaves it out, as the request schema does. */
export type AdvanceBody = Omit<AdvanceRequest, 'provisional'> & { provisional?: boolean };

export async function handleAdvance(jobId: string, body: AdvanceBody, options: { signal: AbortSignal }): Promise<Reply> {
  const { signal } = options;
  const deps = getIngestDeps();
  try {
    let job = await getJobInternal(jobId, { signal });
    if (!job) return refuse(404, 'job_not_found');
    if (isTerminal(job)) {
      return reply(body.worker_id, { stage: job.status, done: true, status: job.status, ...(job.error_class ? { reason: job.error_class } : {}) });
    }
    if (!leaseHolds(job, body.worker_id, deps.now())) return refuse(409, 'lease_lost');
    if (body.phase === 'begin' && body.provisional !== true) {
      const scope = await scopeFromIngestionJob(jobId, { db: deps.db, signal });
      if (!scope) return refuse(404, 'job_not_found');
      const db = deps.db();
      if (!db) return refuse(500, 'db_unavailable');
      return await beginBackfillDocument(job, body.worker_id, scope, db, signal);
    }
    if (body.phase !== 'post_parse' || !body.parse_cache_id) return refuse(400, 'phase_not_supported');
    const provisionalRun = body.provisional === true;
    if (provisionalRun) {
      // A repeated call after the provisional version was published answers the same way; the routed run starts from parse.
      if (job.provisional_published_at) return reply(body.worker_id, { stage: PROVISIONAL_STAGE, done: true });
      if (!provisionalAllowed(job)) return refuse(409, 'provisional_not_allowed');
    }

    const position = positionOf(job);
    if ((body.cursor ?? null) !== position) {
      return reply(body.worker_id, { stage: position ?? 'parse', done: false, wait_ms: 0 });
    }

    const scope = await scopeFromIngestionJob(jobId, { db: deps.db, signal });
    if (!scope) return refuse(404, 'job_not_found');
    const db = deps.db();
    if (!db) return refuse(500, 'db_unavailable');

    // A slice that published but could not write the terminal state is closed here from the version's own status.
    if (position === 'publish') {
      const row = job.document_id ? await createIngestWriter({ db, scope, signal }).getDocument(job.document_id) : null;
      if (provisionalRun && row?.status === 'ready') return await completeProvisional(jobId, body.worker_id, signal);
      const batchHeld = row?.status === 'processing' && job.settings.hold_publish === true && Boolean(job.batch_id);
      if (row && (row.status === 'ready' || row.status === 'quarantined' || row.status === 'pending_review' || batchHeld)) {
        const settled = batchHeld ? 'ready' : (row.status as 'ready' | 'quarantined' | 'pending_review');
        const ledgerStatus = job.needs_review_reason && settled !== 'pending_review' ? 'needs_review' : settled;
        await advanceJob({
          jobId,
          worker: body.worker_id,
          stage: ledgerStatus,
          status: ledgerStatus,
          ...(job.needs_review_reason ? { fields: { needs_review_reason: job.needs_review_reason } } : {}),
        }, { signal });
        finishQueueIngestTrace({ scope, job: { ...job, status: ledgerStatus }, status: ledgerStatus });
        return reply(body.worker_id, { stage: ledgerStatus, done: true, status: ledgerStatus });
      }
    }

    if (position === null && !provisionalRun && job.provisional_published_at) {
      const started = await startProgressiveFinal(job, body.worker_id, body.parse_cache_id, scope, db, signal);
      if (started.kind === 'reply') return started.reply;
      job = started.job;
    }

    const built = await buildQueuedContext({
      job,
      scope,
      signal,
      deadlineMs: Math.min(ADVANCE_SLICE_MS, body.deadline_ms),
      withOriginal: false,
      store: createLedgerStateStore({ jobId, worker: body.worker_id, signal, now: deps.now }),
    });
    if (!built.ok) return refuse(built.reason === 'document_not_processing' ? 409 : 404, built.reason);
    const { ctx } = built;
    applySnapshotDecisions(ctx, job);
    applyWorkerHiddenText(ctx, job, body.hidden_text_report);

    if (position === null) {
      const cached = await readParseResultForJob(job, body.parse_cache_id, signal);
      await applyParseResult(ctx, { result: cached.result, artifacts: cached.artifacts, warnings: [] });
      ctx.state.parseJob = null;
      ctx.state.lastCompleted = 'parse';
      await saveContextState(ctx, 'processing');
    } else {
      if (!isStageName(position)) return refuse(409, 'cursor_invalid');
      ctx.state.lastCompleted = position;
      const rebuilt = await rehydrateFromStore(ctx);
      if (rebuilt === false) {
        console.warn('[RAG Ingest] advance could not rebuild the stage inputs', { stage: position });
        return reply(body.worker_id, { stage: position, done: false, wait_ms: REHYDRATE_RETRY_MS });
      }
      if (typeof rebuilt === 'object') {
        await ctx.writer.markFailed(ctx.document?.id ?? '', rebuilt.failed).catch((error: unknown) => {
          console.error('[RAG Ingest] could not mark the version failed', { error: error instanceof Error ? error.name : 'unknown' });
        });
        const failed = await failJob(jobId, body.worker_id, rebuilt.failed, false, { signal });
        emitFailureTrace(failed, scope, rebuilt.failed);
        return reply(body.worker_id, { stage: 'failed', done: true, status: 'failed', reason: rebuilt.failed });
      }
    }

    if (job.needs_review_reason && !parseHasText(ctx)) {
      return await finishNeedsReviewEmpty(job, jobId, body.worker_id, ctx, scope, signal);
    }

    const deferred = !provisionalRun && (await defersEmbedding(job));
    const result = await runIngestStages(ctx, sliceStages(ctx.state.lastCompleted, job, deferred));
    if (deferred && result.status === 'processing' && result.reason === EMBED_DEFERRED_STAGE) {
      return await parkDeferred(job, jobId, body.worker_id, ctx, signal);
    }
    const terminal = terminalStatusOf(result);
    if (terminal === 'ready' && provisionalRun) return await completeProvisional(jobId, body.worker_id, signal);
    if (terminal) return await finish(job, jobId, body.worker_id, ctx, scope, terminal, signal);
    if (result.status === 'failed') {
      const reason = result.reason ?? 'stage_failed';
      const failed = await failJob(jobId, body.worker_id, reason, false, { signal });
      emitFailureTrace(failed, scope, reason);
      return reply(body.worker_id, { stage: 'failed', done: true, status: 'failed', reason });
    }
    return reply(body.worker_id, { stage: ctx.state.lastCompleted ?? 'parse', done: false, wait_ms: 0 });
  } catch (error) {
    return mapError('advance', error);
  }
}
export type DeferredPublishOutcome =
  | { kind: 'published'; status: 'ready' | 'quarantined' | 'needs_review' }
  | { kind: 'refused'; reason: string };

/**
 * Phase publish of a deferred job (D-35), called by the rag:backfill process once the Batch API vectors are written: the database checks
 * that every chunk has its active-profile vector (rag_vectors_complete) and swaps the version in, all in one transaction. A version with a
 * missing vector is refused (vectors_incomplete), the job stays at embed_deferred and the previous version stays current.
 */
export async function publishDeferred(jobId: string, options: { signal: AbortSignal }): Promise<DeferredPublishOutcome> {
  const { signal } = options;
  const active = await getActiveProfile();
  let job: IngestionJob;
  try {
    job = await publishDeferredJob(jobId, active.id, { signal });
  } catch (error) {
    if (error instanceof IngestLedgerError && error.code) return { kind: 'refused', reason: error.reason ?? error.code };
    throw error;
  }
  const status = job.status;
  if (status !== 'ready' && status !== 'quarantined' && status !== 'needs_review') return { kind: 'refused', reason: 'not_published' };
  const scope = await scopeFromIngestionJob(jobId, { db: getIngestDeps().db, signal }).catch(() => null);
  if (scope) finishQueueIngestTrace({ scope, job, status });
  return { kind: 'published', status };
}
