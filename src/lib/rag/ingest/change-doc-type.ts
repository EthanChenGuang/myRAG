import type { TenantScope } from '../tenant/scope';
import type { DocType } from './profiles/load';
import type { IngestResult } from './types';

export type ChangeDocumentTypeFailure = 'not_found' | 'not_changeable' | 'original_unavailable' | 'invalid_doc_type' | 'unavailable';

export interface ChangeDocumentTypeInput {
  scope: TenantScope;
  documentId: string;
  docType: DocType;
  signal: AbortSignal;
  deadlineMs?: number;
}

export type ChangeDocumentTypeResult = { ok: true; result: IngestResult } | { ok: false; reason: ChangeDocumentTypeFailure };

export async function changeDocumentType(_input: ChangeDocumentTypeInput): Promise<ChangeDocumentTypeResult> {
  return { ok: false, reason: 'unavailable' };
}
