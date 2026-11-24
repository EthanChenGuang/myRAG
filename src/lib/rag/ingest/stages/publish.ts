import { requireDocument, type StageContext, type StageOutcome, type StageSpec } from '../types';

async function run(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'publish');
  const published = await ctx.writer.publish(document.id);
  return {
    kind: 'done',
    result: {
      status: published.outcome === 'quarantined' ? 'quarantined' : 'ready',
      documentId: published.documentId,
      version: published.version,
      parserUsed: ctx.parserUsed,
      chunkCount: ctx.work.chunksWritten,
      warnings: ctx.warnings.slice(),
    },
  };
}

export const publishStage: StageSpec = { name: 'publish', minMsNeeded: 0, run };
