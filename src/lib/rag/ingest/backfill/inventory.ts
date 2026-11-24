import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { once } from 'node:events';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { SourceItem } from './sources';

const HASH_CHUNK = 64 * 1024;
const EXISTING_HASH_CHUNK = 1_000;

export interface BackfillBatchRef {
  id: string;
  tenantKey: string;
}

export interface InventoryEntry {
  sourceKey: string;
  fileSha256: string;
  size: number;
  ext: string;
  filename: string;
  mimeType: string;
  kindHint?: string | null;
}

export interface InventoryDuplicateCounts {
  inInventory: number;
  alreadyExisting: number;
}

export interface InventoryTotals {
  total: number;
  uniqueNew: number;
  inInventoryDuplicates: number;
  existingDuplicates: number;
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

async function streamSha256(stream: Readable, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  stream.on('data', (chunk: Buffer | Uint8Array) => {
    hash.update(chunk);
  });
  const abort = (): void => {
    stream.destroy(signal.reason ?? new Error('aborted'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await once(stream, 'end');
  } finally {
    signal.removeEventListener('abort', abort);
  }
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

async function existingHashes(
  rpc: RpcClient,
  tenantKey: string,
  hashes: string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += EXISTING_HASH_CHUNK) {
    signal.throwIfAborted();
    const slice = hashes.slice(i, i + EXISTING_HASH_CHUNK);
    const { data, error } = await rpc.rpc('rag_existing_file_hashes', {
      p_tenant_key: tenantKey,
      p_hashes: slice,
    });
    if (error) throw new Error('[Backfill] existing hash lookup failed');
    for (const row of (data as Array<{ file_sha256?: string; tenant_key?: string }>) ?? []) {
      if (typeof row?.file_sha256 === 'string' && row.tenant_key === tenantKey) found.add(row.file_sha256);
    }
  }
  return found;
}

async function enqueueSkipped(
  rpc: RpcClient,
  batchId: string,
  jobs: Record<string, unknown>[],
  signal: AbortSignal,
): Promise<void> {
  if (jobs.length === 0) return;
  signal.throwIfAborted();
  const { error } = await rpc.rpc('rag_enqueue_backfill_jobs', {
    p_batch_id: batchId,
    p_jobs: jobs,
  });
  if (error) throw new Error('[Backfill] skipped_duplicate enqueue failed');
}

export async function inventory(
  batch: BackfillBatchRef,
  source: AsyncIterable<SourceItem>,
  deps: BackfillInventoryDeps,
): Promise<InventoryResult> {
  const firstByHash = new Map<string, SourceItem & { hash: string }>();
  const skippedJobs: Record<string, unknown>[] = [];
  let inInventoryDuplicates = 0;
  let total = 0;

  const skipRow = (sourceKey: string, ext: string, fileHash: string): void => {
    skippedJobs.push({
      kind: 'ingest',
      source_key: sourceKey,
      file_sha256: fileHash,
      filename: sourceKey,
      mime_type: mimeFromExt(ext),
      status: 'skipped_duplicate',
      settings: {},
    });
  };

  for await (const item of source) {
    deps.signal.throwIfAborted();
    total += 1;
    const stream = await item.open(deps.signal);
    const hash = await streamSha256(stream as Readable, deps.signal);

    if (firstByHash.has(hash)) {
      inInventoryDuplicates += 1;
      skipRow(item.sourceKey, item.ext, hash);
      continue;
    }
    firstByHash.set(hash, { ...item, hash });
  }

  const uniqueHashes = [...firstByHash.keys()];
  const tenantExisting = await existingHashes(deps.rpc, batch.tenantKey, uniqueHashes, deps.signal);

  const entries: InventoryEntry[] = [];
  let existingDuplicates = 0;

  for (const first of firstByHash.values()) {
    if (tenantExisting.has(first.hash)) {
      existingDuplicates += 1;
      skipRow(first.sourceKey, first.ext, first.hash);
      continue;
    }
    entries.push({
      sourceKey: first.sourceKey,
      fileSha256: first.hash,
      size: first.size,
      ext: first.ext,
      filename: first.sourceKey.split('/').pop() ?? first.sourceKey,
      mimeType: mimeFromExt(first.ext),
      docType: first.docType ?? null,
    });
  }

  await enqueueSkipped(deps.rpc, batch.id, skippedJobs, deps.signal);

  const totals: InventoryTotals = {
    total,
    uniqueNew: entries.length,
    inInventoryDuplicates,
    existingDuplicates,
  };

  console.log('[Backfill] inventory complete', {
    total: totals.total,
    unique_new: totals.uniqueNew,
    in_inventory: totals.inInventoryDuplicates,
    already_existing: totals.existingDuplicates,
  });

  return {
    entries,
    duplicates: { inInventory: inInventoryDuplicates, alreadyExisting: existingDuplicates },
    totals,
  };
}