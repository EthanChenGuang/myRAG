import type { IngestFingerprintParts } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';

export interface BackfillRow {
  id: string;
  tenant_key: string;
  doc_type: string;
  parser_used: string | null;
  parser_version: string | null;
  processing_profile_id: string | null;
  processing_profile_version: number | null;
  chunking_profile_ids: string[];
  lexical_version: number | null;
  embedding_text_version: number | null;
  embedding_profile_ids: string[];
  has_legacy_vectors: boolean;
  ocr_languages: unknown;
}

export interface FingerprintBackfillOptions {
  db: RpcClient;
  tenantKey?: string | null;
  pageSize?: number;
  dryRun?: boolean;
  maxPages?: number;
  embeddingProfileId?: string;
  signal?: AbortSignal;
}

export interface FingerprintBackfillReport {
  dryRun: boolean;
  tenants: Record<string, number>;
  updated: number;
  skipped: number;
  pages: number;
  complete: boolean;
}

export function partsFromStoredRow(_row: BackfillRow, _options: { embeddingProfileId: string }): IngestFingerprintParts {
  throw new Error('not implemented');
}

export async function runFingerprintBackfill(options: FingerprintBackfillOptions): Promise<FingerprintBackfillReport> {
  return { dryRun: options.dryRun === true, tenants: {}, updated: 0, skipped: 0, pages: 0, complete: false };
}
