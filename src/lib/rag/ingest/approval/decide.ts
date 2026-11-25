import type { UploadApproval } from '@/lib/rag-eval/contracts.generated';
import type { UploadApprovalMode } from '../config';

export type { UploadApproval };

export interface UploadApprovalInput {
  mode: UploadApprovalMode;
  scopeKind: 'single' | 'personal' | 'org';
  workspaceUserId: string | null;
  uploaderId: string | null;
  isTenantAdmin: boolean | null;
  exemptions: ReadonlyArray<{ kind: string; ref: string }>;
  connectorRefs: readonly string[];
  decidedAt: string;
}

export function normalizeUploaderId(_value: unknown): string | null {
  return null;
}

/** Not implemented yet (RED): decides nothing. */
export function decideUploadApproval(input: UploadApprovalInput): UploadApproval {
  return { mode: 'off', required: false, reason: null, uploader_id: input.uploaderId, decided_at: input.decidedAt };
}
