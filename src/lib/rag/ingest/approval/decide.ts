import type { UploadApproval } from '@/lib/rag-eval/contracts.generated';
import type { UploadApprovalMode } from '../config';

export type { UploadApproval };

export type UploadApprovalReason = NonNullable<UploadApproval['reason']>;

export interface UploadExemption {
  kind: string;
  ref: string;
}

export interface UploadApprovalInput {
  mode: UploadApprovalMode;
  /** The kind of the tenant the upload is written to. */
  scopeKind: 'single' | 'personal' | 'org';
  /** The owner of a personal workspace (its scope user); null for the other kinds. */
  workspaceUserId: string | null;
  /** The server-verified uploader (session user or connection owner); null when it cannot be resolved. */
  uploaderId: string | null;
  /** rag_is_tenant_admin(uploader, tenant); null when it was not asked or could not be answered (treated as not an admin). */
  isTenantAdmin: boolean | null;
  /** The tenant's exemption rows (rag_upload_exemptions_for). */
  exemptions: readonly UploadExemption[];
  /** The connector references of this upload (connection ids); matched against `connector` exemptions. */
  connectorRefs: readonly string[];
  decidedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID in lower case, or null for anything else. */
export function normalizeUploaderId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function decision(input: UploadApprovalInput, required: boolean, reason: UploadApprovalReason | null): UploadApproval {
  return { mode: input.mode, required, reason, uploader_id: input.uploaderId, decided_at: input.decidedAt };
}

/**
 * The upload-approval rule (D-36, D-37), a pure function. Off decides nothing. An exemption for the uploader or for the connector
 * lifts the hold in both modes; otherwise an unknown uploader is held. `all` holds every remaining upload. `members` holds an upload
 * by a user who is not an admin of the tenant, except a personal workspace's own upload.
 */
export function decideUploadApproval(input: UploadApprovalInput): UploadApproval {
  if (input.mode === 'off') return decision(input, false, null);
  const uploader = input.uploaderId;
  if (uploader !== null && input.exemptions.some((row) => row.kind === 'uploader' && row.ref.trim().toLowerCase() === uploader)) {
    return decision(input, false, 'exempt_uploader');
  }
  const connectors = new Set(input.connectorRefs.filter((ref) => ref.trim() !== ''));
  if (connectors.size > 0 && input.exemptions.some((row) => row.kind === 'connector' && connectors.has(row.ref.trim()))) {
    return decision(input, false, 'exempt_connector');
  }
  if (uploader === null) return decision(input, true, 'unknown_uploader');
  if (input.mode === 'all') return decision(input, true, 'all_uploads');
  if (input.scopeKind === 'personal' && input.workspaceUserId !== null && input.workspaceUserId.toLowerCase() === uploader) {
    return decision(input, false, 'personal_workspace');
  }
  if (input.isTenantAdmin === true) return decision(input, false, 'admin_upload');
  return decision(input, true, 'member_upload');
}
