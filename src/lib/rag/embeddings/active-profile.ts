import { env } from '@/lib/env';
import type { RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { getIngestDeps } from '../ingest/deps';
import { loadIngestConfig } from '../ingest/config';
import { canonicalModelId, getEmbeddingProvider } from './registry';
import type { EmbeddingProvider, EmbeddingStorage } from './types';

export type EmbeddingProfileState = 'available' | 'backfilling' | 'active' | 'retired';

export interface EmbeddingProfile {
  id: string;
  provider: string;
  model: string;
  dims: number;
  storage: EmbeddingStorage;
  status: EmbeddingProfileState;
  queryInstruction: string | null;
  scoreCalibration: Record<string, number>;
  activatedAt: string | null;
  activatedBy: string | null;
  previousActiveId: string | null;
  hasEvidence: boolean;
}

export type ProfileUnavailableReason =
  | 'no_admin_client'
  | 'read_failed'
  | 'read_timeout'
  | 'no_active_profile'
  | 'multiple_active_profiles'
  | 'malformed_active_profile'
  | 'rpc_failed';

/** The registry could not give a pointer. Callers must not fall back to the legacy profile on this. */
export class ProfileUnavailableError extends Error {
  readonly reason: ProfileUnavailableReason;
  readonly code: string | null;

  constructor(reason: ProfileUnavailableReason, code: string | null = null) {
    super(`[Embedding Profile] registry unavailable (${reason}${code ? `, ${code}` : ''})`);
    this.name = 'ProfileUnavailable';
    this.reason = reason;
    this.code = code;
  }
}

export const LEGACY_PROFILE: EmbeddingProfile = Object.freeze({
  id: 'openai-3-small-1536',
  provider: 'openai',
  model: 'text-embedding-3-small',
  dims: 1536,
  storage: 'legacy_column',
  status: 'active',
  queryInstruction: null,
  scoreCalibration: Object.freeze({
    retrieval_threshold: 0.7,
    context_threshold: 0.65,
    fallback_threshold: 0.28,
    context_image_threshold: 0.25,
  }),
  activatedAt: null,
  activatedBy: null,
  previousActiveId: null,
  hasEvidence: false,
});

export type StartupMismatchReason = 'provider_unconfigured' | 'model_mismatch' | 'dims_unsupported';

export type StartupVerdict =
  | { status: 'unknown'; reason: 'not_checked' | 'timeout' | 'profile_unavailable'; checkedAt: number | null }
  | { status: 'skipped'; checkedAt: number }
  | { status: 'ok'; profile: string; model: string; dims: number; checkedAt: number }
  | { status: 'mismatch'; reason: StartupMismatchReason; profile: string; model: string; dims: number; checkedAt: number };

export const PROFILE_CACHE_TTL_MS = 30_000;
export const STARTUP_CHECK_TIMEOUT_MS = 3_000;
const READ_TIMEOUT_MS = 5_000;
const LIST_RPC = 'rag_list_embedding_profiles';
const STATUSES: readonly string[] = ['available', 'backfilling', 'active', 'retired'];
const STORAGES: readonly string[] = ['legacy_column', 'halfvec'];

interface Snapshot {
  at: number;
  profiles: EmbeddingProfile[];
  active: EmbeddingProfile;
}

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
let generation = 0;
let verdict: StartupVerdict = { status: 'unknown', reason: 'not_checked', checkedAt: null };
let startupRun: Promise<StartupVerdict> | null = null;

/** The deployment switch: off means the pointer is ignored and the legacy profile is used everywhere. */
export function isEmbeddingProfilesEnabled(): boolean {
  return loadIngestConfig(getIngestDeps().ingestEnv()).embeddingProfiles === 'on';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseCalibration(value: unknown): Record<string, number> {
  const source = asRecord(value);
  const out: Record<string, number> = {};
  if (!source) return out;
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

export function parseProfileRow(raw: unknown): EmbeddingProfile | null {
  const row = asRecord(raw);
  if (!row) return null;
  const { id, provider, model, dims, storage, status } = row;
  if (typeof id !== 'string' || id === '' || typeof provider !== 'string' || typeof model !== 'string') return null;
  if (typeof dims !== 'number' || !Number.isInteger(dims) || dims < 1) return null;
  if (typeof storage !== 'string' || !STORAGES.includes(storage)) return null;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null;
  return {
    id,
    provider,
    model,
    dims,
    storage: storage as EmbeddingStorage,
    status: status as EmbeddingProfileState,
    queryInstruction: nullableString(row.query_instruction),
    scoreCalibration: parseCalibration(row.score_calibration),
    activatedAt: nullableString(row.activated_at),
    activatedBy: nullableString(row.activated_by),
    previousActiveId: nullableString(row.previous_active_id),
    hasEvidence: row.has_evidence === true,
  };
}

/** The admin client the registry functions need; they are executable by the server role only. */
export function requireRegistryClient(): RpcClient {
  const admin = getRagDeps().adminClient();
  if (!admin) throw new ProfileUnavailableError('no_admin_client');
  return admin as unknown as RpcClient;
}

async function readProfiles(): Promise<EmbeddingProfile[]> {
  const client = requireRegistryClient();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProfileUnavailableError('read_timeout'));
    }, READ_TIMEOUT_MS);
  });

  let response;
  try {
    response = await Promise.race([Promise.resolve(client.rpc(LIST_RPC, {}).abortSignal(controller.signal)), timeout]);
  } catch (error) {
    if (error instanceof ProfileUnavailableError) throw error;
    throw new ProfileUnavailableError('read_failed');
  } finally {
    clearTimeout(timer);
  }
  if (response.error) throw new ProfileUnavailableError('read_failed', response.error.code ?? null);

  const profiles: EmbeddingProfile[] = [];
  let malformedActive = false;
  for (const raw of response.data ?? []) {
    const profile = parseProfileRow(raw);
    if (profile) profiles.push(profile);
    else if (asRecord(raw)?.status === 'active') malformedActive = true;
  }
  if (malformedActive) throw new ProfileUnavailableError('malformed_active_profile');
  return profiles;
}

function pickActive(profiles: EmbeddingProfile[]): EmbeddingProfile {
  const active = profiles.filter((profile) => profile.status === 'active');
  if (active.length === 0) throw new ProfileUnavailableError('no_active_profile');
  if (active.length > 1) throw new ProfileUnavailableError('multiple_active_profiles');
  return active[0];
}

function startRead(): Promise<Snapshot> {
  const startedGeneration = generation;
  const at = getRagDeps().now();
  const run = readProfiles()
    .then((profiles) => {
      const snapshot: Snapshot = { at, profiles, active: pickActive(profiles) };
      if (startedGeneration === generation) cache = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

async function snapshot(): Promise<Snapshot> {
  if (cache) {
    const age = getRagDeps().now() - cache.at;
    if (age >= 0 && age < PROFILE_CACHE_TTL_MS) return cache;
  }
  return inflight ?? startRead();
}

function invalidate(): void {
  generation += 1;
  cache = null;
  inflight = null;
}

/** Every profile row, read fresh and bypassing the cache. For operator status views only. */
export async function listEmbeddingProfiles(): Promise<EmbeddingProfile[]> {
  return readProfiles();
}

/**
 * The profile queries and writes must use. Off returns the legacy constant with no database read; on reads the registry through
 * rag_list_embedding_profiles and caches it for at most 30 seconds. A registry that cannot be read throws ProfileUnavailableError.
 */
export async function getActiveProfile(): Promise<EmbeddingProfile> {
  if (!isEmbeddingProfilesEnabled()) return LEGACY_PROFILE;
  return (await snapshot()).active;
}

/** Drops the cache and reads the pointer again. */
export async function refreshActiveProfile(): Promise<EmbeddingProfile> {
  if (!isEmbeddingProfilesEnabled()) return LEGACY_PROFILE;
  invalidate();
  return (await startRead()).active;
}

/** Profiles that receive dual-writes while they are being backfilled. */
export async function getBackfillingProfiles(): Promise<EmbeddingProfile[]> {
  if (!isEmbeddingProfilesEnabled()) return [];
  return (await snapshot()).profiles.filter((profile) => profile.status === 'backfilling');
}

/** Called after a gate operation: the pointer or the backfilling set may have changed. Never throws. */
export async function refreshAfterOperation(): Promise<void> {
  try {
    await refreshActiveProfile();
  } catch {
    invalidate();
  }
}

export function getStartupVerdict(): StartupVerdict {
  return verdict;
}

const KEY_BY_PROVIDER: Record<string, () => unknown> = {
  openai: () => env.OPENAI_API_KEY,
  voyage: () => env.VOYAGE_API_KEY,
  qwen3: () => env.DEEPINFRA_API_KEY,
};

/** Presence only: the value is never read into a log line. */
function providerKeyConfigured(providerId: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(KEY_BY_PROVIDER, providerId)) return true;
  const value = KEY_BY_PROVIDER[providerId]();
  return typeof value === 'string' && value.trim() !== '';
}

function mismatchReason(profile: EmbeddingProfile): StartupMismatchReason | null {
  let provider: EmbeddingProvider;
  try {
    provider = getEmbeddingProvider(profile.provider);
  } catch {
    return 'provider_unconfigured';
  }
  if (!providerKeyConfigured(profile.provider)) return 'provider_unconfigured';
  if (canonicalModelId(provider.model) !== canonicalModelId(profile.model)) return 'model_mismatch';
  if (!provider.supportedDims.includes(profile.dims)) return 'dims_unsupported';
  return null;
}

type CheckOutcome =
  | { kind: 'done'; profile: EmbeddingProfile; reason: StartupMismatchReason | null }
  | { kind: 'failed'; error: unknown };

async function evaluateActiveProfile(): Promise<CheckOutcome> {
  try {
    const profile = await getActiveProfile();
    return { kind: 'done', profile, reason: mismatchReason(profile) };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

async function runStartupCheck(timeoutMs: number): Promise<StartupVerdict> {
  const now = () => getRagDeps().now();
  if (!isEmbeddingProfilesEnabled()) {
    verdict = { status: 'skipped', checkedAt: now() };
    return verdict;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([evaluateActiveProfile(), timeout]);
  clearTimeout(timer);

  if (outcome === 'timeout') {
    console.warn(`[Embedding Profile] STARTUP CHECK TIMEOUT ${JSON.stringify({ timeoutMs })}`);
    verdict = { status: 'unknown', reason: 'timeout', checkedAt: now() };
    return verdict;
  }
  if (outcome.kind === 'failed') {
    const reason = outcome.error instanceof ProfileUnavailableError ? outcome.error.reason : 'check_failed';
    console.warn(`[Embedding Profile] STARTUP CHECK UNAVAILABLE ${JSON.stringify({ reason })}`);
    verdict = { status: 'unknown', reason: 'profile_unavailable', checkedAt: now() };
    return verdict;
  }

  const { profile, reason } = outcome;
  if (reason) {
    console.error(`[Embedding Profile] MISMATCH ${JSON.stringify({ profile: profile.id, model: profile.model, dims: profile.dims, reason })}`);
    verdict = { status: 'mismatch', reason, profile: profile.id, model: profile.model, dims: profile.dims, checkedAt: now() };
    return verdict;
  }
  verdict = { status: 'ok', profile: profile.id, model: profile.model, dims: profile.dims, checkedAt: now() };
  return verdict;
}

/**
 * The startup consistency check. With the switch off it only records a skipped verdict. With it on, it loads the active profile and
 * checks that the provider is configured and that its model and supported dims fit the profile. It is time-boxed, never throws, logs
 * at most one line per instance and stores the verdict for the per-request path.
 */
export function verifyActiveEmbeddingProfileAtStartup(options: { timeoutMs?: number } = {}): Promise<StartupVerdict> {
  if (!startupRun) {
    startupRun = runStartupCheck(options.timeoutMs ?? STARTUP_CHECK_TIMEOUT_MS).catch(() => {
      verdict = { status: 'unknown', reason: 'profile_unavailable', checkedAt: getRagDeps().now() };
      return verdict;
    });
  }
  return startupRun;
}

export function resetActiveProfileForTests(): void {
  invalidate();
  verdict = { status: 'unknown', reason: 'not_checked', checkedAt: null };
  startupRun = null;
}
