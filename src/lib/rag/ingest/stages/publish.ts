import { redisvlInvalidationTarget } from '../../cache/emit';
import { scheduleAfterResponse } from '../../trace/schedule';
import { requireDocument, type StageContext, type StageOutcome, type StageSpec } from '../types';

async function run(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'publish');
  const published = await ctx.writer.publish(document.id);
  const cache = redisvlInvalidationTarget();
  if (cache) {
    const scope = ctx.input.scope;
    const documentIds = [published.documentId, published.supersededDocumentId].filter((id): id is string => typeof id === 'string');
    scheduleAfterResponse(async () => {
      await cache.invalidateTenant(scope, documentIds);
    });
  }
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
