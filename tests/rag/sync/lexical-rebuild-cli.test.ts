import { describe, expect, it, vi } from 'vitest';
import type { LexicalParams } from '@/lib/rag/backend/lexical-params';
import { qdrantCollectionName, weaviateCollectionName, weaviateTenantName } from '@/lib/rag/backend/tenant-key';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { main } from '@/lib/rag/sync/cli';
import { drainUntilEmpty } from '@/lib/rag/sync/drain';
import { createQdrantStore } from '@/lib/rag/sync/stores/qdrant';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import type { VectorStore, VectorSyncTarget } from '@/lib/rag/sync/stores/types';
import type { VectorStoreFactories } from '@/lib/rag/sync/targets';
import { createFakeQdrantClient } from '../backend/qdrant-fake-client';
import { createFakeWeaviate } from '../backend/weaviate-fake';
import { createFakeRpc, fakeClock, type FakeChunk, type FakeRpc } from './fake-rpc';

const PROFILE = 'p1';
const TENANT_A = 'u:00000000-0000-4000-8000-0000000000a1';
const TENANT_B = 'u:00000000-0000-4000-8000-0000000000b1';
const DEFAULTS: LexicalParams = { k1: 1.2, b: 0.75 };
const RAISED: LexicalParams = { k1: 1.5, b: 0.75 };
const READ_ONLY_RPCS = new Set(['rag_vector_sync_profiles', 'rag_vector_sync_status']);

function chunkId(doc: number, n: number): string {
  return `00000000-0000-4000-8000-${String(doc * 100 + n).padStart(12, '0')}`;
}

function docId(n: number): string {
  return `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
}

function chunks(doc: number, count: number, tenantKey: string): FakeChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    id: chunkId(doc, i + 1),
    document_id: docId(doc),
    tenant_key: tenantKey,
    vector: [0.1 * (i + 1), 0.2, 0.3],
    lexical_text: `neutral token ${i}`,
    content: `neutral sentence ${i}`,
  }));
}

/** The fake RPC plus rag_vector_sync_status, which the CLI reads for the enabled targets. */
function withStatus(rpc: FakeRpc): RpcClient {
  return {
    rpc(fn, args) {
      if (fn !== 'rag_vector_sync_status') return rpc.client.rpc(fn, args);
      rpc.calls.push({ fn, args: args ?? {} });
      const rows = (['weaviate', 'qdrant'] as const).map((target) => ({
        target,
        enabled: rpc.enabledTargets.has(target),
        pending: 0,
        leased: 0,
        dead: 0,
        oldest_pending_seconds: null,
      }));
      const answer: RpcResponse = { data: rows, error: null };
      const req: RpcRequest = { abortSignal: () => req, then: (ok, bad) => Promise.resolve(answer).then(ok, bad) };
      return req;
    },
  };
}

interface Harness {
  rpc: FakeRpc;
  client: RpcClient;
  configured: { pair: LexicalParams };
  factories: VectorStoreFactories;
  out: string[];
  err: string[];
  run(args: string[]): Promise<number>;
}

async function harness(target: VectorSyncTarget, makeStore: (pair: () => LexicalParams) => VectorStore): Promise<Harness> {
  const clock = fakeClock();
  const rpc = createFakeRpc(clock, { target });
  rpc.addDocument({ id: docId(1), tenant_key: TENANT_A }, chunks(1, 3, TENANT_A));
  rpc.addDocument({ id: docId(2), tenant_key: TENANT_B }, chunks(2, 2, TENANT_B));
  const configured = { pair: DEFAULTS };
  const store = makeStore(() => configured.pair);
  const quiet = { sink: () => undefined, trace: false as const };
  rpc.enqueue({ entity: 'tenant', entity_id: TENANT_A, tenant_key: TENANT_A });
  rpc.enqueue({ entity: 'tenant', entity_id: TENANT_B, tenant_key: TENANT_B });
  await drainUntilEmpty({ store, rpc: rpc.client, now: clock.now, ...quiet });
  const client = withStatus(rpc);
  const factories = { [target]: async () => store } as unknown as VectorStoreFactories;
  const out: string[] = [];
  const err: string[] = [];
  rpc.calls.length = 0;
  return {
    rpc,
    client,
    configured,
    factories,
    out,
    err,
    run: (args) => main(['vector-sync', 'rebuild-lexical', ...args], { out: (l) => out.push(l), err: (l) => err.push(l) }, { rpc: client, factories }),
  };
}

function weaviateHarness() {
  const fake = createFakeWeaviate();
  return harness('weaviate', (pair) => createWeaviateStore({ client: fake, lexicalParams: pair, warn: () => undefined })).then((h) => ({ ...h, fake }));
}

function qdrantHarness() {
  const fake = createFakeQdrantClient();
  return harness('qdrant', (pair) => createQdrantStore({ writeClient: fake, lexicalParams: pair, log: () => undefined })).then((h) => ({ ...h, fake }));
}

function writes(rpc: FakeRpc): string[] {
  return rpc.calls.map((c) => c.fn).filter((fn) => !READ_ONLY_RPCS.has(fn));
}

function objectsIn(fake: ReturnType<typeof createFakeWeaviate>, tenantKey: string): number {
  return fake.collectionsByName.get(weaviateCollectionName(PROFILE))?.tenants.get(weaviateTenantName(tenantKey))?.size ?? 0;
}

describe('rag:vector-sync rebuild-lexical (LEX-05)', () => {
  it('dry run writes nothing: one line per profile with both pairs, exit 2', async () => {
    const h = await weaviateHarness();
    h.configured.pair = RAISED;
    h.fake.calls.length = 0;
    expect(await h.run(['--target', 'weaviate'])).toBe(2);
    expect(h.out[0]).toContain(weaviateCollectionName(PROFILE));
    expect(h.out[0]).toContain('recorded k1 1.2, b 0.75');
    expect(h.out[0]).toContain('configured k1 1.5, b 0.75');
    expect(h.out[0]).toContain('would rebuild');
    expect(h.out.at(-1)).toContain('every tenant of this profile is served by pgvector until the rebuild finishes');
    expect(h.fake.calls.filter((c) => c.op.startsWith('collections.') || c.op === 'insertMany' || c.op === 'tenants.create')).toEqual([]);
    expect(writes(h.rpc)).toEqual([]);
    expect([...h.out, ...h.err].join('\n')).not.toMatch(/u:0000/);
    expect(objectsIn(h.fake, TENANT_A)).toBe(3);
  });

  it('rebuilt collection carries the configured pair and every tenant is ready again', async () => {
    const h = await weaviateHarness();
    h.configured.pair = RAISED;
    h.fake.calls.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await h.run(['--target', 'weaviate', '--confirm'])).toBe(0);
    const ops = h.fake.calls.map((c) => c.op);
    expect(ops.indexOf('collections.delete')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('collections.delete')).toBeLessThan(ops.indexOf('collections.create'));
    const created = JSON.parse(JSON.stringify(h.fake.calls.find((c) => c.op === 'collections.create')!.args)) as Record<string, unknown>;
    expect((created.invertedIndex as { bm25: unknown }).bm25).toEqual({ k1: 1.5, b: 0.75 });
    expect(JSON.parse(String(created.description)).lexical_bm25).toEqual({ k1: 1.5, b: 0.75 });
    expect(objectsIn(h.fake, TENANT_A)).toBe(3);
    expect(objectsIn(h.fake, TENANT_B)).toBe(2);
    expect(h.fake.calls.filter((c) => c.op === 'tenants.create').map((c) => c.tenant).sort()).toEqual(
      [weaviateTenantName(TENANT_A), weaviateTenantName(TENANT_B)].sort(),
    );
    const states = [...h.rpc.indexState.values()].filter((s) => s.target === 'weaviate').map((s) => s.state);
    expect(states).toEqual(['ready', 'ready']);
    expect([...h.out, ...h.err].join('\n')).not.toMatch(/u:0000/);
    vi.restoreAllMocks();
  });

  it('matching collection is left alone', async () => {
    const h = await weaviateHarness();
    h.fake.calls.length = 0;
    expect(await h.run(['--target', 'weaviate', '--confirm'])).toBe(0);
    expect(h.out[0]).toContain('matches');
    expect(h.fake.calls.some((c) => c.op === 'collections.delete' || c.op === 'collections.create')).toBe(false);
    expect(writes(h.rpc)).toEqual([]);
    expect(objectsIn(h.fake, TENANT_A)).toBe(3);
  });

  it('a disabled target is refused with the backfill message and nothing is dropped', async () => {
    const h = await weaviateHarness();
    h.configured.pair = RAISED;
    h.rpc.enabledTargets.clear();
    h.fake.calls.length = 0;
    expect(await h.run(['--target', 'weaviate', '--confirm'])).toBe(1);
    expect(h.err.join('\n')).toContain('weaviate is disabled; run targets enable weaviate first');
    expect(h.fake.calls.some((c) => c.op === 'collections.delete')).toBe(false);
  });

  it('query-bound qdrant: the dry run says refresh, the confirmed run refreshes the record and drops nothing', async () => {
    const h = await qdrantHarness();
    h.configured.pair = RAISED;
    expect(await h.run(['--target', 'qdrant'])).toBe(2);
    expect(h.out[0]).toContain(qdrantCollectionName(PROFILE));
    expect(h.out[0]).toContain('would refresh the record');
    h.fake.requests.length = 0;
    expect(await h.run(['--target', 'qdrant', '--confirm'])).toBe(0);
    const methods = h.fake.requests.map((r) => r.method);
    expect(methods).toContain('updateCollection');
    expect(methods).not.toContain('deleteCollection');
    expect(methods).not.toContain('createCollection');
    const meta = (h.fake.collections.get(qdrantCollectionName(PROFILE))!.config.metadata ?? {}) as Record<string, unknown>;
    expect(meta.lexical_bm25).toEqual({ k1: 1.5, b: 0.75 });
    expect(h.fake.collections.get(qdrantCollectionName(PROFILE))!.points.size).toBe(5);
  });

  it('any other argument shape is a usage error', async () => {
    const h = await weaviateHarness();
    for (const args of [[], ['--target'], ['--target', 'pgvector'], ['--confirm'], ['--target', 'weaviate', '--confirm', '--confirm'], ['--target', 'weaviate', '--force']]) {
      h.err.length = 0;
      expect(await h.run(args)).toBe(2);
      expect(h.err.join('\n')).toContain('rebuild-lexical');
    }
    expect(writes(h.rpc)).toEqual([]);
  });
});
