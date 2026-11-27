import { rpcRows } from '../backend/supabase-rpc';
import { scopeKey, type TenantScope } from '../tenant/scope';
import {
  ScopeRebuildError,
  embedExampleText,
  exampleTextKey,
  isScopeRebuildRunning,
  rebuildScopeCentroids,
  scopeAdminClient,
  scopeProfile,
  vectorLiteral,
  type ScopeRebuildResult,
} from './build';
import { invalidateCentroidCacheForKey, type ScopeGroupKind } from './centroids';

/**
 * D-25: the admin service behind the 06.2-38 route. Status, example list, add (embedded at save time with the active profile, stored
 * as text plus vector), delete and a started rebuild. The tenant is the minted scope only; logs carry codes and counts, never text.
 */
export const SCOPE_EXAMPLE_MAX_CHARS = 500;
export const SCOPE_EXAMPLE_LIMIT = 100;
export const SCOPE_REBUILD_WAIT_MS = 2_000;
const EMBED_TIMEOUT_MS = 15_000;

export type ScopeAdminFailure = 'admin_unavailable' | 'profile_unavailable' | 'backend_error';

export interface ScopeGateStatus {
  profileId: string;
  groups: Record<ScopeGroupKind, number>;
  chunksIncluded: number;
  newestUpdate: string | null;
  examples: number;
  rebuildRunning: boolean;
  /** D-38, P-13: an active doc-type-scoped embedding binding; the gate stays unsure for this tenant. */
  unsupported: boolean;
  command: string;
}

export type ScopeGateStatusResult = { ok: true; status: ScopeGateStatus } | { ok: false; code: ScopeAdminFailure };

export interface ScopeExample {
  id: string;
  text: string;
  createdBy: string | null;
  createdAt: string | null;
}

export type ListScopeExamplesResult = { ok: true; profileId: string; examples: ScopeExample[] } | { ok: false; code: ScopeAdminFailure };

export type AddScopeExampleCode = 'text_empty' | 'text_too_long' | 'example_exists' | 'limit' | 'embedding_unavailable' | 'invalid_actor' | ScopeAdminFailure;

export type AddScopeExampleResult = { ok: true; example: { id: string; createdAt: string | null } } | { ok: false; code: AddScopeExampleCode };

export type DeleteScopeExampleResult = { ok: true } | { ok: false; code: 'not_found' | 'invalid_id' | ScopeAdminFailure };

export type StartScopeRebuildResult =
  | { status: 'done'; result: ScopeRebuildResult }
  | { status: 'started' }
  | { status: 'running' }
  | { status: 'failed'; code: ScopeAdminFailure | 'rebuild_failed' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const started = new Map<string, Promise<ScopeRebuildResult | null>>();
const loggedProblems = new Set<string>();

function problem(key: string, message: string): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[Scope Gate] ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function failureOf(error: unknown): ScopeAdminFailure {
  if (error instanceof ScopeRebuildError && (error.code === 'admin_unavailable' || error.code === 'profile_unavailable')) return error.code;
  return 'backend_error';
}

async function context() {
  return { client: scopeAdminClient(), profile: await scopeProfile() };
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

export function scopeCentroidsCommand(tenantKey: string): string {
  return `npm run rag:scope-centroids -- --tenant ${tenantKey}`;
}

export async function scopeGateStatus(scope: TenantScope): Promise<ScopeGateStatusResult> {
  const tenantKey = scopeKey(scope);
  try {
    const { client, profile } = await context();
    const { data, error } = await client.rpc('rag_scope_status', { p_tenant_key: tenantKey, p_profile_id: profile.id });
    if (error) {
      problem(`status:${error.code ?? 'unknown'}`, `status_failed code=${error.code ?? 'unknown'}`);
      return { ok: false, code: 'backend_error' };
    }
    const row = asRecord(rpcRows(data)[0]) ?? {};
    return {
      ok: true,
      status: {
        profileId: profile.id,
        groups: { doc_type: count(row.doc_type_groups), scope_tag: count(row.scope_tag_groups), tenant: count(row.tenant_groups) },
        chunksIncluded: count(row.chunks_included),
        newestUpdate: typeof row.newest_update === 'string' ? row.newest_update : null,
        examples: count(row.examples),
        rebuildRunning: isScopeRebuildRunning(scope),
        unsupported: row.has_scoped_binding === true,
        command: scopeCentroidsCommand(tenantKey),
      },
    };
  } catch (error) {
    return { ok: false, code: failureOf(error) };
  }
}

export async function listScopeExamples(scope: TenantScope): Promise<ListScopeExamplesResult> {
  const tenantKey = scopeKey(scope);
  try {
    const { client, profile } = await context();
    const { data, error } = await client.rpc('rag_scope_examples_list', { p_tenant_key: tenantKey, p_profile_id: profile.id });
    if (error) {
      problem(`list:${error.code ?? 'unknown'}`, `examples_list_failed code=${error.code ?? 'unknown'}`);
      return { ok: false, code: 'backend_error' };
    }
    const examples: ScopeExample[] = [];
    for (const raw of rpcRows(data)) {
      const row = asRecord(raw);
      if (!row || typeof row.id !== 'string' || typeof row.text !== 'string') continue;
      examples.push({
        id: row.id,
        text: row.text,
        createdBy: typeof row.created_by === 'string' ? row.created_by : null,
        createdAt: typeof row.created_at === 'string' ? row.created_at : null,
      });
    }
    return { ok: true, profileId: profile.id, examples };
  } catch (error) {
    return { ok: false, code: failureOf(error) };
  }
}

const SQL_CODES: Record<string, AddScopeExampleCode> = { '23505': 'example_exists', '54000': 'limit', '22001': 'text_too_long' };

export async function addScopeExample(scope: TenantScope, input: { text: string; actorId: string }): Promise<AddScopeExampleResult> {
  const tenantKey = scopeKey(scope);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text === '') return { ok: false, code: 'text_empty' };
  if (codePoints(text) > SCOPE_EXAMPLE_MAX_CHARS) return { ok: false, code: 'text_too_long' };
  if (typeof input.actorId !== 'string' || !UUID_RE.test(input.actorId)) return { ok: false, code: 'invalid_actor' };
  try {
    const { client, profile } = await context();
    const listed = await client.rpc('rag_scope_examples_list', { p_tenant_key: tenantKey, p_profile_id: profile.id });
    if (listed.error) return { ok: false, code: 'backend_error' };
    const rows = rpcRows(listed.data);
    const key = exampleTextKey(text);
    if (rows.some((raw) => typeof asRecord(raw)?.text === 'string' && exampleTextKey(asRecord(raw)?.text as string) === key)) {
      return { ok: false, code: 'example_exists' };
    }
    if (rows.length >= SCOPE_EXAMPLE_LIMIT) return { ok: false, code: 'limit' };

    let vector: number[];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      vector = await embedExampleText(text, profile, controller.signal);
    } catch {
      problem('embed', 'example_embedding_failed code=embedding_unavailable');
      return { ok: false, code: 'embedding_unavailable' };
    } finally {
      clearTimeout(timer);
    }

    const { data, error } = await client.rpc('rag_scope_example_add', {
      p_tenant_key: tenantKey,
      p_profile_id: profile.id,
      p_text: text,
      p_embedding: vectorLiteral(vector),
      p_actor: input.actorId.toLowerCase(),
    });
    if (error) {
      const mapped = error.code ? SQL_CODES[error.code] : undefined;
      if (mapped) return { ok: false, code: mapped };
      problem(`add:${error.code ?? 'unknown'}`, `example_add_failed code=${error.code ?? 'unknown'}`);
      return { ok: false, code: 'backend_error' };
    }
    invalidateCentroidCacheForKey(tenantKey);
    const row = asRecord(rpcRows(data)[0]);
    if (!row || typeof row.id !== 'string') return { ok: false, code: 'backend_error' };
    return { ok: true, example: { id: row.id, createdAt: typeof row.created_at === 'string' ? row.created_at : null } };
  } catch (error) {
    return { ok: false, code: failureOf(error) };
  }
}

function deletedFlag(data: unknown): boolean {
  if (data === true) return true;
  const first = rpcRows(data)[0];
  if (first === true) return true;
  const row = asRecord(first);
  return row !== null && Object.values(row).includes(true);
}

export async function deleteScopeExample(scope: TenantScope, id: string): Promise<DeleteScopeExampleResult> {
  const tenantKey = scopeKey(scope);
  if (typeof id !== 'string' || id.trim() === '' || id.length > 64) return { ok: false, code: 'invalid_id' };
  try {
    const client = scopeAdminClient();
    const { data, error } = await client.rpc('rag_scope_example_delete', { p_tenant_key: tenantKey, p_id: id });
    if (error) {
      if (error.code === '22P02') return { ok: false, code: 'invalid_id' };
      problem(`delete:${error.code ?? 'unknown'}`, `example_delete_failed code=${error.code ?? 'unknown'}`);
      return { ok: false, code: 'backend_error' };
    }
    if (!deletedFlag(data)) return { ok: false, code: 'not_found' };
    invalidateCentroidCacheForKey(tenantKey);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: failureOf(error) };
  }
}

/**
 * Starts a rebuild for the active profile and waits up to waitMs: answers done with the counts when it finishes in time, started
 * when it is still running (202-style), running when an admin-started rebuild for the tenant is already in progress.
 */
export async function startScopeRebuild(scope: TenantScope, options: { waitMs?: number } = {}): Promise<StartScopeRebuildResult> {
  const tenantKey = scopeKey(scope);
  if (started.has(tenantKey)) return { status: 'running' };
  let failure: StartScopeRebuildResult | null = null;
  const run = rebuildScopeCentroids(scope, { reembedExamples: true })
    .catch((error: unknown) => {
      const code = error instanceof ScopeRebuildError ? error.code : 'rebuild_failed';
      problem(`rebuild:${code}:${error instanceof ScopeRebuildError ? (error.sqlState ?? '') : ''}`, `rebuild_failed code=${code}`);
      failure = { status: 'failed', code: code === 'rebuild_failed' ? 'rebuild_failed' : failureOf(error) };
      return null;
    })
    .finally(() => {
      if (started.get(tenantKey) === run) started.delete(tenantKey);
    });
  started.set(tenantKey, run);
  const waitMs = options.waitMs !== undefined && Number.isFinite(options.waitMs) && options.waitMs >= 0 ? options.waitMs : SCOPE_REBUILD_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), waitMs);
  });
  const outcome = await Promise.race([run, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === 'pending') return { status: 'started' };
  if (outcome === null) return failure ?? { status: 'failed', code: 'rebuild_failed' };
  return { status: 'done', result: outcome };
}
