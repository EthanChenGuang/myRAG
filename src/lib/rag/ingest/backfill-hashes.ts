import type { SupabaseClient } from '@supabase/supabase-js';

export interface LegacyDocumentRow {
  id: string;
  tenantKey: string;
  content: string;
}

export interface ListPageInput {
  tenantKey: string | null;
  afterId: string | null;
  limit: number;
  signal: AbortSignal;
}

export type ListLegacyDocuments = (input: ListPageInput) => Promise<LegacyDocumentRow[]>;

export interface TenantBackfillReport {
  scanned: number;
  hashed: number;
  skippedEmpty: number;
  failed: number;
}

export interface BackfillReport {
  dryRun: boolean;
  tenants: Record<string, TenantBackfillReport>;
  totals: TenantBackfillReport;
}

export interface BackfillInput {
  db: SupabaseClient;
  tenantKey?: string | null;
  dryRun: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  list?: ListLegacyDocuments;
}

export type ParsedBackfillArgs = { ok: true; tenantKey: string | null; dryRun: boolean; batchSize: number } | { ok: false; error: string };

export function createSupabaseLister(_admin: SupabaseClient): ListLegacyDocuments {
  return async () => [];
}

export function parseBackfillArgs(_argv: string[]): ParsedBackfillArgs {
  return { ok: false, error: 'not implemented' };
}

export async function backfillContentHashes(input: BackfillInput): Promise<BackfillReport> {
  const empty: TenantBackfillReport = { scanned: 0, hashed: 0, skippedEmpty: 0, failed: 0 };
  return { dryRun: input.dryRun, tenants: {}, totals: empty };
}
