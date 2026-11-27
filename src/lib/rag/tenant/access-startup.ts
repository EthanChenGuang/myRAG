import type { RpcClient, RpcResponse } from '../backend/supabase-rpc';
import type { BackendCapabilities } from '../backend/types';
import { loadRagConfig, type RagEnvInput } from '../config';
import { getRagDeps } from '../deps';

export type AccessStartupStatus = 'not_checked' | 'off' | 'ready' | 'not_ready';

/** A-03, D-10: whether the env switch, the database flag and every filtering part agree; codes and object names only. */
export interface AccessStartupVerdict {
  status: AccessStartupStatus;
  flagValue: boolean | null;
  reasons: readonly string[];
  objects: readonly string[];
  checkedAt: number | null;
}

export interface AccessStartupDeps {
  ragEnv: () => RagEnvInput;
  adminClient: () => RpcClient | null;
  /** The capabilities of the selected retrieval backend (D-14). */
  backendCapabilities: () => BackendCapabilities | undefined | Promise<BackendCapabilities | undefined>;
  now: () => number;
  /** Per call; a call that takes longer counts as failed, so startup never hangs. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const NOT_CHECKED: AccessStartupVerdict = Object.freeze({
  status: 'not_checked',
  flagValue: null,
  reasons: Object.freeze([]) as readonly string[],
  objects: Object.freeze([]) as readonly string[],
  checkedAt: null,
});

const loggedKeys = new Set<string>();
let verdict: AccessStartupVerdict = NOT_CHECKED;
let startupRun: Promise<AccessStartupVerdict> | null = null;

function logOnce(key: string, level: 'error' | 'warn', message: string, data?: Record<string, unknown>): void {
  if (loggedKeys.has(key)) return;
  loggedKeys.add(key);
  const log = level === 'error' ? console.error : console.warn;
  if (data) log(`[RAG Access] ${message}`, data);
  else log(`[RAG Access] ${message}`);
}

async function call(admin: RpcClient, fn: string, args: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RpcResponse>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ data: null, error: { message: 'timeout', code: 'timeout' } });
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(admin.rpc(fn, args).abortSignal(controller.signal)), timeout]);
  } catch {
    return { data: null, error: { message: 'call_failed', code: 'call_failed' } };
  } finally {
    clearTimeout(timer);
  }
}

function booleanOf(data: unknown): boolean | null {
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value !== null) {
    const fields = Object.values(value as Record<string, unknown>);
    if (fields.length === 1 && typeof fields[0] === 'boolean') return fields[0];
  }
  return null;
}

function codes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(item)) : [];
}

async function defaultBackendCapabilities(): Promise<BackendCapabilities | undefined> {
  const { getRetrievalBackend } = await import('../backend/registry');
  return getRetrievalBackend().capabilities;
}

function resolveDeps(deps?: Partial<AccessStartupDeps>): AccessStartupDeps {
  const base = getRagDeps();
  return {
    ragEnv: deps?.ragEnv ?? base.ragEnv,
    adminClient: deps?.adminClient ?? (() => base.adminClient() as unknown as RpcClient | null),
    backendCapabilities: deps?.backendCapabilities ?? defaultBackendCapabilities,
    now: deps?.now ?? base.now,
    ...(deps?.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  };
}

async function logDrift(admin: RpcClient, timeoutMs: number): Promise<void> {
  const { data, error } = await call(admin, 'rag_access_groups_drift', {}, timeoutMs);
  if (error || !Array.isArray(data)) {
    logOnce('drift_unchecked', 'warn', 'drift_unchecked');
    return;
  }
  const stores: Record<string, number> = {};
  for (const row of data as Array<Record<string, unknown>>) {
    const count = Number(row?.rows);
    if (typeof row?.store === 'string' && /^[a-z0-9_]{1,63}$/.test(row.store) && Number.isFinite(count) && count > 0) stores[row.store] = count;
  }
  if (Object.keys(stores).length > 0) logOnce('drift', 'warn', 'drift', { stores });
}

async function runChecks(deps: AccessStartupDeps): Promise<AccessStartupVerdict> {
  const on = loadRagConfig(deps.ragEnv()).accessGroups === 'on';
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reasons: string[] = [];
  const objects: string[] = [];
  const finish = (flagValue: boolean | null): AccessStartupVerdict => {
    const status: AccessStartupStatus = !on ? 'off' : reasons.length === 0 ? 'ready' : 'not_ready';
    verdict = Object.freeze({ status, flagValue, reasons: Object.freeze([...reasons]), objects: Object.freeze([...objects]), checkedAt: deps.now() });
    if (status === 'not_ready') logOnce(`not_ready:${reasons.join(',')}`, 'error', 'not_ready: retrieval is blocked', { reasons, objects });
    return verdict;
  };

  const admin = deps.adminClient();
  if (!admin) {
    reasons.push('admin_client_missing');
    if (!on) logOnce('flag_write_failed', 'warn', 'flag_write_failed', { reason: 'admin_client_missing' });
    return finish(null);
  }

  const write = await call(admin, 'rag_access_set_enforced', { p_enforced: on }, timeoutMs);
  const written = write.error ? null : booleanOf(write.data);
  const read = write.error ? null : await call(admin, 'rag_access_enforced', {}, timeoutMs);
  const flagValue = read && !read.error ? booleanOf(read.data) : null;
  if (write.error || written === null) reasons.push('flag_write_failed');
  else if (written !== on || flagValue !== on) reasons.push('flag_readback_mismatch');

  if (!on) {
    if (reasons.length > 0) logOnce(reasons[0], 'warn', reasons[0], { enforced: false });
    return finish(flagValue);
  }

  const readiness = await call(admin, 'rag_access_readiness', {}, timeoutMs);
  const row = Array.isArray(readiness.data) ? readiness.data[0] : readiness.data;
  if (readiness.error || typeof row !== 'object' || row === null || typeof (row as { ready?: unknown }).ready !== 'boolean') {
    reasons.push('readiness_unavailable');
  } else if (!(row as { ready: boolean }).ready) {
    reasons.push('readiness_not_ready', ...codes((row as { reasons?: unknown }).reasons));
    objects.push(...codes((row as { objects?: unknown }).objects));
  }

  const capabilities = await deps.backendCapabilities();
  if (capabilities?.accessFilter !== true) reasons.push('backend_without_access_filter');

  await logDrift(admin, timeoutMs);
  return finish(flagValue);
}

function start(deps: AccessStartupDeps): Promise<AccessStartupVerdict> {
  const run = runChecks(deps).catch(() => {
    const on = (() => {
      try {
        return loadRagConfig(deps.ragEnv()).accessGroups === 'on';
      } catch {
        return true;
      }
    })();
    verdict = Object.freeze({
      status: on ? 'not_ready' : 'off',
      flagValue: null,
      reasons: Object.freeze(['startup_failed']),
      objects: Object.freeze([]),
      checkedAt: Date.now(),
    }) as AccessStartupVerdict;
    logOnce('startup_failed', on ? 'error' : 'warn', 'startup_failed');
    return verdict;
  });
  startupRun = run;
  return run;
}

export function getAccessStartupVerdict(): AccessStartupVerdict {
  return verdict;
}

/** A-03: writes the database flag to match RAG_DOC_ACCESS_GROUPS and checks every part can filter; runs once per process, never throws. */
export function verifyAccessGroupsStartup(deps?: Partial<AccessStartupDeps>): Promise<AccessStartupVerdict> {
  return startupRun ?? start(resolveDeps(deps));
}

/** Reruns the checks now (Config UI sync) and returns the new verdict. */
export function syncAccessEnforcementNow(deps?: Partial<AccessStartupDeps>): Promise<AccessStartupVerdict> {
  return start(resolveDeps(deps));
}

/** D-10: resolveAccessScope waits for the pending or first check; only a ready verdict lets a scope resolve while the switch is on. */
export async function accessReadyForResolve(): Promise<boolean> {
  const result = await verifyAccessGroupsStartup();
  return result.status === 'ready';
}

export function resetAccessStartupForTests(): void {
  loggedKeys.clear();
  startupRun = null;
  verdict = NOT_CHECKED;
}
