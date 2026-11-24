export type QuarantineFailure = 'not_found' | 'not_quarantined' | 'not_admin' | 'invalid_argument' | 'unavailable';

export interface QuarantineItem {
  documentId: string;
  lineageId: string;
  tenantKey: string;
  filename: string;
  source: string;
  version: number;
  ruleIds: string[];
  snippets: string[];
  quarantinedAt: string;
  detectedBy: 'injection_scan' | 'invoice_extraction';
}

export type ListQuarantineResult =
  | { ok: true; items: QuarantineItem[]; total: number; limit: number; offset: number }
  | { ok: false; reason: QuarantineFailure };

export interface QuarantineActionInput {
  documentId: string;
  actorUserId: string;
  signal: AbortSignal;
}

export interface ListQuarantineInput {
  actorUserId: string;
  limit?: number;
  offset?: number;
  signal: AbortSignal;
}

export type ReleaseQuarantinedResult =
  | { ok: true; documentId: string; version: number; supersededDocumentId: string | null; ruleIds: string[] }
  | { ok: false; reason: QuarantineFailure };

export type DeleteQuarantinedResult =
  | { ok: true; documentId: string; version: number; ruleIds: string[]; artifactsRemoved: number; artifactsFailed: number }
  | { ok: false; reason: QuarantineFailure };

export async function listQuarantine(_input: ListQuarantineInput): Promise<ListQuarantineResult> {
  return { ok: false, reason: 'unavailable' };
}

export async function releaseQuarantined(_input: QuarantineActionInput): Promise<ReleaseQuarantinedResult> {
  return { ok: false, reason: 'unavailable' };
}

export async function deleteQuarantined(_input: QuarantineActionInput): Promise<DeleteQuarantinedResult> {
  return { ok: false, reason: 'unavailable' };
}
