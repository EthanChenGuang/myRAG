import { describe, expect, it } from 'vitest';
import { drainUntilEmpty } from '@/lib/rag/sync/drain';
import { reconcileSlice } from '@/lib/rag/sync/reconcile';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorPoint, VectorStore } from '@/lib/rag/sync/stores/types';
import { createFakeRpc, fakeClock, type FakeChunk, type FakeClock, type FakeRpc } from './fake-rpc';

const TENANT_A = 'u:00000000-0000-4000-8000-0000000000a1';
const TENANT_B = 'u:00000000-0000-4000-8000-0000000000b1';
const RETIRED = 'p-retired';
const LINEAGE = '00000000-0000-4000-8000-00000000f0aa';

function docId(n: number): string {
  return `00000000-0000-4000-8000-d${n.toString(16).padStart(11, '0')}`;
}

function purgedId(n: number): string {
  return `00000000-0000-4000-8000-e${n.toString(16).padStart(11, '0')}`;
}

function chunks(doc: number, count: number, tenantKey: string): FakeChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-${(0x8000 + doc).toString(16)}-${(i + 1).toString(16).padStart(12, '0')}`,
    document_id: docId(doc),
    tenant_key: tenantKey,
    vector: [1, 0, i / 1000],
    lexical_text: `token${i}`,
    content: `neutral synthetic sentence ${i}`,
  }));
}

function planted(n: number, tenantKey: string, documentId: string): VectorPoint {
  return {
    id: `00000000-0000-4000-9fff-${n.toString(16).padStart(12, '0')}`,
    vector: [1, 0, 0],
    payload: {
      tenant_key: tenantKey,
      document_id: documentId,
      doc_type: 'general',
      doc_date: null,
      language: 'en',
      source: 'upload',
      chunking_profile_id: null,
      parent_id: null,
      lexical_text: 'neutral words',
      content_hash: 'h',
      lexical_version: 1,
      access_groups: ['all'],
    },
  };
}

const quiet = { sink: () => undefined, trace: false as const };

/** Two synced profiles, tenants A and B with one document each, fully built and reconciled ready. */
async function setup(): Promise<{ clock: FakeClock; rpc: FakeRpc; store: FakeVectorStore }> {
  const clock = fakeClock();
  const rpc = createFakeRpc(clock);
  rpc.profiles = [
    { profile_id: 'p1', dims: 3, storage: 'halfvec' },
    { profile_id: 'p2', dims: 3, storage: 'halfvec' },
  ];
  const store = createFakeVectorStore('qdrant');
  await store.ensureCollection({ profileId: RETIRED, dims: 3 });
  rpc.addDocument({ id: docId(1), tenant_key: TENANT_A }, chunks(1, 3, TENANT_A));
  rpc.addDocument({ id: docId(2), tenant_key: TENANT_B }, chunks(2, 2, TENANT_B));
  for (const key of [TENANT_A, TENANT_B]) rpc.enqueue({ entity: 'tenant', entity_id: key, tenant_key: key });
  await drainUntilEmpty({ store, rpc: rpc.client, now: clock.now, ...quiet });
  await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
  for (const s of rpc.indexState.values()) expect(s.state).toBe('ready');
  return { clock, rpc, store };
}

function stateOf(rpc: FakeRpc, profileId: string, tenantKey: string) {
  return rpc.indexState.get(`qdrant|${profileId}|${tenantKey}`);
}

describe('reconcile keeps purged documents absent (RET-05 delta)', () => {
  it('a done purge whose documents have no point anywhere changes nothing; the tenant stays ready', async () => {
    const { clock, rpc, store } = await setup();
    rpc.addPurge({ tenant_key: TENANT_A, lineage_id: LINEAGE, document_ids: [purgedId(1), purgedId(2)], status: 'done' });
    rpc.calls.length = 0;
    const { reports } = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(reports.every((r) => r.state === 'ready')).toBe(true);
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_purge_reopen')).toHaveLength(0);
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_purged_documents').map((c) => c.args.p_tenant_key).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );
    expect(rpc.outbox.filter((o) => o.status === 'pending')).toHaveLength(0);
  });

  it('purged_points_present: a reappeared point in a retired collection re-opens the purge and makes every synced profile stale', async () => {
    const { clock, rpc, store } = await setup();
    const purge = rpc.addPurge({ tenant_key: TENANT_A, lineage_id: LINEAGE, document_ids: [purgedId(1), purgedId(2)], status: 'done' });
    store.plant(RETIRED, TENANT_A, planted(1, TENANT_A, purgedId(2)));
    rpc.calls.length = 0;

    const { reports } = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    const reopens = rpc.calls.filter((c) => c.fn === 'rag_vector_sync_purge_reopen');
    expect(reopens.map((c) => c.args)).toEqual([{ p_purge_id: purge.id, p_target: 'qdrant' }]);
    expect(purge.targets.get('qdrant')).toBe('pending');
    expect(rpc.outbox.filter((o) => o.entity === 'purge' && o.status === 'pending').map((o) => o.entity_id)).toEqual([purge.id]);

    for (const profileId of ['p1', 'p2']) {
      expect(stateOf(rpc, profileId, TENANT_A)?.state).toBe('stale');
      expect(stateOf(rpc, profileId, TENANT_B)?.state).toBe('ready');
    }
    const staleWrites = rpc.calls.filter(
      (c) => c.fn === 'rag_set_backend_index_state' && c.args.p_tenant_key === TENANT_A && c.args.p_state === 'stale',
    );
    expect([...new Set(staleWrites.map((c) => c.args.p_profile_id))].sort()).toEqual(['p1', 'p2']);
    for (const c of staleWrites) expect(c.args.p_error).toBe('purged_points_present');
    expect(reports.filter((r) => r.tenant_key === TENANT_A).every((r) => r.state === 'stale')).toBe(true);
    expect(reports.filter((r) => r.tenant_key === TENANT_B).every((r) => r.state === 'ready')).toBe(true);
    // Reconcile never deletes: the point stays until the drain runs the re-opened purge.
    expect(store.points(RETIRED, TENANT_A)).toHaveLength(1);

    await drainUntilEmpty({ store, rpc: rpc.client, now: clock.now, ...quiet });
    expect(store.points(RETIRED, TENANT_A)).toHaveLength(0);
    expect(purge.targets.get('qdrant')).toBe('done');
    await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    for (const profileId of ['p1', 'p2']) expect(stateOf(rpc, profileId, TENANT_A)?.state).toBe('ready');
  });

  it('purged_points_present: a purged point in a synced collection is stale for every synced profile and re-opens the purge', async () => {
    const { clock, rpc, store } = await setup();
    const purge = rpc.addPurge({ tenant_key: TENANT_A, lineage_id: LINEAGE, document_ids: [purgedId(3)], status: 'done' });
    // A point of a purged document in the synced p1 collection of tenant A, written outside the drain.
    store.plant('p1', TENANT_A, planted(2, TENANT_A, purgedId(3)));
    await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(stateOf(rpc, 'p1', TENANT_A)?.state).toBe('stale');
    expect(stateOf(rpc, 'p2', TENANT_A)?.state).toBe('stale');
    expect(purge.targets.get('qdrant')).toBe('pending');
  });

  it('2,500 purged ids are paged within the slice budget and the check resumes on the next slice', async () => {
    const { clock, rpc, store } = await setup();
    rpc.profiles = [{ profile_id: 'p1', dims: 3, storage: 'halfvec' }];
    const ids = Array.from({ length: 2500 }, (_, i) => purgedId(i + 1));
    const purges = [ids.slice(0, 1000), ids.slice(1000, 2000), ids.slice(2000)].map((chunk, i) =>
      rpc.addPurge({ tenant_key: TENANT_A, lineage_id: `00000000-0000-4000-8000-00000000f0b${i}`, document_ids: chunk, status: 'done' }),
    );
    store.plant(RETIRED, TENANT_A, planted(3, TENANT_A, ids[2400]));
    rpc.onCall = (fn, args) => {
      if (fn === 'rag_vector_sync_purged_documents' && args.p_tenant_key === TENANT_A) clock.t += 30_000;
    };
    rpc.calls.length = 0;
    const first = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, budgetMs: 45_000, ...quiet });
    const pagesA = () => rpc.calls.filter((c) => c.fn === 'rag_vector_sync_purged_documents' && c.args.p_tenant_key === TENANT_A);
    expect(pagesA().map((c) => c.args.p_after)).toEqual([null, ids[999]]);
    expect(first.slice.more_pending).toBe(true);
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_purge_reopen')).toHaveLength(0);

    rpc.calls.length = 0;
    await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, budgetMs: 45_000, ...quiet });
    expect(pagesA()[0]?.args.p_after).toBe(ids[1999]);
    expect(rpc.calls.filter((c) => c.fn === 'rag_vector_sync_purge_reopen').map((c) => c.args.p_purge_id)).toEqual([purges[2].id]);
    expect(stateOf(rpc, 'p1', TENANT_A)?.state).toBe('stale');
  });

  it('a store error during the check writes state failed with its code', async () => {
    const { clock, rpc, store } = await setup();
    rpc.addPurge({ tenant_key: TENANT_A, lineage_id: LINEAGE, document_ids: [purgedId(1)], status: 'done' });
    const broken: VectorStore = {
      ...store,
      countDocumentPoints: async () => {
        throw new Error('vendor message that must not be stored');
      },
    };
    const { reports } = await reconcileSlice({ stores: [broken], rpc: rpc.client, now: clock.now, ...quiet });
    for (const profileId of ['p1', 'p2']) {
      expect(stateOf(rpc, profileId, TENANT_A)?.state).toBe('failed');
      expect(stateOf(rpc, profileId, TENANT_A)?.last_error).toBe('store_error');
    }
    expect(reports.filter((r) => r.tenant_key === TENANT_A).every((r) => r.state === 'failed')).toBe(true);
  });
});
