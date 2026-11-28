import { describe, expect, it } from 'vitest';
import { RetrievalBackendError, type RpcClient, type RpcRequest, type RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { OutboxRow } from '@/lib/rag/sync/claim';
import { PurgeError, PurgeIncompleteError, processPurgeGroup } from '@/lib/rag/sync/purge';
import { createFakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorPoint, VectorStore } from '@/lib/rag/sync/stores/types';

const KEY_A = 'u:00000000-0000-4000-8000-0000000000a1';
const KEY_B = 'u:00000000-0000-4000-8000-0000000000b1';
const PURGE_ID = '00000000-0000-4000-8000-00000000f001';
const LINEAGE = '00000000-0000-4000-8000-00000000f0aa';

function uuid(n: number, block: string): string {
  return `00000000-0000-4000-8000-${block.repeat(4)}${String(n).padStart(8, '0')}`;
}

function point(n: number, tenantKey: string, documentId: string): VectorPoint {
  return {
    id: uuid(n, tenantKey === KEY_A ? 'a' : 'b'),
    vector: [1, 0, 0],
    payload: {
      tenant_key: tenantKey,
      document_id: documentId,
      doc_type: null,
      doc_date: null,
      language: null,
      source: null,
      chunking_profile_id: null,
      parent_id: null,
      lexical_text: null,
      content_hash: null,
      lexical_version: null,
      access_groups: ['all'],
    },
  };
}

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function fakeRpc(answers: Record<string, (args: Record<string, unknown>) => RpcResponse>): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const request: RpcRequest = {
        abortSignal: () => request,
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          const answer = answers[fn];
          const response: RpcResponse = answer ? answer(args) : { data: null, error: { message: 'unknown', code: 'PGRST202' } };
          return Promise.resolve(response).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 7,
    target: 'qdrant',
    entity: 'purge',
    entity_id: PURGE_ID,
    tenant_key: KEY_A,
    profile_id: null,
    cursor: null,
    attempts: 1,
    enqueued_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function record(tenantKey: string, ids: string[]) {
  return { data: [{ purge_id: PURGE_ID, tenant_key: tenantKey, lineage_id: LINEAGE, document_ids: ids }], error: null };
}

async function store2(ids: string[]) {
  const store = createFakeVectorStore('qdrant');
  for (const profileId of ['p-active', 'p-retired']) {
    await store.ensureCollection({ profileId, dims: 3 });
    await store.upsert(profileId, KEY_A, ids.slice(0, 3).map((id, i) => point(i + 1, KEY_A, id)));
    await store.upsert(profileId, KEY_B, [point(50, KEY_B, ids[0])]);
  }
  return store;
}

describe('processPurgeGroup', () => {
  it('250 document ids are deleted in three calls per collection, then counted and completed with the totals', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i + 1, 'd'));
    const store = await store2(ids);
    const deletes: Array<{ collection: string; n: number }> = [];
    const spy: VectorStore = {
      ...store,
      deleteDocuments: async (collection, tenantKey, documentIds) => {
        deletes.push({ collection, n: documentIds.length });
        return store.deleteDocuments(collection, tenantKey, documentIds);
      },
    };
    const { client, calls } = fakeRpc({
      rag_vector_sync_purge_row: () => record(KEY_A, ids),
      rag_vector_sync_purge_complete: () => ({ data: true, error: null }),
    });
    const outcome = await processPurgeGroup({ store: spy, rpc: client, target: 'qdrant', row: row() });
    expect(outcome).toEqual({ collections: 2, deleted: 6 });
    expect(deletes).toEqual([
      { collection: 'myrag_chunks_p-active', n: 100 },
      { collection: 'myrag_chunks_p-active', n: 100 },
      { collection: 'myrag_chunks_p-active', n: 50 },
      { collection: 'myrag_chunks_p-retired', n: 100 },
      { collection: 'myrag_chunks_p-retired', n: 100 },
      { collection: 'myrag_chunks_p-retired', n: 50 },
    ]);
    expect(calls.map((c) => c.fn)).toEqual(['rag_vector_sync_purge_row', 'rag_vector_sync_purge_complete']);
    expect(calls[1].args).toEqual({ p_purge_id: PURGE_ID, p_target: 'qdrant', p_collections: 2, p_points: 6 });
    expect(store.points('p-active', KEY_B)).toHaveLength(1);
    expect(store.points('p-retired', KEY_B)).toHaveLength(1);
  });

  it('a record whose tenant differs from the outbox row is refused before any delete', async () => {
    const ids = [uuid(1, 'd')];
    const store = await store2([...ids, uuid(2, 'd'), uuid(3, 'd')]);
    let deleted = 0;
    const spy: VectorStore = { ...store, deleteDocuments: async () => ((deleted += 1), 0) };
    const { client, calls } = fakeRpc({ rag_vector_sync_purge_row: () => record(KEY_B, ids) });
    await expect(processPurgeGroup({ store: spy, rpc: client, target: 'qdrant', row: row() })).rejects.toMatchObject({
      code: 'purge_tenant_mismatch',
    });
    expect(deleted).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual(['rag_vector_sync_purge_row']);
  });

  it('an RPC error from rag_vector_sync_purge_row is rethrown with its code', async () => {
    const store = createFakeVectorStore('qdrant');
    const { client } = fakeRpc({ rag_vector_sync_purge_row: () => ({ data: null, error: { message: 'refused', code: '22023' } }) });
    const failure = processPurgeGroup({ store, rpc: client, target: 'qdrant', row: row() });
    await expect(failure).rejects.toBeInstanceOf(RetrievalBackendError);
    await expect(failure).rejects.toMatchObject({ rpc: 'rag_vector_sync_purge_row', code: '22023' });
  });

  it('a point left after deletion throws PurgeIncompleteError and never completes', async () => {
    const ids = [uuid(1, 'd'), uuid(2, 'd'), uuid(3, 'd')];
    const store = await store2(ids);
    const keep: VectorStore = { ...store, deleteDocuments: async () => 0 };
    const { client, calls } = fakeRpc({ rag_vector_sync_purge_row: () => record(KEY_A, ids) });
    const failure = processPurgeGroup({ store: keep, rpc: client, target: 'qdrant', row: row() });
    await expect(failure).rejects.toBeInstanceOf(PurgeIncompleteError);
    await expect(failure).rejects.toMatchObject({ code: 'purge_incomplete' });
    expect(calls.some((c) => c.fn === 'rag_vector_sync_purge_complete')).toBe(false);
  });

  it('a purge whose ledger row is gone completes with nothing to do; a malformed row is refused', async () => {
    const store = createFakeVectorStore('qdrant');
    const { client, calls } = fakeRpc({ rag_vector_sync_purge_row: () => ({ data: [], error: null }) });
    expect(await processPurgeGroup({ store, rpc: client, target: 'qdrant', row: row() })).toEqual({ collections: 0, deleted: 0 });
    expect(calls.map((c) => c.fn)).toEqual(['rag_vector_sync_purge_row']);
    await expect(processPurgeGroup({ store, rpc: client, target: 'qdrant', row: row({ tenant_key: 'u:bad' }) })).rejects.toBeInstanceOf(PurgeError);
    await expect(processPurgeGroup({ store, rpc: client, target: 'qdrant', row: row({ entity_id: 'nope' }) })).rejects.toMatchObject({
      code: 'purge_record_invalid',
    });
    await expect(processPurgeGroup({ store, rpc: client, target: 'weaviate', row: row() })).rejects.toMatchObject({ code: 'purge_target_mismatch' });
  });
});
