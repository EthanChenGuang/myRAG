import type { UploadApproval } from '@/lib/rag-eval/contracts.generated';
import type { UploaderHoldMode } from '../../generation/answer-config';
import { scopeKey } from '../../tenant/scope';
import type { StageContext } from '../types';
import { decideUploadApproval, normalizeUploaderId, uploaderHeldFor } from './decide';

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
export async function resolveUploadApproval(ctx: StageContext, holdMode: UploaderHoldMode = 'off'): Promise<UploadApproval> {
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
  const uploaderHeld = await checkUploaderHold(ctx, holdMode, uploaderId);
  if (uploaderHeld) return decideUploadApproval({ ...base, isTenantAdmin: null, exemptions: [], uploaderHeld });
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

/**
 * D-46: the uploader hold of this upload, asked on the ingest's admin client with the run's tenant key. A lookup that fails is not held
 * and is recorded on the trace (uploader_hold: check_failed); an active hold is recorded as held.
 */
export async function checkUploaderHold(ctx: StageContext, holdMode: UploaderHoldMode, uploaderId: string | null = uploaderOf(ctx)): Promise<boolean> {
  if (holdMode === 'off' || uploaderId === null) return false;
  const tenantKey = ctx.identity?.tenantKey ?? scopeKey(ctx.input.scope).toLowerCase();
  const held = await uploaderHeldFor({
    holdMode,
    tenantKey,
    uploaderId,
    client: ctx.deps.db(),
    signal: ctx.signal,
    onFailure: () => {
      ctx.state.traceFacts = { ...ctx.state.traceFacts, uploader_hold: 'check_failed' };
    },
  });
  if (held) ctx.state.traceFacts = { ...ctx.state.traceFacts, uploader_hold: 'held' };
  return held;
}
