import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient } from '../backend/supabase-rpc';
import { contentHash, normalizeForHash } from './hash';
import { IngestWriterError, createContentHashBackfillWriter, isTenantKey } from './writer';

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

/** One page of ready documents that have no content hash yet, in id order, after the cursor. */
export type ListLegacyDocuments = (input: ListPageInput) => Promise<LegacyDocumentRow[]>;

export interface TenantBackfillReport {
  scanned: number;
  /** Rows given a hash; in a dry run, rows that would be given one. */
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
  /** Service-role client: reads the rows to hash and carries the writer RPCs. */
  db: SupabaseClient;
  tenantKey?: string | null;
  dryRun: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  /** Replaces the service-role reader. */
  list?: ListLegacyDocuments;
}

export type ParsedBackfillArgs = { ok: true; tenantKey: string | null; dryRun: boolean; batchSize: number } | { ok: false; error: string };

export const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

function emptyReport(): TenantBackfillReport {
  return { scanned: 0, hashed: 0, skippedEmpty: 0, failed: 0 };
}

/** Reads through the service-role client. Only rows that are ready and have no hash are returned, so a hash that exists is never rewritten. */
export function createSupabaseLister(admin: SupabaseClient): ListLegacyDocuments {
  return async ({ tenantKey, afterId, limit, signal }) => {
    let query = admin.from('documents').select('id, tenant_key, content').is('content_hash', null).eq('status', 'ready');
    if (tenantKey !== null) query = query.eq('tenant_key', tenantKey);
    if (afterId !== null) query = query.gt('id', afterId);
    const response = await query.order('id', { ascending: true }).limit(limit).abortSignal(signal);
    if (response.error) throw new Error(`[Ingest Backfill] document read failed${response.error.code ? ` (${response.error.code})` : ''}`);
    const rows: LegacyDocumentRow[] = [];
    for (const row of (response.data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.id !== 'string' || typeof row.tenant_key !== 'string') throw new Error('[Ingest Backfill] document read returned an unexpected row');
      rows.push({ id: row.id, tenantKey: row.tenant_key, content: typeof row.content === 'string' ? row.content : '' });
    }
    return rows;
  };
}

/**
 * Fills content_hash and metadata.content_hash_version for documents written before hashing existed, from their stored
 * text and with the one normaliser that new uploads use, so an exact re-upload of already ingested text deduplicates.
 * file_sha256 stays empty: the original bytes of those documents were never stored. Only rows without a hash are read,
 * each is written under its own tenant key, and a document whose text normalises to nothing gets no hash.
 */
export async function backfillContentHashes(input: BackfillInput): Promise<BackfillReport> {
  const signal = input.signal ?? new AbortController().signal;
  const tenantKey = input.tenantKey ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) throw new Error('[Ingest Backfill] invalid tenant key');
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new Error('[Ingest Backfill] invalid batch size');
  const list = input.list ?? createSupabaseLister(input.db);
  const writer = createContentHashBackfillWriter({ db: input.db as unknown as RpcClient, signal });

  const report: BackfillReport = { dryRun: input.dryRun, tenants: {}, totals: emptyReport() };
  let afterId: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    const page = await list({ tenantKey, afterId, limit: batchSize, signal });
    if (page.length === 0) break;
    for (const row of page) {
      const tenant = (report.tenants[row.tenantKey] ??= emptyReport());
      tenant.scanned += 1;
      report.totals.scanned += 1;
      if (normalizeForHash(row.content) === '') {
        tenant.skippedEmpty += 1;
        report.totals.skippedEmpty += 1;
        continue;
      }
      if (!input.dryRun) {
        try {
          await writer.setContentHash(row.id, row.tenantKey, contentHash(row.content));
        } catch (error) {
          if (signal.aborted || !(error instanceof IngestWriterError)) throw error;
          console.error('[Ingest Backfill] write failed', { rpc: error.rpc, code: error.code, ...(error.reason ? { reason: error.reason } : {}) });
          tenant.failed += 1;
          report.totals.failed += 1;
          continue;
        }
      }
      tenant.hashed += 1;
      report.totals.hashed += 1;
    }
    const last = page[page.length - 1]?.id ?? null;
    if (last === afterId) throw new Error('[Ingest Backfill] the reader did not advance');
    afterId = last;
    if (page.length < batchSize) break;
  }
  return report;
}

/** `[--tenant <key>] [--dry-run] [--batch-size <n>]`. A tenant key is `s:default`, `u:<uuid>` or `o:<uuid>`. */
export function parseBackfillArgs(argv: string[]): ParsedBackfillArgs {
  let tenantKey: string | null = null;
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--tenant') {
      const value = argv[(i += 1)];
      if (value === undefined || !isTenantKey(value)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };
      tenantKey = value;
    } else if (arg === '--batch-size') {
      const value = argv[(i += 1)];
      const parsed = value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) return { ok: false, error: `--batch-size needs an integer from 1 to ${MAX_BATCH_SIZE}` };
      batchSize = parsed;
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }
  return { ok: true, tenantKey, dryRun, batchSize };
}

/** The CLI body. Prints counts only, never document text. Returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseBackfillArgs(argv);
  if (!parsed.ok) {
    console.error(`[Ingest Backfill] ${parsed.error}`);
    console.error('usage: npm run rag:backfill-hashes -- [--tenant <key>] [--dry-run] [--batch-size <n>]');
    return 2;
  }
  const { config } = await import('dotenv');
  config({ path: '.env.local', quiet: true });
  const { getIngestDeps } = await import('./deps');
  const db = getIngestDeps().db();
  if (!db) {
    console.error('[Ingest Backfill] admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return 1;
  }
  const report = await backfillContentHashes({
    db: db as unknown as SupabaseClient,
    tenantKey: parsed.tenantKey,
    dryRun: parsed.dryRun,
    batchSize: parsed.batchSize,
  });
  console.log(`[Ingest Backfill] ${report.dryRun ? 'dry run, nothing written' : 'done'}`);
  for (const [tenant, counts] of Object.entries(report.tenants)) {
    console.log(`[Ingest Backfill] ${tenant}: scanned ${counts.scanned}, ${report.dryRun ? 'would hash' : 'hashed'} ${counts.hashed}, skipped empty ${counts.skippedEmpty}, failed ${counts.failed}`);
  }
  const { scanned, hashed, skippedEmpty, failed } = report.totals;
  console.log(`[Ingest Backfill] total: scanned ${scanned}, ${report.dryRun ? 'would hash' : 'hashed'} ${hashed}, skipped empty ${skippedEmpty}, failed ${failed}`);
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('[Ingest Backfill] failed', error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
