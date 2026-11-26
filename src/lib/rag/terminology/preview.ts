import type { TerminologyEntry, TerminologyPreviewResponse } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../tenant/scope';
import type { TerminologyAdminFailed } from './admin';

export interface TerminologyPreviewInput {
  actorUserId: string;
  scope: TenantScope;
  layerKey: string;
  query: string;
  drafts?: readonly TerminologyEntry[];
  signal: AbortSignal;
}

export type TerminologyPreviewResult = { ok: true; preview: TerminologyPreviewResponse } | TerminologyAdminFailed;

export async function previewTerminology(_input: TerminologyPreviewInput): Promise<TerminologyPreviewResult> {
  return { ok: false, reason: 'unavailable' };
}
