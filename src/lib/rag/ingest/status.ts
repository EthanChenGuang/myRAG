import type { TenantScope } from '../tenant/scope';
import type { IngestResult, StageName } from './types';

export interface IngestStatusView {
  status: string;
  version: number;
  processingStatus: string | null;
  lastCompleted: StageName | null;
  parserUsed: string | null;
  docType: string;
}

export interface ResumeIngestOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
}

export async function getIngestStatus(_scope: TenantScope, _documentId: string, _options: ResumeIngestOptions = {}): Promise<IngestStatusView | null> {
  return undefined as unknown as null;
}

export async function resumeIngest(_scope: TenantScope, _documentId: string, _options: ResumeIngestOptions = {}): Promise<IngestResult> {
  return { status: 'failed', documentId: null, version: null, parserUsed: null, chunkCount: 0, warnings: [], reason: 'not_implemented' };
}
