export type PurgeFailure = 'not_found' | 'invalid_argument' | 'tenant_mismatch' | 'unavailable';

export const PURGE_ADMIN_REASON_CODES = ['owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other'] as const;
export type PurgeAdminReasonCode = (typeof PURGE_ADMIN_REASON_CODES)[number];

export type PurgeCheckResult = 'verified' | 'pending' | 'remaining';

export interface PurgeCheck {
  left: Record<string, number>;
  pendingFiles: number;
  queuedExternal: number;
  result: PurgeCheckResult;
  checkedAt: string;
}

export type PurgeLineageResult =
  | { ok: true; auditId: string; lineageId: string; removed: Record<string, number>; check: PurgeCheck }
  | { ok: false; reason: PurgeFailure };

export interface PurgeDocumentAsAdminInput {
  documentId: string;
  actorUserId: string;
  reasonCode: PurgeAdminReasonCode;
  reasonNote: string | null;
  signal: AbortSignal;
}

export async function purgeDocumentAsAdmin(_input: PurgeDocumentAsAdminInput): Promise<PurgeLineageResult> {
  return { ok: false, reason: 'unavailable' };
}
