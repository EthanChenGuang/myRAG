import { AccessGroupsError } from '../access/errors';
import { IngestStageError, type StageContext } from './types';
import type { IngestWriter } from './writer';

const LABEL_REASONS = new Set(['unknown_group', 'unknown_user', 'empty_access', 'not_found', 'actor_required']);

/**
 * D-16, RESEARCH Pitfall 7: writes the upload's access label on a version that has begun and is not yet published. Any failure stops the
 * run (the version is marked failed), so a restricted upload never becomes retrievable as everyone. Logs carry the reason word only.
 */
export async function writeUploadAccess(
  writer: IngestWriter,
  documentId: string,
  keys: readonly string[],
  uploaderId: string | null,
): Promise<void> {
  if (!writer.setUploadAccess) throw new IngestStageError('file_hash_dedup', 'access_label_unavailable');
  try {
    await writer.setUploadAccess(documentId, keys, uploaderId);
  } catch (error) {
    const reason = error instanceof AccessGroupsError && error.reason !== null && LABEL_REASONS.has(error.reason) ? error.reason : 'access_label_failed';
    console.error('[Ingest] upload access label not stored', { reason, code: error instanceof AccessGroupsError ? error.code : null });
    throw new IngestStageError('file_hash_dedup', reason);
  }
}

/** Stage hook after begin: no keys means untouched (default or the inherited label, D-19) and nothing is called. */
export async function applyUploadAccess(ctx: StageContext): Promise<void> {
  const keys = ctx.input.accessKeys;
  if (!keys || keys.length === 0 || !ctx.document) return;
  await writeUploadAccess(ctx.writer, ctx.document.id, keys, uploaderOf(ctx));
}

function uploaderOf(ctx: StageContext): string | null {
  const scope = ctx.input.scope as { userId?: string | null };
  const id = ctx.input.uploaderId ?? scope.userId ?? null;
  return typeof id === 'string' && id !== '' ? id.toLowerCase() : null;
}
