import { RetrievalBackendError, rpcRows, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { isCanonicalTenantKey } from '@/lib/rag/backend/tenant-key';
import type { OutboxRow } from './claim';
import type { VectorStore } from './stores/types';

/** Document ids per vendor call (T-07-129); the 0740 ledger holds at most 1000 per lineage. */
export const PURGE_DELETE_CHUNK = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A purge failure with a code the drain hands to rag_vector_sync_fail (codes only, D-04). */
export class PurgeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`[Vector Sync] ${code}`);
    this.code = code;
  }
}

/** Points of a purged document were still counted after deletion: the row is retried with the existing backoff. */
export class PurgeIncompleteError extends PurgeError {
  constructor() {
    super('purge_incomplete');
  }
}

export interface PurgeRecord {
  purgeId: string;
  tenantKey: string;
  lineageId: string;
  documentIds: string[];
}

export interface PurgeOutcome {
  collections: number;
  deleted: number;
}

export interface PurgedDocument {
  documentId: string;
  purgeId: string;
  lineageId: string;
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown[]> {
  const response = await rpc.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new RetrievalBackendError(fn, response.error.code ?? null);
  return rpcRows(response.data);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function lowerIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new PurgeError('purge_record_invalid');
  const out = new Set<string>();
  for (const id of ids) {
    const text = String(id).toLowerCase();
    if (!UUID_RE.test(text)) throw new PurgeError('purge_record_invalid');
    out.add(text);
  }
  return [...out].sort();
}

export async function readPurgeRecord(rpc: RpcClient, purgeId: string): Promise<PurgeRecord | null> {
  const [row] = (await call(rpc, 'rag_vector_sync_purge_row', { p_purge_id: purgeId })) as Array<{
    purge_id: string;
    tenant_key: string;
    lineage_id: string;
    document_ids: unknown;
  }>;
  if (!row) return null;
  return {
    purgeId: String(row.purge_id),
    tenantKey: String(row.tenant_key),
    lineageId: String(row.lineage_id),
    documentIds: lowerIds(row.document_ids),
  };
}

/** The must-be-absent documents of one tenant on one target, one page in document id order (0740). */
export async function readPurgedDocuments(
  rpc: RpcClient,
  args: { target: string; tenantKey: string; after: string | null; limit: number },
): Promise<PurgedDocument[]> {
  const rows = (await call(rpc, 'rag_vector_sync_purged_documents', {
    p_target: args.target,
    p_tenant_key: args.tenantKey,
    p_after: args.after,
    p_limit: args.limit,
  })) as Array<{ document_id: string; purge_id: string; lineage_id: string }>;
  return rows.map((row) => ({ documentId: String(row.document_id), purgeId: String(row.purge_id), lineageId: String(row.lineage_id) }));
}

/** Sets a done purge target back to pending and writes its outbox row; false when it is already pending. */
export async function reopenPurge(rpc: RpcClient, purgeId: string, target: string): Promise<boolean> {
  const [reopened] = await call(rpc, 'rag_vector_sync_purge_reopen', { p_purge_id: purgeId, p_target: target });
  return reopened === true;
}

/** Points of these documents in one tenant over every `myrag_chunks_` collection of the store, in chunks of 100 ids. */
export async function countPurgedPoints(store: VectorStore, collections: string[], tenantKey: string, documentIds: string[]): Promise<number> {
  let remaining = 0;
  for (const collection of collections) {
    for (const slice of chunks(documentIds, PURGE_DELETE_CHUNK)) remaining += await store.countDocumentPoints(collection, tenantKey, slice);
  }
  return remaining;
}

/**
 * One claimed `purge` group (RET-05 delta, DATA-24): reads the ledger record, deletes every point of its document ids inside the
 * record's tenant from every collection the store lists, counts again and completes the target only when nothing is left. A record
 * whose tenant differs from the outbox row's is refused. A purge whose ledger row is gone has nothing left to do.
 */
export async function processPurgeGroup(args: { store: VectorStore; rpc: RpcClient; target: string; row: OutboxRow }): Promise<PurgeOutcome> {
  const { store, rpc, target, row } = args;
  if (row.entity !== 'purge') throw new PurgeError('purge_entity_invalid');
  if (store.target !== target || row.target !== target) throw new PurgeError('purge_target_mismatch');
  if (!row.tenant_key || !isCanonicalTenantKey(row.tenant_key)) throw new PurgeError('invalid_tenant_key');
  const purgeId = String(row.entity_id).toLowerCase();
  if (!UUID_RE.test(purgeId)) throw new PurgeError('purge_record_invalid');

  const record = await readPurgeRecord(rpc, purgeId);
  if (record === null) return { collections: 0, deleted: 0 };
  if (record.tenantKey !== row.tenant_key) throw new PurgeError('purge_tenant_mismatch');

  const collections = [...new Set(await store.listCollections())].sort();
  let deleted = 0;
  for (const collection of collections) {
    for (const slice of chunks(record.documentIds, PURGE_DELETE_CHUNK)) {
      deleted += await store.deleteDocuments(collection, record.tenantKey, slice);
    }
  }
  if ((await countPurgedPoints(store, collections, record.tenantKey, record.documentIds)) > 0) throw new PurgeIncompleteError();

  await call(rpc, 'rag_vector_sync_purge_complete', {
    p_purge_id: record.purgeId,
    p_target: target,
    p_collections: collections.length,
    p_points: deleted,
  });
  return { collections: collections.length, deleted };
}
