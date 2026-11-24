import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { isTenantScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import type { SourceItem } from './sources';

const EXISTING_HASH_CHUNK = 1_000;
const SKIPPED_ENQUEUE_CHUNK = 1_000;

export interface BackfillBatchRef {
  id: string;
  /** The scope from backfillScope; it must be the tenant the batch row belongs to, or the inventory refuses. */
  scope: TenantScope;
}

export interface InventoryEntry {
  sourceKey: string;
  fileSha256: string;
  size: number;
  ext: string;
  filename: string;
  mimeType: string;
  docType: SourceItem['docType'] | null;
}

export interface InventoryDuplicateCounts {
  inInventory: number;
  alreadyExisting: number;
}

/** total = uniqueNew + inInventoryDuplicates + existingDuplicates + unreadable. */
export interface InventoryTotals {
  total: number;
  uniqueNew: number;
  inInventoryDuplicates: number;
  existingDuplicates: number;
  unreadable: number;
}

export interface InventoryResult {
  entries: InventoryEntry[];
  duplicates: InventoryDuplicateCounts;
  totals: InventoryTotals;
}

export interface BackfillInventoryDeps {
  rpc: RpcClient;
  signal: AbortSignal;
}

interface FirstSeen {
  sourceKey: string;
  size: number;
  ext: string;
  docType: SourceItem['docType'] | null;
}

async function streamSha256(stream: NodeJS.ReadableStream, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(stream, sink, { signal });
  return hash.digest('hex');
}

function mimeFromExt(ext: string): string {
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'txt':
    case 'md':
      return 'text/plain';
    case 'html':
      return 'text/html';
    case 'json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

function baseName(sourceKey: string): string {
  return sourceKey.split('/').pop() ?? sourceKey;
}

/**
 * The tenant is whatever the batch row says: rag_enqueue_backfill_jobs reads it from there, so the duplicate lookup must
 * too. A no-op update is the one existing RPC that returns the row; it only touches updated_at.
 */
async function batchTenantKey(rpc: RpcClient, batchId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const { data, error } = await rpc.rpc('rag_update_ingestion_batch', { p_batch_id: batchId }).abortSignal(signal);
  if (error) throw new Error('[Backfill] batch lookup failed');
  const row = (Array.isArray(data) ? data[0] : data) as { tenant_key?: unknown } | null | undefined;
  if (typeof row?.tenant_key !== 'string' || row.tenant_key === '') throw new Error('[Backfill] batch lookup failed');
  return row.tenant_key;
}

async function existingHashes(rpc: RpcClient, tenantKey: string, hashes: string[], signal: AbortSignal): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += EXISTING_HASH_CHUNK) {
    signal.throwIfAborted();
    const { data, error } = await rpc
      .rpc('rag_existing_file_hashes', { p_tenant_key: tenantKey, p_hashes: hashes.slice(i, i + EXISTING_HASH_CHUNK) })
      .abortSignal(signal);
    if (error) throw new Error('[Backfill] existing hash lookup failed');
    for (const row of (data as Array<{ file_sha256?: string; tenant_key?: string }> | null) ?? []) {
      // The SQL already filters on the tenant; a row of any other tenant is ignored here as well.
      if (typeof row?.file_sha256 === 'string' && row.tenant_key === tenantKey) found.add(row.file_sha256);
    }
  }
  return found;
}

async function enqueueSkipped(rpc: RpcClient, batchId: string, jobs: Record<string, unknown>[], signal: AbortSignal): Promise<void> {
  for (let i = 0; i < jobs.length; i += SKIPPED_ENQUEUE_CHUNK) {
    signal.throwIfAborted();
    const { error } = await rpc
      .rpc('rag_enqueue_backfill_jobs', { p_batch_id: batchId, p_jobs: jobs.slice(i, i + SKIPPED_ENQUEUE_CHUNK) })
      .abortSignal(signal);
    if (error) throw new Error('[Backfill] skipped_duplicate enqueue failed');
  }
}

/**
 * D-33 step 1. Hashes every file of the source (streaming, never whole in memory), keeps the first file of each hash
 * and records every other copy, and every file whose hash the tenant already has as a current ready document, as a
 * skipped_duplicate ledger row of the batch. Dedupe is inside the batch's tenant only. Re-running it for the same batch
 * is safe: the ledger's unique key on (batch, kind, source_key) drops rows that exist already.
 */
export async function inventory(batch: BackfillBatchRef, source: AsyncIterable<SourceItem>, deps: BackfillInventoryDeps): Promise<InventoryResult> {
  if (!isTenantScope(batch.scope)) throw new Error('[Backfill] batch tenant mismatch');
  const tenantKey = await batchTenantKey(deps.rpc, batch.id, deps.signal);
  if (scopeKey(batch.scope) !== tenantKey) {
    console.warn('[Backfill] batch tenant mismatch');
    throw new Error('[Backfill] batch tenant mismatch');
  }
  const firstByHash = new Map<string, FirstSeen>();
  const skippedJobs: Record<string, unknown>[] = [];
  let inInventoryDuplicates = 0;
  let unreadable = 0;
  let total = 0;

  const skipRow = (sourceKey: string, ext: string, fileHash: string): void => {
    skippedJobs.push({
      kind: 'ingest',
      source_key: sourceKey,
      file_sha256: fileHash,
      filename: baseName(sourceKey),
      mime_type: mimeFromExt(ext),
      status: 'skipped_duplicate',
      settings: {},
    });
  };

  for await (const item of source) {
    deps.signal.throwIfAborted();
    total += 1;
    let hash: string;
    try {
      hash = await streamSha256(await item.open(deps.signal), deps.signal);
    } catch (error) {
      if (deps.signal.aborted) throw error;
      unreadable += 1;
      console.warn('[Backfill] source unreadable', { count: unreadable });
      continue;
    }
    if (firstByHash.has(hash)) {
      inInventoryDuplicates += 1;
      skipRow(item.sourceKey, item.ext, hash);
      continue;
    }
    firstByHash.set(hash, { sourceKey: item.sourceKey, size: item.size, ext: item.ext, docType: item.docType ?? null });
  }

  const tenantExisting = await existingHashes(deps.rpc, tenantKey, [...firstByHash.keys()], deps.signal);

  const entries: InventoryEntry[] = [];
  let existingDuplicates = 0;
  for (const [hash, first] of firstByHash) {
    if (tenantExisting.has(hash)) {
      existingDuplicates += 1;
      skipRow(first.sourceKey, first.ext, hash);
      continue;
    }
    entries.push({
      sourceKey: first.sourceKey,
      fileSha256: hash,
      size: first.size,
      ext: first.ext,
      filename: baseName(first.sourceKey),
      mimeType: mimeFromExt(first.ext),
      docType: first.docType,
    });
  }

  await enqueueSkipped(deps.rpc, batch.id, skippedJobs, deps.signal);

  const totals: InventoryTotals = { total, uniqueNew: entries.length, inInventoryDuplicates, existingDuplicates, unreadable };
  console.log('[Backfill] inventory complete', {
    total: totals.total,
    unique_new: totals.uniqueNew,
    in_inventory: totals.inInventoryDuplicates,
    already_existing: totals.existingDuplicates,
    unreadable: totals.unreadable,
  });

  return {
    entries,
    duplicates: { inInventory: inInventoryDuplicates, alreadyExisting: existingDuplicates },
    totals,
  };
}
