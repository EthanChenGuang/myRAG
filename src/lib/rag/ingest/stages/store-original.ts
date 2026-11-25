import { originalName, safeContentType, saveArtifact } from '../artifacts';
import { requireDocument, requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/**
 * Keeps the uploaded file in the private bucket at <tenant_key>/<lineage_id>/<version>/original.<ext> and records that key
 * in documents.original_path, so a resumed run and an admin type change never need the caller to resend the file. A storage
 * failure ends the run as store_original_failed (the runner's default for a throwing stage); a retry upserts the same key.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'store_original');
  const document = requireDocument(ctx, 'store_original');
  const bytes = identity.bytes ?? new TextEncoder().encode(ctx.input.text ?? '');
  const key = await saveArtifact(ctx, originalName(identity.filename), bytes, safeContentType(ctx.input.mimeType));
  await ctx.writer.setFields(document.id, { original_path: key });
  return { kind: 'next' };
}

export const storeOriginalStage: StageSpec = { name: 'store_original', minMsNeeded: 0, run };
