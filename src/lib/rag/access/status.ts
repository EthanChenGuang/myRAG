import { env } from '@/lib/env';
import { loadRagConfig, type AccessGroupsMode, type RagEnvInput } from '../config';
import { getRagDeps } from '../deps';
import { getAccessStartupVerdict, syncAccessEnforcementNow, type AccessStartupDeps, type AccessStartupStatus } from '../tenant/access-startup';
import { resolveEmbedScope } from '../tenant/embed';
import type { TenantScope } from '../tenant/scope';
import { AccessGroupsError, callAccessRows, callAccessRpc, count, tenantKeyOf, text, type AccessServiceDeps } from './errors';
import { ACCESS_GROUP_KEY_RE } from './groups';

export interface AccessEmbedGroupStatus {
  key: string;
  /** False when the configured key does not match the group key pattern (UI form.badKey). */
  valid: boolean;
  /** Whether a group with this key exists in the embed tenant. */
  exists: boolean;
  name: string | null;
}

/** A-03, A-08, D-07: the Enforcement view. Codes, object names and the embed group only; no other group key or name. */
export interface AccessStatus {
  runningSwitch: AccessGroupsMode;
  databaseFlag: boolean | null;
  status: AccessStartupStatus;
  ready: boolean;
  reasons: string[];
  objects: string[];
  embedGroup: AccessEmbedGroupStatus | null;
  checkedAt: number | null;
}

export interface AccessDriftRow {
  store: string;
  rows: number;
}

export interface AccessStatusDeps extends AccessServiceDeps {
  ragEnv?: () => RagEnvInput;
  /** The embed tenant's scope (RAG_EMBED_TENANT); null when it is not configured or not valid. Defaults to resolveEmbedScope. */
  embedScope?: () => Promise<TenantScope | null>;
  /** Overrides for the startup checks syncAccessStatus reruns (tests). */
  startup?: Partial<AccessStartupDeps>;
}

const STORE_RE = /^[a-z0-9_]{1,63}$/;

async function defaultEmbedScope(signal: AbortSignal): Promise<TenantScope | null> {
  const result = await resolveEmbedScope({ rawBody: null, configuredTenant: env.RAG_EMBED_TENANT, signal });
  return result.ok ? result.scope : null;
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

async function databaseFlag(deps: AccessServiceDeps): Promise<boolean | null> {
  try {
    return booleanOf(await callAccessRpc(deps, 'rag_access_enforced', {}));
  } catch (error) {
    if (deps.signal.aborted) throw error;
    return null;
  }
}

async function embedGroupStatus(key: string, deps: AccessStatusDeps): Promise<AccessEmbedGroupStatus | null> {
  if (key === '') return null;
  if (!ACCESS_GROUP_KEY_RE.test(key) || key === 'all') return { key, valid: false, exists: false, name: null };
  let scope: TenantScope | null = null;
  try {
    scope = await (deps.embedScope ? deps.embedScope() : defaultEmbedScope(deps.signal));
  } catch (error) {
    if (deps.signal.aborted) throw error;
    scope = null;
  }
  if (!scope) return { key, valid: true, exists: false, name: null };
  try {
    const rows = await callAccessRows(deps, 'rag_access_group_by_key', { p_tenant_key: tenantKeyOf(scope), p_key: key });
    const row = rows[0];
    return { key, valid: true, exists: row !== undefined, name: row ? text(row, 'name') : null };
  } catch (error) {
    if (deps.signal.aborted || !(error instanceof AccessGroupsError)) throw error;
    return { key, valid: true, exists: false, name: null };
  }
}

/** The running switch, the database flag read now, the last startup verdict and the embed group. Never throws for a failed lookup. */
export async function accessStatus(deps: AccessStatusDeps): Promise<AccessStatus> {
  const config = loadRagConfig((deps.ragEnv ?? getRagDeps().ragEnv)());
  const verdict = getAccessStartupVerdict();
  const [flag, embedGroup] = await Promise.all([databaseFlag(deps), embedGroupStatus(config.embedAccessGroup, deps)]);
  return {
    runningSwitch: config.accessGroups,
    databaseFlag: flag,
    status: verdict.status,
    ready: verdict.status === 'ready',
    reasons: [...verdict.reasons],
    objects: [...verdict.objects],
    embedGroup,
    checkedAt: verdict.checkedAt,
  };
}

/** Config UI "Sync": reruns the startup checks (writes the database flag to match the switch), then reports as accessStatus. */
export async function syncAccessStatus(deps: AccessStatusDeps): Promise<AccessStatus> {
  await syncAccessEnforcementNow({
    ...(deps.ragEnv ? { ragEnv: deps.ragEnv } : {}),
    adminClient: deps.db,
    ...deps.startup,
  });
  return accessStatus(deps);
}

/** The label check: rows whose access labels differ from their document's, per store. */
export async function runAccessDrift(deps: AccessServiceDeps): Promise<AccessDriftRow[]> {
  const rows = await callAccessRows(deps, 'rag_access_groups_drift', {});
  return rows.flatMap((row) => {
    const store = text(row, 'store');
    return store !== null && STORE_RE.test(store) ? [{ store, rows: count(row, 'rows') }] : [];
  });
}
