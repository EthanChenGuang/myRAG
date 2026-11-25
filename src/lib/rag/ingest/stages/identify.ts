import { assertTenantScope, scopeKey } from '../../tenant/scope';
import { resolveUploadApproval } from '../approval/resolve';
import { fileSha256 } from '../hash';
import { normalizeFilename } from '../identity';
import { profileFor } from '../profiles/load';
import { resolveDocType } from '../profiles/resolve-doc-type';
import { INGEST_SOURCES, IngestStageError, type StageContext, type StageOutcome, type StageSpec } from '../types';

function optionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  const { input } = ctx;
  try {
    assertTenantScope(input.scope);
  } catch {
    console.warn('[Ingest] refused: scope was not minted by the tenant module');
    throw new IngestStageError('identify', 'invalid_scope');
  }
  if (!INGEST_SOURCES.includes(input.source)) throw new IngestStageError('identify', 'invalid_source');
  if (typeof input.sourceKey !== 'string' || input.sourceKey.trim() === '') throw new IngestStageError('identify', 'invalid_source_key');

  const bytes = input.file ?? null;
  const resolved = await resolveDocType(
    input.scope,
    {
      picked: input.docType,
      source: input.source,
      nangoConnectionId: optionId(input.options?.nangoConnectionId),
      nangoFolderId: optionId(input.options?.nangoFolderId),
      filename: input.filename,
      mimeType: input.mimeType,
      text: input.text ?? null,
    },
    { db: ctx.deps.db, config: ctx.config, signal: ctx.signal },
  );
  ctx.warnings.push(...resolved.warnings);
  ctx.state.docTypeDetection = resolved.detection
    ? { signals: resolved.detection.signals, refined: null, reparsed: false, detection: resolved.detection }
    : null;

  ctx.identity = {
    tenantKey: scopeKey(input.scope).toLowerCase(),
    filename: normalizeFilename(input.filename),
    fileSha256: fileSha256(bytes ?? Buffer.from(input.text ?? '', 'utf8')),
    docType: resolved.docType,
    docTypeOrigin: resolved.origin,
    profile: profileFor(input.source, resolved.docType),
    bytes,
  };

  // D-56: the approval decision is made here, once, for ingest() and enqueueIngest() alike, and enforced at publish. An admin's
  // type change re-processes a stored file and is not an upload.
  if (ctx.config.uploadApproval !== 'off' && !ctx.state.typeChange) {
    ctx.state.approval = await resolveUploadApproval(ctx);
    if (ctx.state.approval.required) return { kind: 'next', outcome: 'approval_required' };
  }
  return { kind: 'next' };
}

export const identifyStage: StageSpec = { name: 'identify', minMsNeeded: 0, run };
