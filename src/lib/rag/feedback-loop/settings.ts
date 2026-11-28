import type { SupabaseClient } from '@supabase/supabase-js';
import { getRagDeps } from '../deps';
import { readFeedbackLoopConfig, type RetrievalLogLevel } from './config';

export type TenantRetrievalLog = 'inherit' | 'off' | 'ids';

export interface TenantFeedbackSettingsRow {
  tenant_key: string;
  retrieval_log: TenantRetrievalLog;
  updated_by: string | null;
  updated_at: string | null;
}

export interface EffectiveLogModeDeps {
  /** Defaults to the admin client from the RAG deps; the settings table is service-role only. */
  client?: SupabaseClient | null;
  /** Defaults to RAG_RETRIEVAL_LOG read at call time. */
  globalLevel?: RetrievalLogLevel;
  now?: () => number;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export const SETTINGS_CACHE_TTL_MS = 60_000;
export const SETTINGS_READ_TIMEOUT_MS = 2_000;
export const TENANT_RETRIEVAL_LOG_LEVELS: readonly TenantRetrievalLog[] = ['inherit', 'off', 'ids'];

const TABLE = 'rag_tenant_feedback_settings';
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,32}$/;

/** Tenant key -> the stored level ('inherit' when there is no row), cached per process. Failures are never cached. */
const cache = new Map<string, { level: TenantRetrievalLog | 'invalid'; readAt: number }>();

export function resetTenantSettingsCache(): void {
  cache.clear();
}

/** A tenant can only lower the global level: ids turns masked_query into ids, off disables, inherit keeps it. */
export function combineLogLevels(global: RetrievalLogLevel, tenant: TenantRetrievalLog | 'invalid'): RetrievalLogLevel {
  if (global === 'off') return 'off';
  if (tenant === 'inherit') return global;
  if (tenant === 'ids') return 'ids';
  return 'off';
}

function asTenantLevel(value: unknown): TenantRetrievalLog | 'invalid' {
  return TENANT_RETRIEVAL_LOG_LEVELS.find((level) => level === value) ?? 'invalid';
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && ERROR_CODE.test(name)) return name;
  }
  return 'unknown';
}

class SettingsReadTimeout extends Error {
  override name = 'timeout';
}

interface SettingsResponse {
  data: Record<string, unknown> | null;
  error: unknown;
}

/** Reads the stored row, or null when the tenant has none. Throws on a database error or after the timeout. */
export async function readTenantFeedbackSettings(
  client: SupabaseClient,
  tenantKey: string,
  timeoutMs: number = SETTINGS_READ_TIMEOUT_MS,
): Promise<TenantFeedbackSettingsRow | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SettingsReadTimeout());
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const query = client
      .from(TABLE)
      .select('tenant_key, retrieval_log, updated_by, updated_at')
      .eq('tenant_key', tenantKey)
      .abortSignal(controller.signal)
      .maybeSingle() as unknown as PromiseLike<SettingsResponse>;
    const { data, error } = await Promise.race([Promise.resolve(query), timeout]);
    if (error) throw error;
    if (!data) return null;
    return {
      tenant_key: String(data.tenant_key ?? tenantKey),
      retrieval_log: data.retrieval_log as TenantRetrievalLog,
      updated_by: typeof data.updated_by === 'string' ? data.updated_by : null,
      updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The retrieval-log level for one tenant: RAG_RETRIEVAL_LOG lowered by the tenant's row (D-06). The row is cached for 60 s; a failed
 * read gives off for this request (fail closed) with one [Feedback Loop] line that names no tenant. Never throws.
 */
export async function effectiveLogMode(tenantKey: string, deps: EffectiveLogModeDeps = {}): Promise<RetrievalLogLevel> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const report = (code: string): void => {
    try {
      log(`[Feedback Loop] tenant log setting unavailable; logging off for this request ${JSON.stringify({ code })}`);
    } catch {
      // logging must never affect the request
    }
  };
  try {
    const global = deps.globalLevel ?? readFeedbackLoopConfig().retrievalLog;
    if (global === 'off') return 'off';
    if (!TENANT_KEY.test(tenantKey)) {
      report('invalid_tenant_key');
      return 'off';
    }
    const now = (deps.now ?? Date.now)();
    const cached = cache.get(tenantKey);
    if (cached && now - cached.readAt < SETTINGS_CACHE_TTL_MS) return combineLogLevels(global, cached.level);

    const client = deps.client === undefined ? getRagDeps().adminClient() : deps.client;
    if (!client) {
      report('no_admin_client');
      return 'off';
    }
    let level: TenantRetrievalLog | 'invalid';
    try {
      const row = await readTenantFeedbackSettings(client, tenantKey, deps.timeoutMs);
      level = row ? asTenantLevel(row.retrieval_log) : 'inherit';
    } catch (error) {
      report(error instanceof SettingsReadTimeout ? 'timeout' : errorCode(error));
      return 'off';
    }
    cache.set(tenantKey, { level, readAt: now });
    return combineLogLevels(global, level);
  } catch (error) {
    report(errorCode(error));
    return 'off';
  }
}

export class TenantSettingsWriteError extends Error {
  constructor(readonly code: string) {
    super(`[Feedback Loop] tenant setting write failed (${code})`);
    this.name = 'TenantSettingsWriteError';
  }
}

/** Upserts the tenant's row with the acting admin's id and drops this process's cached copy. The caller validates the input. */
export async function setTenantFeedbackSettings(
  client: SupabaseClient,
  input: { tenantKey: string; retrievalLog: TenantRetrievalLog; updatedBy: string },
): Promise<TenantFeedbackSettingsRow> {
  if (!TENANT_KEY.test(input.tenantKey)) throw new TenantSettingsWriteError('invalid_tenant_key');
  if (!TENANT_RETRIEVAL_LOG_LEVELS.includes(input.retrievalLog)) throw new TenantSettingsWriteError('invalid_level');
  const { data, error } = (await client
    .from(TABLE)
    .upsert(
      { tenant_key: input.tenantKey, retrieval_log: input.retrievalLog, updated_by: input.updatedBy, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_key' },
    )
    .select('tenant_key, retrieval_log, updated_by, updated_at')
    .single()) as unknown as SettingsResponse;
  cache.delete(input.tenantKey);
  if (error || !data) throw new TenantSettingsWriteError(error ? errorCode(error) : 'no_row');
  return {
    tenant_key: String(data.tenant_key),
    retrieval_log: data.retrieval_log as TenantRetrievalLog,
    updated_by: typeof data.updated_by === 'string' ? data.updated_by : null,
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
  };
}
