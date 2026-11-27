import { loadRagConfig, type RagConfig } from '../config';
import { getRagDeps } from '../deps';
import { getActiveProfile } from '../embeddings/active-profile';
import type { BackendId } from './types';
import { defaultStoreFactories, readVectorSyncStatus, VECTOR_SYNC_TARGETS, type VectorStoreFactories, type VectorSyncTargetStatus } from '../sync/targets';
import type { VectorStore, VectorSyncTarget } from '../sync/stores/types';
import { rpcRows, RetrievalBackendError, type RpcClient } from './supabase-rpc';

export type IndexCompatCode =
  | 'backend_not_ready'
  | 'dimension_mismatch'
  | 'legacy_pipeline'
  | 'sync_not_enabled'
  | 'dead_letters'
  | 'backend_unreachable';

export interface IndexCompatWarning {
  code: IndexCompatCode;
  backend: VectorSyncTarget;
  /** Numbers, profile ids and fixed codes only: never a tenant key, chunk id, URL or vendor message. */
  detail: Record<string, number | string>;
}

export type IndexStateName = 'building' | 'ready' | 'stale' | 'failed';
export type ProfileStateCounts = { profileId: string } & Record<IndexStateName, number>;

export interface IndexCompatBackend extends VectorSyncTargetStatus {
  selected: boolean;
  profiles: ProfileStateCounts[];
}

export interface IndexCompatReport {
  warnings: IndexCompatWarning[];
  backends: IndexCompatBackend[];
}

export interface IndexCompatInput {
  config: Pick<RagConfig, 'pipeline' | 'backend'>;
  rpc: RpcClient;
  /** Store builders per target; only selected external backends are built. */
  stores: Partial<VectorStoreFactories>;
  activeProfile: { id: string; dims: number };
  /** Upper bound for each external store call (build, health, describe). */
  storeTimeoutMs?: number;
}

export const INDEX_COMPAT_STORE_TIMEOUT_MS = 5_000;
const STATES: readonly IndexStateName[] = ['building', 'ready', 'stale', 'failed'];
const COUNTS_RPC = 'rag_backend_index_state_counts';

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isState(value: unknown): value is IndexStateName {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

/** 0709: tenants per (target, profile, state); counts only. */
async function readStateCounts(rpc: RpcClient): Promise<Map<VectorSyncTarget, Map<string, ProfileStateCounts>>> {
  const response = await rpc.rpc(COUNTS_RPC, {}).abortSignal(new AbortController().signal);
  if (response.error) throw new RetrievalBackendError(COUNTS_RPC, response.error.code ?? null);
  const out = new Map<VectorSyncTarget, Map<string, ProfileStateCounts>>();
  for (const raw of rpcRows(response.data) as Array<Record<string, unknown>>) {
    const target = raw.target;
    if (target !== 'weaviate' && target !== 'qdrant') continue;
    if (typeof raw.profile_id !== 'string' || !isState(raw.state)) continue;
    const perTarget = out.get(target) ?? new Map<string, ProfileStateCounts>();
    out.set(target, perTarget);
    const row = perTarget.get(raw.profile_id) ?? { profileId: raw.profile_id, building: 0, ready: 0, stale: 0, failed: 0 };
    row[raw.state] += count(raw.tenants);
    perTarget.set(raw.profile_id, row);
  }
  return out;
}

function selectedExternal(backend: Pick<RagConfig['backend'], 'default' | 'voice'>): Set<VectorSyncTarget> {
  const out = new Set<VectorSyncTarget>();
  for (const id of [backend.default, backend.voice] as BackendId[]) {
    if (id === 'weaviate' || id === 'qdrant') out.add(id);
  }
  return out;
}

class StoreTimeout extends Error {
  constructor() {
    super('store_timeout');
    this.name = 'StoreTimeout';
  }
}

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StoreTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type StoreProbe =
  | { ok: true; collectionDims: number | null }
  | { ok: false; stage: 'client' | 'health' | 'describe'; reason: 'timeout' | 'error' | 'unhealthy' };

async function probeStore(factory: (() => Promise<VectorStore>) | undefined, profileId: string, ms: number): Promise<StoreProbe> {
  if (!factory) return { ok: false, stage: 'client', reason: 'error' };
  const failure = (stage: 'client' | 'health' | 'describe', error: unknown): StoreProbe => ({
    ok: false,
    stage,
    reason: error instanceof StoreTimeout ? 'timeout' : 'error',
  });
  let store: VectorStore;
  try {
    store = await withTimeout(factory, ms);
  } catch (error) {
    return failure('client', error);
  }
  try {
    const health = await withTimeout(() => store.health(), ms);
    if (!health.ok) return { ok: false, stage: 'health', reason: 'unhealthy' };
  } catch (error) {
    return failure('health', error);
  }
  try {
    const info = await withTimeout(() => store.describeCollection(profileId), ms);
    return { ok: true, collectionDims: info ? info.dims : null };
  } catch (error) {
    return failure('describe', error);
  }
}

/**
 * D-16: the index-compatibility warnings for the Config UI, computed server-side. It warns when a selected external backend is not ready
 * for the active embedding profile (any tenant building, stale or failed), when its collection's dimension differs from the active
 * profile, when it is selected while the pipeline is legacy, when sync is not enabled for it, when it cannot be reached, and when any
 * target has dead outbox rows. Everything returned is a count, a profile id or a code. Database read errors throw.
 */
export async function computeIndexCompat(input: IndexCompatInput): Promise<IndexCompatReport> {
  const timeoutMs = input.storeTimeoutMs ?? INDEX_COMPAT_STORE_TIMEOUT_MS;
  const [status, stateCounts] = await Promise.all([readVectorSyncStatus(input.rpc), readStateCounts(input.rpc)]);
  const selected = selectedExternal(input.config.backend);
  const profileId = input.activeProfile.id;

  const backends: IndexCompatBackend[] = VECTOR_SYNC_TARGETS.map((target) => {
    const row = status.find((entry) => entry.target === target);
    const profiles = [...(stateCounts.get(target)?.values() ?? [])].sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
    return {
      target,
      enabled: row?.enabled ?? false,
      pending: row?.pending ?? 0,
      leased: row?.leased ?? 0,
      dead: row?.dead ?? 0,
      oldestPendingSeconds: row?.oldestPendingSeconds ?? null,
      selected: selected.has(target),
      profiles,
    };
  });

  const probes = new Map<VectorSyncTarget, StoreProbe>();
  await Promise.all(
    [...selected].map(async (target) => {
      probes.set(target, await probeStore(input.stores[target], profileId, timeoutMs));
    }),
  );

  const warnings: IndexCompatWarning[] = [];
  for (const backend of backends) {
    const { target } = backend;
    if (backend.selected) {
      if (input.config.pipeline === 'legacy') {
        warnings.push({ code: 'legacy_pipeline', backend: target, detail: { pipeline: 'legacy' } });
      }
      if (!backend.enabled) {
        warnings.push({ code: 'sync_not_enabled', backend: target, detail: {} });
      } else {
        const active = backend.profiles.find((entry) => entry.profileId === profileId);
        if (active && active.building + active.stale + active.failed > 0) {
          warnings.push({
            code: 'backend_not_ready',
            backend: target,
            detail: { profileId, building: active.building, stale: active.stale, failed: active.failed, ready: active.ready },
          });
        }
      }
      const probe = probes.get(target);
      if (probe && !probe.ok) {
        warnings.push({ code: 'backend_unreachable', backend: target, detail: { stage: probe.stage, reason: probe.reason } });
      } else if (probe && probe.ok && probe.collectionDims !== null && probe.collectionDims !== input.activeProfile.dims) {
        warnings.push({
          code: 'dimension_mismatch',
          backend: target,
          detail: { profileId, profileDims: input.activeProfile.dims, collectionDims: probe.collectionDims },
        });
      }
    }
    if (backend.dead > 0) {
      warnings.push({ code: 'dead_letters', backend: target, detail: { dead: backend.dead } });
    }
  }
  return { warnings, backends };
}

/** D-15 caveat: when the app process loaded .env.local (Next.js reads it at process start), so the Config UI can show a later edit. */
export function envLoadedAt(): string {
  const startedMs = Date.now() - Math.round(process.uptime() * 1000);
  return new Date(Math.floor(startedMs / 1000) * 1000).toISOString();
}

export type IndexCompatView = IndexCompatReport & { envLoadedAt: string };

/**
 * The route's entry point: the loaded config, the admin client and the active embedding profile from the app's dependencies, the
 * vendor stores built lazily. Null when the admin client is unavailable (the route then fails closed); read errors throw.
 */
export async function readIndexCompat(options: { stores?: Partial<VectorStoreFactories> } = {}): Promise<IndexCompatView | null> {
  const deps = getRagDeps();
  let rpc: RpcClient | null;
  try {
    rpc = deps.adminClient() as unknown as RpcClient | null;
  } catch {
    rpc = null;
  }
  if (!rpc) return null;
  const config = loadRagConfig(deps.ragEnv());
  const profile = await getActiveProfile();
  const report = await computeIndexCompat({
    config,
    rpc,
    stores: options.stores ?? defaultStoreFactories,
    activeProfile: { id: profile.id, dims: profile.dims },
  });
  return { ...report, envLoadedAt: envLoadedAt() };
}
