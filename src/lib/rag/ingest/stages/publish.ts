import { redisvlInvalidationTarget } from '../../cache/emit';
import { clusterPublishedDocument, dupClustersEnabled } from '../../dedupe/cluster';
import { scheduleAfterResponse } from '../../trace/schedule';
import { scopeKey } from '../../tenant/scope';
import { buildIngestFingerprint, collectFingerprintParts } from '../fingerprint';
import { afterPublish } from '../post-publish';
import { requireDocument, type IngestResult, type IngestStatus, type StageContext, type StageOutcome, type StageSpec } from '../types';
import { recordReplacesIntent } from '../versions/admin';
import { IngestWriterError } from '../writer';

function result(ctx: StageContext, status: IngestStatus, documentId: string, version: number, reason?: string): StageOutcome {
  const done: IngestResult = {
    status,
    documentId,
    version,
    parserUsed: ctx.parserUsed,
    chunkCount: ctx.work.chunksWritten,
    warnings: ctx.warnings.slice(),
    ...(reason !== undefined ? { reason } : {}),
  };
  return { kind: 'done', result: done };
}

function quarantinedByScan(ctx: StageContext): boolean {
  return ctx.state.quarantine !== null && ctx.state.quarantine.released !== true;
}

/**
 * D-36: a version whose upload needs approval is fully written, then moved to pending_review with its chunks; it is never made
 * current here. A repeated publish of an already held version (a resumed run) reads the row instead of holding it twice.
 */
async function holdForReview(ctx: StageContext, documentId: string, version: number): Promise<StageOutcome> {
  try {
    const held = await ctx.writer.holdForReview(documentId);
    return result(ctx, 'pending_review', held.documentId, held.version || version);
  } catch (error) {
    if (!(error instanceof IngestWriterError) || error.reason !== 'not_holdable') throw error;
    const row = await ctx.writer.getDocument(documentId);
    if (row?.status === 'pending_review') return result(ctx, 'pending_review', documentId, row.version);
    if (row?.status === 'quarantined') return result(ctx, 'quarantined', documentId, row.version);
    throw error;
  }
}

/** D-10: the version records how it was ingested before it is published or held; the same builder serves inline and queued runs. */
async function writeFingerprint(ctx: StageContext, documentId: string): Promise<void> {
  const parts = collectFingerprintParts(ctx);
  await ctx.writer.setFields(documentId, { ingest_fingerprint: buildIngestFingerprint(parts), metadata: { ingest_fingerprint_parts: parts } });
}

/**
 * D-19: duplicate clustering is a non-fatal sub-step of publish, not a stage. It runs only for a version that became current; a failure
 * is logged with the error name and repaired by `npm run rag:dup-clusters`.
 */
async function clusterAfterPublish(ctx: StageContext, documentId: string): Promise<void> {
  try {
    if (!(await dupClustersEnabled())) return;
    await clusterPublishedDocument(ctx.input.scope, documentId, { signal: ctx.input.signal });
  } catch (error) {
    if (ctx.input.signal.aborted) throw error;
    console.warn('[Ingest] Duplicate clustering failed; the document is published', { error: error instanceof Error ? error.name : 'unknown' });
  }
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'publish');
  await writeFingerprint(ctx, document.id);
  await recordReplacesIntent(ctx, document.id);
  if (ctx.state.approval?.required === true && !quarantinedByScan(ctx)) return holdForReview(ctx, document.id, document.version);

  const batchHold = ctx.state.publishHold;
  if (batchHold) await ctx.writer.setFields(document.id, { metadata: { publish_hold: { batch_id: batchHold.batchId } } });

  const published = await ctx.writer.publish(document.id);
  const cache = redisvlInvalidationTarget();
  if (cache) {
    const scope = ctx.input.scope;
    const documentIds = [published.documentId, published.supersededDocumentId].filter((id): id is string => typeof id === 'string');
    scheduleAfterResponse(async () => {
      await cache.invalidateTenant(scope, documentIds);
    });
  }
  switch (published.outcome) {
    case 'quarantined':
      return result(ctx, 'quarantined', published.documentId, published.version);
    case 'pending_review':
      return result(ctx, 'pending_review', published.documentId, published.version);
    case 'held':
      // D-12: the batch's hold keeps the version out of retrieval until activation; for the ledger the job's work is done.
      return result(ctx, 'ready', published.documentId, published.version, 'publish_held');
    case 'published': {
      await clusterAfterPublish(ctx, published.documentId);
      const tenantKey = ctx.identity?.tenantKey ?? scopeKey(ctx.input.scope).toLowerCase();
      // Never awaited: post-publish work must not delay or fail the ingest result (D-29, D-41).
      void afterPublish({ documentId: published.documentId, tenantKey });
      return result(ctx, 'ready', published.documentId, published.version);
    }
    default:
      return result(ctx, 'ready', published.documentId, published.version);
  }
}

export const publishStage: StageSpec = { name: 'publish', minMsNeeded: 0, run };
