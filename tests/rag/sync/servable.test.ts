import { describe, expect, it } from 'vitest';
import { RetrievalBackendError, type RpcClient, type RpcRequest, type RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import {
  checkpointRow,
  claimBatch,
  completeRows,
  expandRow,
  failRow,
  readChunkRow,
  readDocumentRows,
  readSyncProfiles,
} from '@/lib/rag/sync/claim';
import { planChunkSync, planDocumentSync, type SyncRow } from '@/lib/rag/sync/servable';

const TENANT_A = 'u:00000000-0000-4000-8000-0000000000a1';
const TENANT_B = 'u:00000000-0000-4000-8000-0000000000b1';
const DOC = '00000000-0000-4000-8000-00000000d001';
const D03_KEYS = [
  'chunking_profile_id',
  'content_hash',
  'doc_date',
  'doc_type',
  'document_id',
  'language',
  'lexical_text',
  'lexical_version',
  'parent_id',
  'source',
  'tenant_key',
];

function chunkId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function syncRow(n: number, extra: Partial<SyncRow> & Record<string, unknown> = {}): SyncRow {
  return {
    chunk_id: chunkId(n),
    document_id: DOC,
    tenant_key: TENANT_A,
    vector: '[0.1,0.2,0.3]',
    lexical_text: `alpha beta ${n}`,
    lexical_version: 1,
    content_hash: `hash${n}`,
    doc_type: 'general',
    doc_date: null,
    language: 'en',
    source: 'upload',
    chunking_profile_id: null,
    parent_id: null,
    ...extra,
  } as SyncRow;
}

describe('planDocumentSync', () => {
  it('upserts every servable row and deletes every store id not among them', () => {
    const plan = planDocumentSync(TENANT_A, [syncRow(1), syncRow(2)], [chunkId(1), chunkId(3), chunkId(4)]);
    expect(plan.upserts.map((p) => p.id)).toEqual([chunkId(1), chunkId(2)]);
    expect(plan.deletes.sort()).toEqual([chunkId(3), chunkId(4)]);
  });

  it('deletes every store id when the document has no servable rows', () => {
    const plan = planDocumentSync(TENANT_A, [], [chunkId(1), chunkId(2)]);
    expect(plan.upserts).toEqual([]);
    expect(plan.deletes.sort()).toEqual([chunkId(1), chunkId(2)]);
  });

  it('never upserts a foreign tenant row under the outbox tenant', () => {
    const plan = planDocumentSync(TENANT_A, [syncRow(1), syncRow(2, { tenant_key: TENANT_B })], [chunkId(2)]);
    expect(plan.upserts.map((p) => p.id)).toEqual([chunkId(1)]);
    expect(plan.upserts.every((p) => p.payload.tenant_key === TENANT_A)).toBe(true);
    expect(plan.deletes).toEqual([chunkId(2)]);
  });

  it('limits deletes to the page range so a paged document is covered exactly once', () => {
    const store = [chunkId(1), chunkId(2), chunkId(5), chunkId(7), chunkId(9)];
    const first = planDocumentSync(TENANT_A, [syncRow(2), syncRow(5)], store, { after: null, through: chunkId(5) });
    expect(first.deletes).toEqual([chunkId(1)]);
    const last = planDocumentSync(TENANT_A, [syncRow(7)], store, { after: chunkId(5), through: null });
    expect(last.deletes).toEqual([chunkId(9)]);
  });

  it('carries exactly the D-03 payload keys and parses the vector', () => {
    const plan = planDocumentSync(TENANT_A, [syncRow(1, { content: 'secret body', document_name: 'secret.md' })], []);
    const [point] = plan.upserts;
    expect(Object.keys(point.payload).sort()).toEqual(D03_KEYS);
    expect(point.vector).toEqual([0.1, 0.2, 0.3]);
    expect(JSON.stringify(point)).not.toContain('secret');
  });
});

describe('planChunkSync', () => {
  it('upserts the chunk when the row exists', () => {
    const plan = planChunkSync(TENANT_A, syncRow(1), chunkId(1));
    expect(plan.upserts.map((p) => p.id)).toEqual([chunkId(1)]);
    expect(plan.deletes).toEqual([]);
  });

  it('deletes the chunk when the row is gone', () => {
    expect(planChunkSync(TENANT_A, null, chunkId(1))).toEqual({ upserts: [], deletes: [chunkId(1)] });
  });

  it('deletes instead of upserting a foreign tenant row', () => {
    expect(planChunkSync(TENANT_A, syncRow(1, { tenant_key: TENANT_B }), chunkId(1))).toEqual({ upserts: [], deletes: [chunkId(1)] });
  });
});

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function scripted(responses: Record<string, RpcResponse>): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          return Promise.resolve(responses[fn] ?? { data: null, error: null }).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

describe('claim wrappers', () => {
  it('claim passes p_limit and p_lease_seconds and returns the rows', async () => {
    const row = { id: 1, target: 'qdrant', entity: 'document', entity_id: DOC, tenant_key: TENANT_A, profile_id: null, cursor: null, attempts: 1, enqueued_at: '2026-01-01T00:00:00Z' };
    const { client, calls } = scripted({ rag_vector_sync_claim: { data: [row], error: null } });
    expect(await claimBatch(client, { limit: 100, leaseSeconds: 120 })).toEqual([row]);
    expect(calls).toEqual([{ fn: 'rag_vector_sync_claim', args: { p_limit: 100, p_lease_seconds: 120 } }]);
  });

  it('complete passes every id of a group', async () => {
    const { client, calls } = scripted({ rag_vector_sync_complete: { data: 3, error: null } });
    expect(await completeRows(client, [1, 2, 3])).toBe(3);
    expect(calls[0]).toEqual({ fn: 'rag_vector_sync_complete', args: { p_ids: [1, 2, 3] } });
  });

  it('fail passes a code of at most 200 characters and returns the state', async () => {
    const { client, calls } = scripted({ rag_vector_sync_fail: { data: 'dead', error: null } });
    expect(await failRow(client, 7, 'x'.repeat(500))).toBe('dead');
    expect(calls[0].fn).toBe('rag_vector_sync_fail');
    expect(calls[0].args.p_id).toBe(7);
    expect(String(calls[0].args.p_error).length).toBeLessThanOrEqual(200);
    expect(String(calls[0].args.p_error).length).toBeGreaterThan(0);
  });

  it('checkpoint and expand pass their arguments', async () => {
    const { client, calls } = scripted({
      rag_vector_sync_checkpoint: { data: true, error: null },
      rag_vector_sync_expand: { data: [{ enqueued: 2, next_cursor: DOC, has_more: true }], error: null },
    });
    expect(await checkpointRow(client, 4, chunkId(9))).toBe(true);
    expect(await expandRow(client, 4, 100)).toEqual({ enqueued: 2, nextCursor: DOC, hasMore: true });
    expect(calls).toEqual([
      { fn: 'rag_vector_sync_checkpoint', args: { p_id: 4, p_cursor: chunkId(9) } },
      { fn: 'rag_vector_sync_expand', args: { p_id: 4, p_limit: 100 } },
    ]);
  });

  it('reads pass the tenant key, profile and paging arguments', async () => {
    const { client, calls } = scripted({
      rag_vector_sync_profiles: { data: [{ profile_id: 'p1', dims: 3, storage: 'halfvec', status: 'active' }], error: null },
      rag_vector_sync_document_rows: { data: [syncRow(1)], error: null },
      rag_vector_sync_chunk_row: { data: [], error: null },
    });
    expect((await readSyncProfiles(client)).map((p) => p.profile_id)).toEqual(['p1']);
    expect(await readDocumentRows(client, { tenantKey: TENANT_A, documentId: DOC, profileId: 'p1', after: null, limit: 100 })).toHaveLength(1);
    expect(await readChunkRow(client, { tenantKey: TENANT_A, chunkId: chunkId(1), profileId: 'p1' })).toBeNull();
    expect(calls.slice(1)).toEqual([
      {
        fn: 'rag_vector_sync_document_rows',
        args: { p_tenant_key: TENANT_A, p_document_id: DOC, p_profile_id: 'p1', p_after: null, p_limit: 100 },
      },
      { fn: 'rag_vector_sync_chunk_row', args: { p_tenant_key: TENANT_A, p_chunk_id: chunkId(1), p_profile_id: 'p1' } },
    ]);
  });

  it.each([
    ['claim', (c: RpcClient) => claimBatch(c, { limit: 1, leaseSeconds: 1 })],
    ['complete', (c: RpcClient) => completeRows(c, [1])],
    ['fail', (c: RpcClient) => failRow(c, 1, 'code')],
    ['checkpoint', (c: RpcClient) => checkpointRow(c, 1, chunkId(1))],
    ['expand', (c: RpcClient) => expandRow(c, 1, 1)],
    ['profiles', (c: RpcClient) => readSyncProfiles(c)],
    ['document rows', (c: RpcClient) => readDocumentRows(c, { tenantKey: TENANT_A, documentId: DOC, profileId: 'p1', after: null, limit: 1 })],
    ['chunk row', (c: RpcClient) => readChunkRow(c, { tenantKey: TENANT_A, chunkId: chunkId(1), profileId: 'p1' })],
  ])('%s throws RetrievalBackendError on an RPC error', async (_name, call) => {
    const error = { data: null, error: { message: 'boom', code: '22023' } };
    const { client } = scripted(
      Object.fromEntries(
        [
          'rag_vector_sync_claim',
          'rag_vector_sync_complete',
          'rag_vector_sync_fail',
          'rag_vector_sync_checkpoint',
          'rag_vector_sync_expand',
          'rag_vector_sync_profiles',
          'rag_vector_sync_document_rows',
          'rag_vector_sync_chunk_row',
        ].map((fn) => [fn, error]),
      ),
    );
    await expect(call(client)).rejects.toBeInstanceOf(RetrievalBackendError);
  });
});
