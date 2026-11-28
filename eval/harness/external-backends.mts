import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import type { RpcClient } from '../../src/lib/rag/backend/supabase-rpc.ts';
import type { VectorStore } from '../../src/lib/rag/sync/stores/types.ts';
import type { RunManifest } from '../../src/lib/rag-eval/contracts.generated.ts';
import { fixtureProcessEnv, type FakeEdge } from './fake-edge.mts';

export type ExternalBackendId = 'weaviate' | 'qdrant';
export type RunBackendSnapshot = NonNullable<RunManifest['backend_snapshot']>;

/** The pgvector HNSW settings of the setup files (m=64, ef_construction=200) and its lexical leg. */
export const PGVECTOR_SNAPSHOT: RunBackendSnapshot = {
  backend: 'pgvector',
  backend_impl: 'real',
  collection: null,
  hnsw_m: 64,
  hnsw_ef_construction: 200,
  lexical_mode: 'postgres_fts',
  quantization: 'none',
};

const URL_ENV: Record<ExternalBackendId, string> = { qdrant: 'QDRANT_URL', weaviate: 'WEAVIATE_URL' };
const SEED_ACTOR = 'eval-harness';
const MAX_ROUNDS = 10;

/** One database the eval serves (the fixture database, or an isolated tenant served by swapping the edge's database). */
export interface ExternalSeedDatabase {
  db: PGlite;
  /** Runs fn while the edge serves this database; the home database needs none. */
  serve?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface PrepareExternalBackendsOptions {
  db: PGlite;
  edge: FakeEdge;
  backends: readonly ExternalBackendId[];
  /** The embedding profile the run searches; it names the collection in the snapshot. */
  profileId: string;
  /** Isolated tenant databases the run also serves (q62). */
  extraDatabases?: ExternalSeedDatabase[];
  /** Test seam: wraps each store before it is used (writer recording). */
  wrapStore?: (store: VectorStore) => VectorStore;
  /** Test only: writes this index state for every (target, profile, tenant) after the seed, so readiness reads not ready. */
  indexStateForTests?: 'stale';
}

export interface PreparedExternalBackends {
  snapshot: RunBackendSnapshot;
  /** Per backend: real when its URL is set, fake otherwise. */
  impl: Record<string, 'real' | 'fake'>;
  close(): Promise<void>;
}

function adminRpc(edge: FakeEdge): RpcClient {
  const env = fixtureProcessEnv(edge.url);
  return createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as RpcClient;
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await client.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new Error(`[Eval Harness] external backend seed: ${fn} failed (${response.error.code ?? 'rpc_error'})`);
  return response.data;
}

function hasUrl(id: ExternalBackendId): boolean {
  return (process.env[URL_ENV[id]] ?? '').trim() !== '';
}

async function buildStore(id: ExternalBackendId, real: boolean): Promise<VectorStore> {
  if (!real) {
    const { createFakeVectorStore } = await import('../../src/lib/rag/sync/stores/fake.ts');
    return createFakeVectorStore(id);
  }
  // Keys are read from the environment by the client modules (write key for the store); nothing here records them.
  if (id === 'qdrant') {
    const [{ getQdrantWriteClient }, { createQdrantStore }] = await Promise.all([
      import('../../src/lib/rag/backend/qdrant/client.ts'),
      import('../../src/lib/rag/sync/stores/qdrant.ts'),
    ]);
    return createQdrantStore({ writeClient: getQdrantWriteClient() });
  }
  const [{ getWeaviateWriteClient }, { createWeaviateStore }] = await Promise.all([
    import('../../src/lib/rag/backend/weaviate/client.ts'),
    import('../../src/lib/rag/sync/stores/weaviate.ts'),
  ]);
  return createWeaviateStore({ client: await getWeaviateWriteClient() });
}

async function snapshotOf(id: ExternalBackendId, impl: 'real' | 'fake', profileId: string): Promise<RunBackendSnapshot> {
  const { backendIndexParams } = await import('../../src/lib/rag/backend/index-params.ts');
  const params = backendIndexParams(id, profileId);
  if (!params) throw new Error(`[Eval Harness] no index parameters for backend ${id}`);
  return {
    backend: id,
    backend_impl: impl,
    collection: params.collection,
    hnsw_m: params.hnsw_m,
    hnsw_ef_construction: params.hnsw_ef,
    lexical_mode: params.lexical_mode,
    quantization: params.quantization,
  };
}

/**
 * D-12 seeding: enable each target, which enqueues the backfill of every current document through the outbox, drain it, and run
 * reconcileSlice until every (target, profile, tenant) is ready, draining whatever the reconcile enqueues. The store is never
 * written directly.
 */
async function seedDatabase(rpc: RpcClient, stores: VectorStore[]): Promise<void> {
  const { drainUntilEmpty, reconcileSlice } = await import('../../src/lib/rag/index.ts');
  const quiet = { sink: () => undefined, trace: false as const };
  for (const store of stores) await call(rpc, 'rag_vector_sync_set_target', { p_target: store.target, p_enabled: true, p_actor: SEED_ACTOR });
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const drained = await drainUntilEmpty({ stores, rpc, budgetMs: 60_000, batch: 200, maxSlices: 200, ...quiet });
    const failed = drained.reduce((sum, report) => sum + (report.failed ?? 0), 0);
    if (failed > 0) throw new Error(`[Eval Harness] external backend seed: ${failed} outbox rows failed`);
    const reconciled = await reconcileSlice({ stores, rpc, budgetMs: 60_000, ...quiet });
    const notReady = reconciled.reports.filter((report) => report.state !== 'ready');
    if (notReady.length === 0 && !reconciled.slice.more_pending) return;
  }
  throw new Error('[Eval Harness] external backend seed: the stores did not reach ready');
}

async function forceIndexState(db: PGlite, targets: readonly string[], state: 'stale'): Promise<void> {
  await db.query('UPDATE public.rag_backend_index_state SET state = $1 WHERE target = ANY($2::text[])', [state, targets]);
}

/**
 * D-06, D-12, D-17: makes the run's external backends answer through resolveRetrievalBackend, the production selection path. A
 * backend whose URL env var is set uses the real store (write key) and the production adapter (read key); otherwise the in-process
 * fake store is installed through the factory's test setter (harness only). Returns the run manifest's backend snapshot.
 */
export async function prepareExternalBackends(options: PrepareExternalBackendsOptions): Promise<PreparedExternalBackends> {
  const { db, edge, backends, profileId } = options;
  if (backends.length === 0) return { snapshot: PGVECTOR_SNAPSHOT, impl: {}, close: async () => undefined };
  const [factory, external, deps, readiness] = await Promise.all([
    import('../../src/lib/rag/backend/factory.ts'),
    import('../../src/lib/rag/backend/external.ts'),
    import('../../src/lib/rag/deps.ts'),
    import('../../src/lib/rag/backend/readiness.ts'),
  ]);
  const impl: Record<string, 'real' | 'fake'> = {};
  const stores: VectorStore[] = [];
  const installed: ExternalBackendId[] = [];
  for (const id of [...new Set(backends)]) {
    const real = hasUrl(id);
    impl[id] = real ? 'real' : 'fake';
    const raw = await buildStore(id, real);
    const store = options.wrapStore ? options.wrapStore(raw) : raw;
    stores.push(store);
    if (!real) {
      factory.setExternalBackendForTests(
        id,
        external.createExternalBackend({
          reader: store,
          adminClient: () => deps.getRagDeps().adminClient() as unknown as RpcClient | null,
          securityLog: () => undefined,
        }),
      );
      installed.push(id);
    }
  }
  const close = async () => {
    for (const id of installed) factory.setExternalBackendForTests(id, null);
    readiness.resetReadinessCacheForTests();
  };
  try {
    const rpc = adminRpc(edge);
    const databases: ExternalSeedDatabase[] = [{ db }, ...(options.extraDatabases ?? [])];
    for (const entry of databases) {
      const run = () => seedDatabase(rpc, stores);
      await (entry.serve ? entry.serve(run) : run());
      if (options.indexStateForTests) await forceIndexState(entry.db, stores.map((store) => store.target), options.indexStateForTests);
    }
    readiness.resetReadinessCacheForTests();
  } catch (error) {
    await close();
    throw error;
  }
  const first = [...new Set(backends)][0]!;
  return { snapshot: await snapshotOf(first, impl[first]!, profileId), impl, close };
}
