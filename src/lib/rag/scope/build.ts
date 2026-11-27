import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { getActiveProfile, parseProfileRow, type EmbeddingProfile } from '../embeddings/active-profile';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { invalidateCentroidCacheForKey, type ScopeGroupKind } from './centroids';

/**
 * D-25, D-34: rebuilds one tenant's scope centroids for one embedding profile through rag_scope_centroids_rebuild (0983) on the
 * admin client, with the tenant key as the only tenant input (D-30), then drops that tenant's cache entries. Optionally re-embeds
 * the tenant's out-of-scope examples stored under other profiles into the target profile. Logs carry counts and codes only.
 */
export type ScopeRebuildCounts = Record<ScopeGroupKind, { groups: number; chunks: number }>;

export interface ScopeRebuildResult {
  tenantKey: string;
  profileId: string;
  counts: ScopeRebuildCounts;
  examples: { reembedded: number; skipped: number; failed: number };
  durationMs: number;
}

export interface ScopeRebuildOptions {
  /** Defaults to the active embedding profile. */
  profile?: EmbeddingProfile;
  signal?: AbortSignal;
  /** Re-embed examples stored under other profiles into the target profile (the CLI); the post-publish hook leaves it off. */
  reembedExamples?: boolean;
}

export type ScopeRebuildErrorCode = 'admin_unavailable' | 'profile_unavailable' | 'rebuild_failed';

export class ScopeRebuildError extends Error {
  readonly code: ScopeRebuildErrorCode;
  readonly sqlState: string | null;

  constructor(code: ScopeRebuildErrorCode, sqlState: string | null = null) {
    super(`[Scope Gate] ${code}${sqlState ? ` (${sqlState})` : ''}`);
    this.name = 'ScopeRebuildError';
    this.code = code;
    this.sqlState = sqlState;
  }
}

const KINDS: readonly ScopeGroupKind[] = ['doc_type', 'scope_tag', 'tenant'];
const running = new Map<string, number>();

export function scopeAdminClient(): RpcClient {
  const admin = getRagDeps().adminClient() as unknown as RpcClient | null;
  if (!admin) throw new ScopeRebuildError('admin_unavailable');
  return admin;
}

export async function scopeProfile(profile?: EmbeddingProfile): Promise<EmbeddingProfile> {
  if (profile) return profile;
  try {
    return await getActiveProfile();
  } catch {
    throw new ScopeRebuildError('profile_unavailable');
  }
}

/** Case- and whitespace-folded text, the same key the SQL duplicate rule uses. */
export function exampleTextKey(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

/** Embeds example text with the given profile as a query; throws when the provider fails or answers the wrong dims. */
export async function embedExampleText(text: string, profile: EmbeddingProfile, signal: AbortSignal): Promise<number[]> {
  const deps = getRagDeps();
  const vector = profile.storage === 'legacy_column' ? await deps.embedder(text, { signal }) : (await deps.profileEmbedder(text, { signal, profile })).vector;
  if (!Array.isArray(vector) || vector.length !== profile.dims || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('embedding dims mismatch');
  }
  return vector;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function withSignal(client: RpcClient, fn: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const request = client.rpc(fn, args);
  return signal ? request.abortSignal(signal) : request;
}

async function reembedExamples(
  client: RpcClient,
  tenantKey: string,
  target: EmbeddingProfile,
  signal: AbortSignal,
): Promise<ScopeRebuildResult['examples']> {
  const result = { reembedded: 0, skipped: 0, failed: 0 };
  const profiles = await withSignal(client, 'rag_list_embedding_profiles', {}, signal);
  if (profiles.error) {
    result.failed += 1;
    return result;
  }
  const sources = rpcRows(profiles.data)
    .map(parseProfileRow)
    .filter((profile): profile is EmbeddingProfile => profile !== null && profile.id !== target.id);
  const current = await withSignal(client, 'rag_scope_examples_list', { p_tenant_key: tenantKey, p_profile_id: target.id }, signal);
  if (current.error) {
    result.failed += 1;
    return result;
  }
  const have = new Set<string>();
  for (const raw of rpcRows(current.data)) {
    const row = asRecord(raw);
    if (row && typeof row.text === 'string') have.add(exampleTextKey(row.text));
  }
  for (const source of sources) {
    const listed = await withSignal(client, 'rag_scope_examples_list', { p_tenant_key: tenantKey, p_profile_id: source.id }, signal);
    if (listed.error) {
      result.failed += 1;
      continue;
    }
    for (const raw of rpcRows(listed.data)) {
      const row = asRecord(raw);
      if (!row || typeof row.text !== 'string' || typeof row.created_by !== 'string') continue;
      const key = exampleTextKey(row.text);
      if (have.has(key)) {
        result.skipped += 1;
        continue;
      }
      let vector: number[];
      try {
        vector = await embedExampleText(row.text, target, signal);
      } catch {
        result.failed += 1;
        continue;
      }
      const added = await withSignal(
        client,
        'rag_scope_example_add',
        { p_tenant_key: tenantKey, p_profile_id: target.id, p_text: row.text, p_embedding: vectorLiteral(vector), p_actor: row.created_by },
        signal,
      );
      if (added.error) {
        if (added.error.code === '23505') {
          have.add(key);
          result.skipped += 1;
          continue;
        }
        result.failed += 1;
        if (added.error.code === '54000') return result;
        continue;
      }
      have.add(key);
      result.reembedded += 1;
    }
  }
  return result;
}

/** Whether a rebuild for the scope's tenant is running in this process (any caller). */
export function isScopeRebuildRunning(scope: TenantScope): boolean {
  return (running.get(scopeKey(scope)) ?? 0) > 0;
}

export async function rebuildScopeCentroids(scope: TenantScope, options: ScopeRebuildOptions = {}): Promise<ScopeRebuildResult> {
  const tenantKey = scopeKey(scope);
  const client = scopeAdminClient();
  const profile = await scopeProfile(options.profile);
  const startedAt = getRagDeps().now();
  running.set(tenantKey, (running.get(tenantKey) ?? 0) + 1);
  try {
    const response = await withSignal(client, 'rag_scope_centroids_rebuild', { p_tenant_key: tenantKey, p_profile_id: profile.id }, options.signal);
    if (response.error) throw new ScopeRebuildError('rebuild_failed', response.error.code ?? null);
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, { groups: 0, chunks: 0 }])) as ScopeRebuildCounts;
    for (const raw of rpcRows(response.data)) {
      const row = asRecord(raw);
      const kind = row?.group_kind;
      if (row && typeof kind === 'string' && (KINDS as readonly string[]).includes(kind)) {
        counts[kind as ScopeGroupKind] = { groups: count(row.groups), chunks: count(row.chunks) };
      }
    }
    invalidateCentroidCacheForKey(tenantKey);
    const examples =
      options.reembedExamples === true
        ? await reembedExamples(client, tenantKey, profile, options.signal ?? new AbortController().signal)
        : { reembedded: 0, skipped: 0, failed: 0 };
    if (examples.reembedded > 0) invalidateCentroidCacheForKey(tenantKey);
    return { tenantKey, profileId: profile.id, counts, examples, durationMs: Math.max(0, getRagDeps().now() - startedAt) };
  } finally {
    const left = (running.get(tenantKey) ?? 1) - 1;
    if (left > 0) running.set(tenantKey, left);
    else running.delete(tenantKey);
  }
}
