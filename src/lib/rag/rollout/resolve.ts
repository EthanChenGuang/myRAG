import { createHash } from 'node:crypto';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import type { RagConfig } from '../config';
import { getRagDeps } from '../deps';
import { getEmbeddingProfileById, isEmbeddingProfilesEnabled, type EmbeddingProfile } from '../embeddings/active-profile';
import { scopeKey, type TenantScope } from '../tenant/scope';

/** LANG-11 (plan 07-47): per-tenant rollouts of an embedding profile, chunking profiles or a rebuild run. */
export type RolloutKind = 'embedding_profile' | 'chunking_profile' | 'rebuild_run';
export type RolloutArm = 'candidate' | 'incumbent';

export interface ActiveRollout {
  id: string;
  kind: RolloutKind;
  mode: 'tenants' | 'share';
  sharePercent: number | null;
  salt: string;
  included: readonly string[];
  excluded: readonly string[];
  embeddingProfileId?: string;
  /** chunking_profile only: the candidate profiles as the {doc_type: profile_id} map the search override takes. */
  chunkingMap?: Readonly<Record<string, string>>;
}

/** The arm one tenant is on. Query-side fields are set only on the candidate arm. */
export interface RolloutResolution {
  rolloutId: string;
  kind: RolloutKind;
  arm: RolloutArm;
  embeddingProfileId?: string;
  chunkingOverride?: Record<string, string>;
}

export const ROLLOUT_CACHE_TTL_MS = 30_000;
const READ_TIMEOUT_MS = 2_000;
const ACTIVE_RPC = 'rag_rollout_active';
const KINDS: readonly string[] = ['embedding_profile', 'chunking_profile', 'rebuild_run'];
const SALT = /^[A-Za-z0-9_-]{8,128}$/;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

let cache: { at: number; rollouts: ActiveRollout[] } | null = null;
let inflight: Promise<ActiveRollout[]> | null = null;
let warned = false;

/** The share bucket 0..99: the first 8 hex digits of sha256(salt ':' key) mod 100, as rag_rollout_bucket computes it. */
export function rolloutBucket(salt: string, tenantKey: string): number {
  const hex = createHash('sha256').update(`${salt}:${tenantKey}`, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

/** Exclusion first, then inclusion, then the share bucket. */
export function inCandidateArm(rollout: Pick<ActiveRollout, 'mode' | 'sharePercent' | 'salt' | 'included' | 'excluded'>, tenantKey: string): boolean {
  if (rollout.excluded.includes(tenantKey)) return false;
  if (rollout.included.includes(tenantKey)) return true;
  return rollout.mode === 'share' && rollout.sharePercent !== null && rolloutBucket(rollout.salt, tenantKey) < rollout.sharePercent;
}

function keys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string' && TENANT_KEY.test(key)) : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function parseActiveRollout(raw: unknown): ActiveRollout | null {
  const row = record(raw);
  if (!row || typeof row.id !== 'string' || typeof row.kind !== 'string' || !KINDS.includes(row.kind)) return null;
  if ((row.mode !== 'tenants' && row.mode !== 'share') || typeof row.salt !== 'string' || !SALT.test(row.salt)) return null;
  const share = row.share_percent === null || row.share_percent === undefined ? null : Number(row.share_percent);
  if (row.mode === 'share' && (share === null || !Number.isInteger(share) || share < 0 || share > 100)) return null;
  const rollout: ActiveRollout = {
    id: row.id,
    kind: row.kind as RolloutKind,
    mode: row.mode,
    sharePercent: row.mode === 'share' ? share : null,
    salt: row.salt,
    included: keys(row.included_tenants),
    excluded: keys(row.excluded_tenants),
  };
  const candidate = record(row.candidate_ref);
  if (rollout.kind === 'embedding_profile') {
    if (typeof candidate?.embedding_profile_id !== 'string') return null;
    rollout.embeddingProfileId = candidate.embedding_profile_id;
  }
  if (rollout.kind === 'chunking_profile') {
    const map = record(row.chunking_map);
    if (!map) return null;
    const entries = Object.entries(map).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    rollout.chunkingMap = Object.freeze(Object.fromEntries(entries));
  }
  return rollout;
}

async function readActive(client: RpcClient): Promise<ActiveRollout[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('rollout_read_timeout'));
    }, READ_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([Promise.resolve(client.rpc(ACTIVE_RPC, {}).abortSignal(controller.signal)), timeout]);
    if (response.error) throw new Error('rollout_read_failed');
    return rpcRows(response.data)
      .map(parseActiveRollout)
      .filter((rollout): rollout is ActiveRollout => rollout !== null);
  } finally {
    clearTimeout(timer);
  }
}

/** The active rollouts, cached in process for at most 30 seconds. */
export async function activeRollouts(): Promise<ActiveRollout[]> {
  const deps = getRagDeps();
  if (cache) {
    const age = deps.now() - cache.at;
    if (age >= 0 && age < ROLLOUT_CACHE_TTL_MS) return cache.rollouts;
  }
  if (inflight) return inflight;
  const admin = deps.adminClient();
  if (!admin) return [];
  const at = deps.now();
  const run = readActive(admin as unknown as RpcClient)
    .then((rollouts) => {
      cache = { at, rollouts };
      return rollouts;
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

/**
 * The query-side arm of the request's tenant: the active embedding_profile and chunking_profile rollouts. Null while RAG_ROLLOUTS is
 * off (no read at all) or when no query-side rollout is active. The arm comes from the verified scope and the rollout tables only.
 * A rollout read that fails serves the incumbent (no rollout) and logs one [RAG Rollout] warning per process.
 */
export async function resolveRolloutArm(
  scope: TenantScope,
  config: Pick<RagConfig, 'rollouts'>,
): Promise<RolloutResolution[] | null> {
  if (!config.rollouts.enabled) return null;
  let rollouts: ActiveRollout[];
  try {
    rollouts = await activeRollouts();
  } catch {
    if (!warned) {
      warned = true;
      console.warn('[RAG Rollout] active rollouts unavailable; the incumbent serves', { code: 'rollout_read_failed' });
    }
    return null;
  }
  const tenantKey = scopeKey(scope);
  const resolved: RolloutResolution[] = [];
  for (const rollout of rollouts) {
    if (rollout.kind === 'rebuild_run') continue;
    const candidate = inCandidateArm(rollout, tenantKey);
    const entry: RolloutResolution = { rolloutId: rollout.id, kind: rollout.kind, arm: candidate ? 'candidate' : 'incumbent' };
    if (candidate && rollout.embeddingProfileId) entry.embeddingProfileId = rollout.embeddingProfileId;
    if (candidate && rollout.chunkingMap && Object.keys(rollout.chunkingMap).length > 0) entry.chunkingOverride = { ...rollout.chunkingMap };
    resolved.push(entry);
  }
  return resolved.length > 0 ? resolved : null;
}

/**
 * The candidate embedding profile the request embeds with. A candidate profile that cannot serve (RAG_EMBEDDING_PROFILES off, unknown,
 * or no longer backfilling or active) moves that resolution to the incumbent arm, so the span never names an arm that did not serve.
 */
export async function resolveRolloutQueryProfile(
  resolutions: RolloutResolution[] | null,
): Promise<{ resolutions: RolloutResolution[]; profile?: EmbeddingProfile } | null> {
  if (!resolutions) return null;
  const candidateId = rolloutEmbeddingProfileId(resolutions);
  if (!candidateId) return { resolutions };
  let profile: EmbeddingProfile | undefined;
  if (isEmbeddingProfilesEnabled()) {
    try {
      const found = await getEmbeddingProfileById(candidateId);
      if (found.status === 'backfilling' || found.status === 'active') profile = found;
    } catch {
      profile = undefined;
    }
  }
  if (profile) return { resolutions, profile };
  return {
    resolutions: resolutions.map((entry) => {
      if (entry.kind !== 'embedding_profile' || entry.arm !== 'candidate') return entry;
      return { rolloutId: entry.rolloutId, kind: entry.kind, arm: 'incumbent' };
    }),
  };
}

/** The candidate embedding profile of a resolution, if the tenant is on that arm. */
export function rolloutEmbeddingProfileId(resolutions: readonly RolloutResolution[] | null | undefined): string | undefined {
  return resolutions?.find((entry) => entry.kind === 'embedding_profile' && entry.arm === 'candidate')?.embeddingProfileId;
}

/** The candidate chunking override of a resolution, if the tenant is on that arm. */
export function rolloutChunkingOverride(resolutions: readonly RolloutResolution[] | null | undefined): Record<string, string> | undefined {
  return resolutions?.find((entry) => entry.kind === 'chunking_profile' && entry.arm === 'candidate')?.chunkingOverride;
}

/** The span detail: `rollout=<id>:<arm>` per resolution, ids and arms only. */
export function rolloutDetail(resolutions: readonly RolloutResolution[] | null | undefined): string | undefined {
  if (!resolutions || resolutions.length === 0) return undefined;
  return resolutions.map((entry) => `rollout=${entry.rolloutId}:${entry.arm}`).join(' ');
}

let legacyWarned = false;

/** Under RAG_PIPELINE=legacy rollouts are ignored; one [RAG Config] line per process. */
export function warnRolloutsIgnoredOnLegacy(config: Pick<RagConfig, 'rollouts'>): void {
  if (legacyWarned || !config.rollouts.enabled) return;
  legacyWarned = true;
  console.warn('[RAG Config] RAG_ROLLOUTS needs RAG_PIPELINE=v2; rollouts are ignored and the active profiles serve');
}

export function resetRolloutCacheForTests(): void {
  cache = null;
  inflight = null;
  warned = false;
  legacyWarned = false;
}
