import { removeArtifacts } from '../artifacts';
import { HASH_NORMALIZATION_VERSION, contentHash } from '../hash';
import { originFields } from '../origin';
import {
  requireDocument,
  requireIdentity,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';

async function runFileHashDedup(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'file_hash_dedup');
  const begun = await ctx.writer.begin({
    source: ctx.input.source,
    sourceKey: ctx.input.sourceKey,
    filename: identity.filename,
    fileSha256: identity.fileSha256,
    docType: identity.docType,
    docTypeOrigin: identity.docTypeOrigin,
    profileId: identity.profile.id,
    profileVersion: identity.profile.version,
  });
  if (begun.outcome === 'skipped_duplicate') {
    return {
      kind: 'done',
      result: {
        status: 'skipped_duplicate',
        documentId: null,
        version: null,
        parserUsed: null,
        chunkCount: 0,
        warnings: ctx.warnings.slice(),
        duplicateOf: begun.duplicateOf,
      },
    };
  }
  ctx.document = { id: begun.documentId, version: begun.version, lineageId: begun.lineageId, resumed: begun.outcome === 'resumed' };
  const origin = originFields(ctx.input.options);
  if (origin !== null) await ctx.writer.setFields(begun.documentId, origin);
  return { kind: 'next' };
}

async function runContentHashDedup(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'content_hash_dedup');
  const hash = contentHash(ctx.work.parseText ?? '');
  const duplicateOf = await ctx.writer.findContentDuplicate(hash, document.id);
  if (duplicateOf !== null) {
    await removeArtifacts(ctx);
    await ctx.writer.setFields(document.id, {
      content_hash: hash,
      status: 'deleted',
      original_path: null,
      metadata: { duplicate_of: duplicateOf, content_hash_version: HASH_NORMALIZATION_VERSION },
    });
    return {
      kind: 'done',
      result: {
        status: 'skipped_duplicate',
        documentId: null,
        version: null,
        parserUsed: ctx.parserUsed,
        chunkCount: 0,
        warnings: ctx.warnings.slice(),
        duplicateOf,
      },
    };
  }
  await ctx.writer.setFields(document.id, {
    content_hash: hash,
    metadata: { content_hash_version: HASH_NORMALIZATION_VERSION },
  });
  return { kind: 'next' };
}

export const fileHashDedupStage: StageSpec = { name: 'file_hash_dedup', minMsNeeded: 0, run: runFileHashDedup };
export const contentHashDedupStage: StageSpec = { name: 'content_hash_dedup', minMsNeeded: 0, run: runContentHashDedup };
