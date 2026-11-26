import { removeArtifacts } from '../artifacts';
import { callerDocumentMetadata } from '../document-metadata';
import { HASH_NORMALIZATION_VERSION, contentHash } from '../hash';
import { originFields } from '../origin';
import { applyDocumentAttributes } from '../attributes/apply';
import { applyUploadScopes } from '../scopes/upload';
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
    ...(ctx.state.typeChange ? { forceNewVersion: true } : {}),
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
  // Written first so every later stage that writes system metadata wins over a caller key.
  const callerMetadata = callerDocumentMetadata(ctx.input.options);
  if (callerMetadata) await ctx.writer.setFields(begun.documentId, { metadata: callerMetadata });
  const origin = originFields(ctx.input.options);
  if (origin !== null) await ctx.writer.setFields(begun.documentId, origin);
  // D-40: the uploader's tags go on the document before any chunk is written, so the chunk writers copy them to every chunk.
  await applyUploadScopes(ctx);
  // D-23: the version's attributes (explicit, staged or inherited) also go on before any chunk; applyDocumentAttributes is a no-op while off.
  await applyDocumentAttributes(ctx);
  return { kind: 'next' };
}

/** The normalised content hash of a parsed version. A picture parses to no text, so its content is the file itself; otherwise every image would match every other. */
export function versionContentHash(chunkerKind: string, fileSha256: string, parseText: string | null): string {
  return contentHash(chunkerKind === 'image_caption' ? `image:${fileSha256}` : (parseText ?? ''));
}

async function runContentHashDedup(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'content_hash_dedup');
  const identity = requireIdentity(ctx, 'content_hash_dedup');
  const hash = versionContentHash(identity.profile.chunker.kind, identity.fileSha256, ctx.work.parseText);
  // A type change re-processes the same content as a new version of the same document: the version it replaces always has this hash.
  const duplicateOf = ctx.state.typeChange ? null : await ctx.writer.findContentDuplicate(hash, document.id);
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
  return ctx.state.typeChange ? { kind: 'next', outcome: 'forced_version' } : { kind: 'next' };
}

export const fileHashDedupStage: StageSpec = { name: 'file_hash_dedup', minMsNeeded: 0, run: runFileHashDedup };
export const contentHashDedupStage: StageSpec = { name: 'content_hash_dedup', minMsNeeded: 0, run: runContentHashDedup };
