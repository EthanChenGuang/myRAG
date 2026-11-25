import { requireDocument, type IngestResult, type IngestStatus, type StageContext, type StageOutcome, type StageSpec } from '../types';
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

async function run(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'publish');
  if (ctx.state.approval?.required === true && !quarantinedByScan(ctx)) return holdForReview(ctx, document.id, document.version);

  const published = await ctx.writer.publish(document.id);
  switch (published.outcome) {
    case 'quarantined':
      return result(ctx, 'quarantined', published.documentId, published.version);
    case 'pending_review':
      return result(ctx, 'pending_review', published.documentId, published.version);
    default:
      return result(ctx, 'ready', published.documentId, published.version);
  }
}

export const publishStage: StageSpec = { name: 'publish', minMsNeeded: 0, run };
