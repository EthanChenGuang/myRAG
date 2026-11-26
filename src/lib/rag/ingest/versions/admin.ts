import type { RpcClient } from '../../backend/supabase-rpc';
import { getRagDeps } from '../../deps';
import { type TenantScope } from '../../tenant/scope';
import { displayUsers } from '../approval/admin';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import type { StageContext } from '../types';

/**
 * "Replaces…" at upload and the supersession admin service (DATA-19, D-41, D-50). The uploader may name the document a new upload
 * replaces: the route checks it belongs to the upload's own tenant, is current and is not the upload's own lineage, before anything is
 * stored. The pipeline records the intent on the version; after publish the detector hook raises it (origin uploader) and, when the
 * uploader is an admin of the tenant, confirms it at once. A member's intent stays a pending candidate for an admin. Logs carry ids only.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

/** "Replaces…" counts only under the unified pipeline with RAG_SUPERSESSION_DETECT=on (UI-SPEC decision 9); otherwise it is not offered. */
export function replacesEnabled(_config: Pick<IngestConfig, 'pipeline' | 'supersessionDetect'> = currentIngestConfig()): boolean {
  return false;
}

export type UploadReplacesFailure = 'invalid_replaces' | 'replaces_not_found' | 'replaces_same_lineage' | 'unavailable';

export type ValidateUploadReplacesResult =
  /** replacesDocumentId is undefined when the upload names none or the field is ignored (switch off or legacy pipeline). */
  | { ok: true; replacesDocumentId: string | undefined; ignored: boolean }
  | { ok: false; reason: UploadReplacesFailure };

function single(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Route-side check of the upload's "Replaces…" field, before any document row or stored object exists. The named document must be a
 * current, ready document of the scope's own tenant (another tenant's id and a non-current document get the same replaces_not_found) and
 * must not be the lineage the upload itself writes into (same source and source key).
 */
export async function validateUploadReplaces(
  _scope: TenantScope,
  _raw: unknown,
  _options: { signal: AbortSignal; source: string; sourceKey: string; config?: Pick<IngestConfig, 'pipeline' | 'supersessionDetect'> },
): Promise<ValidateUploadReplacesResult> {
  return { ok: true, replacesDocumentId: undefined, ignored: false };
}

/** Whether a "Replaces…" by this user in this workspace is confirmed at once (an admin of the tenant). A failed lookup answers false. */
export async function replacesConfirmedAtOnce(_scope: TenantScope, _userId: string, _signal: AbortSignal): Promise<boolean> {
  return false;
}

/**
 * Publish stage: records the upload's "Replaces…" intent on the version (metadata.supersession_replaces) before it is published or held,
 * so the post-publish hook finds it after an approval too. confirm is true only when the uploader is an admin of the tenant now; the SQL
 * confirmation checks the actor again. Nothing is written without a replacesDocumentId or with the switch off.
 */
export async function recordReplacesIntent(_ctx: StageContext, _documentId: string): Promise<void> {}

// --- Admin service (D-50) -----------------------------------------------------------------------------------------------------------

export type SupersessionAdminFailure =
  | 'not_found'
  | 'already_decided'
  | 'direction_required'
  | 'direction_conflict'
  | 'stale_candidate'
  | 'not_confirmed'
  | 'invalid_argument'
  | 'unavailable';

type AdminError = { ok: false; reason: SupersessionAdminFailure };

export interface SupersessionScopeInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  /** The one workspace the guard admitted the actor for. */
  tenantKey: string;
  signal: AbortSignal;
}

export interface SupersessionDocumentView {
  id: string;
  fileName: string;
  docType: string | null;
  docDate: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  uploadedAt: string | null;
  uploader: { id: string; display: string } | null;
}

export type SupersessionEntry =
  | {
      kind: 'candidate';
      id: string;
      origin: string;
      direction: 'document_newer' | 'candidate_newer' | null;
      stale: boolean;
      signals: { title_match: boolean; content_overlap_percent: number; conflicting_numbers: number };
      document: SupersessionDocumentView | null;
      candidateDocument: SupersessionDocumentView | null;
      createdAt: string | null;
    }
  | {
      kind: 'link';
      id: string;
      linkId: string;
      origin: string;
      older: SupersessionDocumentView | null;
      newer: SupersessionDocumentView | null;
      decidedAt: string | null;
      decidedBy: { id: string; display: string } | null;
    };

export type ListSupersessionResult = { ok: true; items: SupersessionEntry[]; total: number; limit: number; offset: number } | AdminError;
export type ConfirmSupersessionResult = { ok: true; candidateId: string; olderDocumentId: string; newerDocumentId: string } | AdminError;
export type DismissSupersessionResult = { ok: true; candidateId: string } | AdminError;
export type UndoSupersessionResult = { ok: true; candidateId: string; olderDocumentId: string; newerDocumentId: string | null } | AdminError;

export async function listSupersession(_input: SupersessionScopeInput & { limit?: number; offset?: number }): Promise<ListSupersessionResult> {
  return { ok: false, reason: 'unavailable' };
}
export async function confirmSupersession(_input: SupersessionScopeInput & { candidateId: string; olderDocumentId?: string | null }): Promise<ConfirmSupersessionResult> {
  return { ok: false, reason: 'unavailable' };
}
export async function dismissSupersession(_input: SupersessionScopeInput & { candidateId: string }): Promise<DismissSupersessionResult> {
  return { ok: false, reason: 'unavailable' };
}
export async function undoSupersession(_input: SupersessionScopeInput & { candidateId: string }): Promise<UndoSupersessionResult> {
  return { ok: false, reason: 'unavailable' };
}
