import { describe, expect, it } from 'vitest';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { drainSlice, drainUntilEmpty } from '@/lib/rag/sync/drain';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorPoint, VectorStore } from '@/lib/rag/sync/stores/types';
import { createFakeRpc, fakeClock, type FakeChunk, type FakeClock, type FakeRpc } from './fake-rpc';

const TENANT_A = 'u:00000000-0000-4000-8000-0000000000a1';
const TENANT_B = 'u:00000000-0000-4000-8000-0000000000b1';
const PROFILE = 'p1';

function docId(n: number): string {
  return `00000000-0000-4000-8000-d${n.toString(16).padStart(11, '0')}`;
}

function chunkId(doc: number, n: number): string {
  return `00000000-0000-4000-${(0x8000 + doc).toString(16)}-${n.toString(16).padStart(12, '0')}`;
}

function chunks(doc: number, count: number, tenantKey = TENANT_A): FakeChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    id: chunkId(doc, i + 1),
    document_id: docId(doc),
    tenant_key: tenantKey,
    vector: [1, 0, i / 1000],
    lexical_text: `token${i}`,
    content: `neutral synthetic sentence ${i}`,
  }));
}

function setup(): { clock: FakeClock; rpc: FakeRpc; store: FakeVectorStore } {
  const clock = fakeClock();
  const rpc = createFakeRpc(clock);
  const store = createFakeVectorStore('qdrant');
  return { clock, rpc, store };
}

function ids(store: FakeVectorStore, tenantKey: string): string[] {
  return store.points(PROFILE, tenantKey).map((p) => p.id);
}

function addDoc(rpc: FakeRpc, n: number, count: number, tenantKey = TENANT_A, docType = 'general'): void {
  rpc.addDocument({ id: docId(n), tenant_key: tenantKey, doc_type: docType }, chunks(n, count, tenantKey));
}

const quiet = { sink: () => undefined };

describe('drainSlice', () => {
  it('coalesces three rows for one document: processed once, all three ids completed', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 3);
    const rows = [1, 2, 3].map(() => rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A, attempts: 1 }));
    const report = await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(report.claimed).toBe(3);
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_document_rows')).toHaveLength(1);
    const complete = rpc.calls.filter((c) => c.fn === 'rag_vector_sync_complete');
    expect(complete).toHaveLength(1);
    expect((complete[0].args.p_ids as number[]).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    expect(ids(store, TENANT_A)).toHaveLength(3);
  });

  it('pages a 250-row document and finishes in one slice when the budget allows', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 250);
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    const report = await drainSlice({ store, rpc: rpc.client, now: clock.now, pageSize: 100, ...quiet });
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_document_rows')).toHaveLength(3);
    expect(report.upserted).toBe(250);
    expect(ids(store, TENANT_A)).toHaveLength(250);
    expect(report.more_pending).toBe(false);
  });

  it('cursor: a budget spent mid-document checkpoints the last id without an attempt and the next slice resumes from it', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 250);
    const stale = chunkId(1, 260);
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    store.plant(PROFILE, TENANT_A, pointFor(stale, docId(1)));
    const row = rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    let pages = 0;
    rpc.onCall = (fn) => {
      if (fn === 'rag_vector_sync_document_rows' && ++pages === 1) clock.t += 50_000;
    };
    const first = await drainSlice({ store, rpc: rpc.client, now: clock.now, pageSize: 100, ...quiet });
    expect(first.more_pending).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.cursor).toContain(chunkId(1, 100));
    expect(ids(store, TENANT_A)).toHaveLength(101);

    rpc.onCall = null;
    const afters: Array<unknown> = [];
    const before = rpc.calls.length;
    const second = await drainSlice({ store, rpc: rpc.client, now: clock.now, pageSize: 100, ...quiet });
    for (const call of rpc.calls.slice(before)) if (call.fn === 'rag_vector_sync_document_rows') afters.push(call.args.p_after);
    expect(afters).toEqual([chunkId(1, 100), chunkId(1, 200)]);
    expect(second.upserted).toBe(150);
    expect(row.status).toBe('done');
    expect(ids(store, TENANT_A)).toEqual(chunks(1, 250).map((c) => c.id));
  });

  it('quarantine deletes every point of the document in that tenant; release re-upserts them', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 4);
    addDoc(rpc, 2, 2);
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    rpc.enqueue({ entity: 'document', entity_id: docId(2), tenant_key: TENANT_A });
    await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(ids(store, TENANT_A)).toHaveLength(6);

    (rpc.documents.get(docId(1)) as { status: string }).status = 'quarantined';
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    const q = await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(q.deleted).toBe(4);
    expect(ids(store, TENANT_A)).toEqual(chunks(2, 2).map((c) => c.id));

    (rpc.documents.get(docId(1)) as { status: string }).status = 'ready';
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(ids(store, TENANT_A)).toHaveLength(6);
  });

  it('a tenant move deletes the old tenant points under the old key and upserts under the new key', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 3);
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(ids(store, TENANT_A)).toHaveLength(3);

    (rpc.documents.get(docId(1)) as { tenant_key: string }).tenant_key = TENANT_B;
    for (const c of rpc.chunks.values()) c.tenant_key = TENANT_B;
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_B });
    await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(ids(store, TENANT_A)).toEqual([]);
    expect(ids(store, TENANT_B)).toHaveLength(3);
    expect(store.points(PROFILE, TENANT_B).every((p) => p.payload.tenant_key === TENANT_B)).toBe(true);
  });

  it('a tenant row expands into document rows in pages', async () => {
    const { clock, rpc, store } = setup();
    for (let n = 1; n <= 5; n += 1) addDoc(rpc, n, 1);
    addDoc(rpc, 9, 1, TENANT_B);
    rpc.enqueue({ entity: 'tenant', entity_id: TENANT_A, tenant_key: TENANT_A });
    await drainUntilEmpty({ store, rpc: rpc.client, now: clock.now, pageSize: 2, ...quiet });
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_expand').length).toBeGreaterThanOrEqual(3);
    expect(ids(store, TENANT_A)).toHaveLength(5);
    expect(store.points(PROFILE, TENANT_B)).toEqual([]);
    expect(rpc.outbox.every((o) => o.status === 'done')).toBe(true);
  });

  it('a tenant with no servable rows left is removed with deleteTenant', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2);
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    rpc.documents.clear();
    rpc.chunks.clear();
    const calls: string[] = [];
    const spy: VectorStore = { ...store, deleteTenant: async (p, t) => (calls.push(t), store.deleteTenant(p, t)) };
    rpc.enqueue({ entity: 'tenant', entity_id: TENANT_A, tenant_key: TENANT_A });
    const report = await drainSlice({ store: spy, rpc: rpc.client, now: clock.now, ...quiet });
    expect(calls).toEqual([TENANT_A]);
    expect(report.deleted).toBe(2);
    expect((await store.describeCollection(PROFILE))?.tenants).toBe(0);
  });

  it('a chunking:<doc_type> profile row expands into the documents of that type across tenants', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 1, TENANT_A, 'type_x');
    addDoc(rpc, 2, 1, TENANT_B, 'type_x');
    addDoc(rpc, 3, 1, TENANT_A, 'type_y');
    rpc.enqueue({ entity: 'profile', entity_id: 'chunking:type_x', tenant_key: null });
    await drainUntilEmpty({ store, rpc: rpc.client, now: clock.now, ...quiet });
    const docs = rpc.outbox.filter((o) => o.entity === 'document').map((o) => o.entity_id).sort();
    expect(docs).toEqual([docId(1), docId(2)]);
    expect(ids(store, TENANT_A)).toEqual([chunkId(1, 1)]);
    expect(ids(store, TENANT_B)).toEqual([chunkId(2, 1)]);
  });

  it('a chunk row upserts when servable and deletes otherwise', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2);
    rpc.enqueue({ entity: 'chunk', entity_id: chunkId(1, 1), tenant_key: TENANT_A });
    await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(ids(store, TENANT_A)).toEqual([chunkId(1, 1)]);
    rpc.chunks.delete(chunkId(1, 1));
    rpc.enqueue({ entity: 'chunk', entity_id: chunkId(1, 1), tenant_key: TENANT_A });
    const report = await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(report.deleted).toBe(1);
    expect(ids(store, TENANT_A)).toEqual([]);
  });

  it('a store error fails the group with a code; the eighth failure is dead and counted', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 1);
    const broken: VectorStore = {
      ...store,
      upsert: async () => {
        throw new Error('neutral synthetic sentence that must not be stored');
      },
    };
    const row = rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    let dead = 0;
    let failed = 0;
    for (let i = 0; i < 8; i += 1) {
      const report = await drainSlice({ store: broken, rpc: rpc.client, now: clock.now, ...quiet });
      failed += report.failed;
      dead += report.dead;
      clock.t += 4_000_000;
    }
    expect(failed).toBe(8);
    expect(dead).toBe(1);
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/^[a-z0-9_.:-]+$/);
    expect(row.last_error).not.toContain('sentence');
  });

  it('a missing tenant on upsert creates the tenant once and retries within the slice', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2);
    const created = new Set<string>();
    let ensures = 0;
    const strict: VectorStore = {
      ...store,
      ensureTenant: async (p, t) => {
        ensures += 1;
        created.add(t);
        await store.ensureTenant(p, t);
      },
      upsert: async (p, t, points: VectorPoint[]) => {
        if (!created.has(t)) throw new BackendNotReadyError('weaviate', 'tenant_missing');
        return store.upsert(p, t, points);
      },
    };
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    const report = await drainSlice({ store: strict, rpc: rpc.client, now: clock.now, ...quiet });
    expect(ensures).toBe(1);
    expect(report.failed).toBe(0);
    expect(ids(store, TENANT_A)).toHaveLength(2);
  });

  it('stops claiming after the budget and reports more_pending; drainUntilEmpty empties the outbox', async () => {
    const { clock, rpc, store } = setup();
    for (let n = 1; n <= 6; n += 1) {
      addDoc(rpc, n, 1);
      rpc.enqueue({ entity: 'document', entity_id: docId(n), tenant_key: TENANT_A });
    }
    rpc.onCall = (fn) => {
      if (fn === 'rag_vector_sync_claim') clock.t += 30_000;
    };
    const report = await drainSlice({ store, rpc: rpc.client, now: clock.now, batch: 2, budgetMs: 45_000, ...quiet });
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_claim')).toHaveLength(2);
    expect(report.claimed).toBe(4);
    expect(report.more_pending).toBe(true);
    const reports = await drainUntilEmpty({ store, rpc: rpc.client, now: clock.now, batch: 2, ...quiet });
    expect(reports[reports.length - 1].more_pending).toBe(false);
    expect(rpc.outbox.every((o) => o.status === 'done')).toBe(true);
    expect(ids(store, TENANT_A)).toHaveLength(6);
  });

  it('a group not started when the budget runs out is handed back without an attempt', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 1);
    addDoc(rpc, 2, 1);
    rpc.enqueue({ entity: 'document', entity_id: docId(1), tenant_key: TENANT_A });
    const second = rpc.enqueue({ entity: 'document', entity_id: docId(2), tenant_key: TENANT_A });
    rpc.onCall = (fn) => {
      if (fn === 'rag_vector_sync_document_rows') clock.t += 50_000;
    };
    const report = await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_document_rows')).toHaveLength(1);
    expect(report.more_pending).toBe(true);
    expect(second.status).toBe('pending');
    expect(second.attempts).toBe(0);
    rpc.onCall = null;
    await drainSlice({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(second.status).toBe('done');
    expect(ids(store, TENANT_A)).toHaveLength(2);
  });
});

function pointFor(id: string, documentId: string): VectorPoint {
  return {
    id,
    vector: [0, 1, 0],
    payload: {
      tenant_key: TENANT_A,
      document_id: documentId,
      doc_type: 'general',
      doc_date: null,
      language: 'en',
      source: 'upload',
      chunking_profile_id: null,
      parent_id: null,
      lexical_text: null,
      content_hash: null,
      lexical_version: 1,
    },
  };
}
