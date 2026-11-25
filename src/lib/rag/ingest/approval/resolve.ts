import type { UploadApproval } from '@/lib/rag-eval/contracts.generated';
import type { StageContext } from '../types';
import { decideUploadApproval, normalizeUploaderId } from './decide';

function connectorRefsOf(ctx: StageContext): string[] {
  const options = ctx.input.options;
  const refs = [options?.nangoConnectionId, options?.origin?.sourceConnectionId];
  return [...new Set(refs.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '').map((ref) => ref.trim()))];
}

/**
 * The uploader the decision trusts: the user of a personal or organization scope (minted from the verified session or the
 * connection owner), else the caller's server-set uploaderId (a single-tenant scope carries no user). Never a request field.
 */
export function uploaderOf(ctx: StageContext): string | null {
  return normalizeUploaderId(ctx.input.scope.userId) ?? normalizeUploaderId(ctx.input.uploaderId);
}

/**
 * The approval decision of one upload (D-36, D-37, D-56), asked of the database on the admin client with the scope's tenant key as the
 * only tenant input. A lookup that fails counts as "not an admin" and "no exemption", so a failure can only hold, never publish.
 */
export async function resolveUploadApproval(ctx: StageContext): Promise<UploadApproval> {
  const mode = ctx.config.uploadApproval;
  const scope = ctx.input.scope;
  const uploaderId = uploaderOf(ctx);
  const decidedAt = new Date(ctx.deps.now()).toISOString();
  const base = {
    mode,
    scopeKind: scope.kind,
    workspaceUserId: scope.kind === 'personal' ? normalizeUploaderId(scope.userId) : null,
    uploaderId,
    connectorRefs: connectorRefsOf(ctx),
    decidedAt,
  };
  if (mode === 'off') return decideUploadApproval({ ...base, isTenantAdmin: null, exemptions: [] });

  let exemptions: Array<{ kind: string; ref: string }> = [];
  try {
    exemptions = await ctx.writer.uploadExemptions();
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    console.warn('[Ingest] upload exemptions unavailable; deciding without them', { error: error instanceof Error ? error.name : 'unknown' });
  }

  let isTenantAdmin: boolean | null = null;
  const personalOwn = base.scopeKind === 'personal' && base.workspaceUserId !== null && base.workspaceUserId === uploaderId;
  if (mode === 'members' && uploaderId !== null && !personalOwn) {
    try {
      isTenantAdmin = await ctx.writer.isTenantAdmin(uploaderId);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      console.warn('[Ingest] tenant admin check unavailable; treating the uploader as a member', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  return decideUploadApproval({ ...base, isTenantAdmin, exemptions });
}
