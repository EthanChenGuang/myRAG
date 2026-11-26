import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { drainSlice } from '@/lib/rag/sync/drain';
import type { VectorStore, VectorSyncTarget } from '@/lib/rag/sync/stores/types';
import { runFixtureRelex } from '../../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, type FakeEdge } from '../../../eval/harness/fake-edge.mts';
import { loadConformanceDataset } from './dataset';

export interface SeedExternalStoreOptions {
  db: PGlite;
  edge: FakeEdge;
  store: VectorStore;
  target: VectorSyncTarget;
  profileId: string;
  /** Upper bound on drain slices before the seed gives up (the dataset needs a handful). */
  maxSlices?: number;
}

export interface SeedExternalStoreResult {
  client: RpcClient;
  slices: number;
  upserted: number;
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await client.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new Error(`[Vector Sync] seed: ${fn} failed (${response.error.code ?? 'rpc_error'})`);
  return response.data;
}

/**
 * Seeds the Phase 4 conformance dataset into an external store the way production does (D-12): the target is enabled before any row
 * is written, the rows go through the database and its outbox triggers, and drainSlice moves them into the store. It never writes to
 * the store directly. Both vendor factories (07-07, 07-08) reuse it with their own store.
 */
export async function seedExternalStore(options: SeedExternalStoreOptions): Promise<SeedExternalStoreResult> {
  const { db, edge, store, target, profileId } = options;
  if (store.target !== target) throw new Error('[Vector Sync] seed: store target differs');
  const env = fixtureProcessEnv(edge.url);
  const client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as RpcClient;

  await call(client, 'rag_vector_sync_set_target', { p_target: target, p_enabled: true, p_actor: 'conformance-seed' });
  const profiles = (await call(client, 'rag_vector_sync_profiles', {})) as Array<{ profile_id: string }>;
  if (!profiles.some((profile) => profile.profile_id === profileId)) throw new Error('[Vector Sync] seed: profile is not synced');

  await loadConformanceDataset(db);
  await runFixtureRelex(db);

  const maxSlices = options.maxSlices ?? 20;
  let upserted = 0;
  for (let slices = 1; slices <= maxSlices; slices += 1) {
    const report = await drainSlice({ store, rpc: client, budgetMs: 60_000, batch: 100 });
    upserted += report.upserted;
    if (report.failed > 0) throw new Error(`[Vector Sync] seed: ${report.failed} outbox rows failed`);
    if (report.claimed === 0) return { client, slices, upserted };
  }
  throw new Error('[Vector Sync] seed: the outbox did not drain');
}
