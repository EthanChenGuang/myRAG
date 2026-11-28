import { describe, expect, it } from 'vitest';
import { ReconcileReportSchema } from '@/lib/rag-eval/contracts.generated';
import { drainUntilEmpty } from '@/lib/rag/sync/drain';
import { RECONCILE_PRUNE_DAYS, bucketOf, idHash64, reconcileSlice } from '@/lib/rag/sync/reconcile';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorStore } from '@/lib/rag/sync/stores/types';
import { createFakeRpc, fakeClock, type FakeChunk, type FakeClock, type FakeRpc } from './fake-rpc';

const TENANT_A = 'u:00000000-0000-4000-8000-0000000000a1';
const TENANT_B = 'u:00000000-0000-4000-8000-0000000000b1';
const TENANT_C = 'u:00000000-0000-4000-8000-0000000000c1';
const PROFILE = 'p1';
const FOREIGN_ID = '00000000-0000-4000-8fff-00000000f00d';
const MARKER = 'neutral-marker-sentence-zz';

/** Copied from tests/rag-db/vector-sync-reconcile.test.mts, where the SQL definition pins them. */
const GOLDEN: Array<[string, number, string]> = [
  ['00000000-0000-4000-8000-000000000001', 5, '5016017787118691403'],
  ['00000000-0000-4000-8000-000000000002', 25, '-7398545041996669218'],
  ['7f3c2a10-1b2c-4d5e-8f60-0123456789ab', 60, '4332796155272647876'],
];

function docId(n: number): string {
  return `00000000-0000-4000-8000-d${n.toString(16).padStart(11, '0')}`;
}

function chunkId(doc: number, n: number): string {
  return `00000000-0000-4000-${(0x8000 + doc).toString(16)}-${n.toString(16).padStart(12, '0')}`;
}

function chunks(doc: number, count: number, tenantKey: string): FakeChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    id: chunkId(doc, i + 1),
    document_id: docId(doc),
    tenant_key: tenantKey,
    vector: [1, 0, i / 1000],
    lexical_text: `token${i}`,
    content: `neutral synthetic sentence ${i}`,
  }));
}

function addDoc(rpc: FakeRpc, n: number, count: number, tenantKey = TENANT_A): void {
  rpc.addDocument({ id: docId(n), tenant_key: tenantKey }, chunks(n, count, tenantKey));
}

const quiet = { sink: () => undefined, trace: false as const };

function setup(): { clock: FakeClock; rpc: FakeRpc; store: FakeVectorStore } {
  const clock = fakeClock();
  return { clock, rpc: createFakeRpc(clock), store: createFakeVectorStore('qdrant') };
}

/** Drains every pending row: the initial full build or the repairs reconcile enqueued. */
async function sync(rpc: FakeRpc, store: FakeVectorStore, clock: FakeClock): Promise<void> {
  await drainUntilEmpty({ store, rpc: rpc.client, now: clock.now, ...quiet });
}

async function buildTenant(rpc: FakeRpc, store: FakeVectorStore, clock: FakeClock, tenantKey: string): Promise<void> {
  rpc.enqueue({ entity: 'tenant', entity_id: tenantKey, tenant_key: tenantKey });
  await sync(rpc, store, clock);
}

function state(rpc: FakeRpc, tenantKey: string): string | undefined {
  return rpc.indexState.get(`qdrant|${PROFILE}|${tenantKey}`)?.state;
}

describe('hash definition', () => {
  it('bucketOf and idHash64 match the SQL golden values', () => {
    for (const [id, bucket, hash] of GOLDEN) {
      expect(bucketOf(id)).toBe(bucket);
      expect(idHash64(id).toString()).toBe(hash);
    }
  });

  it('upper-case ids hash like their lowercase form (uuid::text is lowercase)', () => {
    const [id, bucket, hash] = GOLDEN[2];
    expect(bucketOf(id.toUpperCase())).toBe(bucket);
    expect(idHash64(id.toUpperCase()).toString()).toBe(hash);
  });
});

describe('reconcileSlice', () => {
  it('an in-sync tenant is ready with no repairs', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 5);
    addDoc(rpc, 2, 3);
    await buildTenant(rpc, store, clock, TENANT_A);
    const pendingBefore = rpc.outbox.filter((o) => o.status === 'pending').length;

    const result = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(result.reports).toHaveLength(1);
    const [report] = result.reports;
    expect(ReconcileReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      target: 'qdrant',
      profile_id: PROFILE,
      tenant_key: TENANT_A,
      supabase_count: 8,
      backend_count: 8,
      mismatched_buckets: 0,
      missing: 0,
      extra: 0,
      stale: 0,
      repairs_enqueued: 0,
      state: 'ready',
    });
    expect(state(rpc, TENANT_A)).toBe('ready');
    expect(rpc.outbox.filter((o) => o.status === 'pending').length).toBe(pendingBefore);
  });

  it('drift: a deleted point, a stale payload and an extra foreign point are detected, repaired and end ready', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 6);
    addDoc(rpc, 2, 4);
    await buildTenant(rpc, store, clock, TENANT_A);
    await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(state(rpc, TENANT_A)).toBe('ready');

    // (a) a deleted point of document 1
    await store.deleteIds(PROFILE, TENANT_A, [chunkId(1, 2)]);
    // (b) a stale payload of document 2: same id, different content_hash
    const staleId = chunkId(2, 3);
    const stalePoint = store.points(PROFILE, TENANT_A).find((p) => p.id === staleId)!;
    store.plant(PROFILE, TENANT_A, { ...stalePoint, payload: { ...stalePoint.payload, content_hash: 'h-outdated' } });
    // (c) an extra point with a foreign id
    store.plant(PROFILE, TENANT_A, { id: FOREIGN_ID, vector: [0, 1, 0], payload: { ...stalePoint.payload, document_id: docId(99), content_hash: 'h-foreign' } });
    clock.t += 1000;

    const first = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    const [report] = first.reports;
    expect(report.missing).toBe(1);
    expect(report.stale).toBe(1);
    expect(report.extra).toBe(1);
    expect(report.supabase_count).toBe(10);
    expect(report.backend_count).toBe(10);
    expect(report.mismatched_buckets).toBeGreaterThanOrEqual(1);
    expect(report.repairs_enqueued).toBe(3);
    expect(report.state).toBe('stale');
    expect(state(rpc, TENANT_A)).toBe('stale');
    const repairs = rpc.outbox.filter((o) => o.status === 'pending');
    expect(repairs.map((o) => [o.entity, o.entity_id, o.tenant_key, o.profile_id]).sort()).toEqual(
      [
        ['chunk', FOREIGN_ID, TENANT_A, PROFILE],
        ['document', docId(1), TENANT_A, PROFILE],
        ['document', docId(2), TENANT_A, PROFILE],
      ].sort(),
    );

    await sync(rpc, store, clock);
    clock.t += 1000;
    const second = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(second.reports[0]).toMatchObject({ missing: 0, stale: 0, extra: 0, mismatched_buckets: 0, state: 'ready' });
    expect(state(rpc, TENANT_A)).toBe('ready');
    expect(store.points(PROFILE, TENANT_A).some((p) => p.id === FOREIGN_ID)).toBe(false);
    expect(store.points(PROFILE, TENANT_A).find((p) => p.id === staleId)?.payload.content_hash).toBe(`h-${staleId.slice(-4)}`);
  });

  it('drift with equal counts and equal id sets: a stale lexical_version alone is caught by the content digest', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 4);
    await buildTenant(rpc, store, clock, TENANT_A);
    await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    rpc.chunks.get(chunkId(1, 1))!.lexical_version = 2;
    clock.t += 1000;
    const result = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(result.reports[0]).toMatchObject({ supabase_count: 4, backend_count: 4, stale: 1, missing: 0, extra: 0, state: 'stale' });
  });

  it('a newly enabled tenant with a mismatch stays building until its first match', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 3);
    rpc.indexState.set(`qdrant|${PROFILE}|${TENANT_A}`, {
      target: 'qdrant',
      profile_id: PROFILE,
      tenant_key: TENANT_A,
      state: 'building',
      last_reconciled_at: null,
      supabase_count: null,
      backend_count: null,
      last_error: null,
    });
    const first = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(first.reports[0]).toMatchObject({ supabase_count: 3, backend_count: 0, missing: 3, state: 'building' });
    expect(state(rpc, TENANT_A)).toBe('building');
    await sync(rpc, store, clock);
    clock.t += 1000;
    const second = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(second.reports[0].state).toBe('ready');
  });

  it('a tenant with store points and no servable rows gets a tenant repair and ends empty', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 3, TENANT_B);
    await buildTenant(rpc, store, clock, TENANT_B);
    await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(state(rpc, TENANT_B)).toBe('ready');
    rpc.documents.get(docId(1))!.is_current = false;
    clock.t += 1000;

    const result = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(result.reports[0]).toMatchObject({ tenant_key: TENANT_B, supabase_count: 0, backend_count: 3, extra: 3, state: 'stale' });
    expect(rpc.outbox.some((o) => o.status === 'pending' && o.entity === 'tenant' && o.entity_id === TENANT_B && o.tenant_key === TENANT_B)).toBe(true);

    await sync(rpc, store, clock);
    expect(await store.count(PROFILE, TENANT_B).catch(() => 0)).toBe(0);
    clock.t += 1000;
    const after = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(after.reports[0]).toMatchObject({ supabase_count: 0, backend_count: 0, state: 'ready' });
  });

  it('a store error sets state failed with a code and no content', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2);
    await buildTenant(rpc, store, clock, TENANT_A);
    const broken: VectorStore = {
      ...store,
      target: 'qdrant',
      scanTenant: async () => {
        throw new Error(`store said ${MARKER} ${TENANT_A}`);
      },
    };
    const lines: string[] = [];
    const result = await reconcileSlice({ stores: [broken], rpc: rpc.client, now: clock.now, sink: (line) => lines.push(line), trace: false });
    expect(result.reports[0].state).toBe('failed');
    const row = rpc.indexState.get(`qdrant|${PROFILE}|${TENANT_A}`)!;
    expect(row.state).toBe('failed');
    expect(row.last_error).toBe('store_error');
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(MARKER);
    expect(lines.join('\n')).not.toContain(TENANT_A);
    expect(result.slice.failed).toBe(1);
  });

  it('the slice stops at its budget and the next slice resumes with the least recently reconciled tenant', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2, TENANT_A);
    addDoc(rpc, 2, 2, TENANT_B);
    addDoc(rpc, 3, 2, TENANT_C);
    for (const key of [TENANT_A, TENANT_B, TENANT_C]) await buildTenant(rpc, store, clock, key);
    rpc.onCall = (fn) => {
      if (fn === 'rag_vector_sync_reconcile_summary') clock.t += 10_000;
    };

    const first = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, budgetMs: 15_000, ...quiet });
    expect(first.reports.map((r) => r.tenant_key)).toEqual([TENANT_A, TENANT_B]);
    expect(first.slice.more_pending).toBe(true);
    expect(first.slice.mode).toBe('reconcile');

    const second = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, budgetMs: 15_000, ...quiet });
    expect(second.reports.map((r) => r.tenant_key)).toEqual([TENANT_C, TENANT_A]);

    const third = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, budgetMs: 15_000, ...quiet });
    expect(third.reports[0].tenant_key).toBe(TENANT_B);
  });

  it('calls prune with 7 days once per run, which removes old done rows and keeps dead ones', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2);
    await buildTenant(rpc, store, clock, TENANT_A);
    const done = rpc.outbox.filter((o) => o.status === 'done').length;
    expect(done).toBeGreaterThan(0);
    const dead = rpc.enqueue({ entity: 'chunk', entity_id: chunkId(1, 1), tenant_key: TENANT_A, status: 'dead' });
    clock.t += 8 * 86_400_000;
    rpc.calls.length = 0;

    const result = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    const prunes = rpc.calls.filter((c) => c.fn === 'rag_vector_sync_prune');
    expect(prunes).toHaveLength(1);
    expect(prunes[0].args).toEqual({ p_days: RECONCILE_PRUNE_DAYS });
    expect(RECONCILE_PRUNE_DAYS).toBe(7);
    expect(result.pruned).toBe(done);
    expect(rpc.outbox.some((o) => o.id === dead.id)).toBe(true);
    expect(rpc.outbox.some((o) => o.status === 'done')).toBe(false);
  });

  it('a disabled target is not reconciled and writes no state', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2);
    rpc.enabledTargets.clear();
    const result = await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, ...quiet });
    expect(result.reports).toEqual([]);
    expect(rpc.indexState.size).toBe(0);
  });

  it('logs one [Vector Sync] line with mode reconcile and counts only', async () => {
    const { clock, rpc, store } = setup();
    addDoc(rpc, 1, 2);
    await buildTenant(rpc, store, clock, TENANT_A);
    const lines: string[] = [];
    await reconcileSlice({ stores: [store], rpc: rpc.client, now: clock.now, sink: (line) => lines.push(line), trace: false });
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('[Vector Sync] ')).toBe(true);
    const payload = JSON.parse(lines[0].slice('[Vector Sync] '.length));
    expect(Object.keys(payload).sort()).toEqual(['claimed', 'dead', 'deleted', 'elapsedMs', 'failed', 'lagSeconds', 'mode', 'upserted'].sort());
    expect(payload.mode).toBe('reconcile');
    expect(payload.claimed).toBe(1);
  });
});
