import type { RpcClient } from '../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';

/**
 * Reason words the access SQL raises (0922, 0924, 0925) that the routes map to UI-SPEC 8.2 codes. Only these ever leave this module, never
 * the rest of a database message: it can echo input.
 */
export const ACCESS_GROUPS_REASONS = [
  'invalid_key',
  'reserved_key',
  'invalid_name',
  'group_exists',
  'member_exists',
  'not_a_workspace_member',
  'unknown_group',
  'unknown_user',
  'empty_access',
  'count_required',
  'not_found',
  'personal_tenant',
  'mapping_exists',
  'rule_exists',
  'bad_domain',
  'access_managed_by_connector',
  'group_not_allowed',
  'invalid_argument',
  'invalid_cursor',
  'invalid_filter',
  'actor_required',
] as const;
export type AccessGroupsReason = (typeof ACCESS_GROUPS_REASONS)[number];

const KNOWN_REASONS = new Set<string>(ACCESS_GROUPS_REASONS);

/** SQL words that mean "no such row in this tenant"; the UI has one answer for all of them (404, UI-SPEC 8.2). */
const NOT_FOUND_WORDS = new Set(['mapping_not_found', 'rule_not_found', 'document_not_found']);

/** SQL words for malformed input the TypeScript checks should already have caught; reported as invalid_argument. */
const INVALID_WORDS = new Set([
  'invalid_provider',
  'invalid_kind',
  'invalid_status',
  'invalid_principal',
  'invalid_offset',
  'invalid_access_key',
  'invalid_actor_kind',
  'too_many_principals',
  'too_many_addresses',
  'group_required',
  'enabled_required',
  'owner_required',
]);

/** A failed access call. Carries the function name, the error code and a reason word only. */
export class AccessGroupsError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly reason: AccessGroupsReason | null;
  /** count_required only: the current count the server reported, so the delete dialog can show it. */
  readonly count: number | null;

  constructor(rpc: string, code: string | null, reason: AccessGroupsReason | null = null, count: number | null = null) {
    super(`[RAG Access] ${rpc} failed${code ? ` (${code})` : ''}${reason ? ` ${reason}` : ''}`);
    this.name = 'AccessGroupsError';
    this.rpc = rpc;
    this.code = code;
    this.reason = reason;
    this.count = count;
  }
}

/** The reason word that starts a database message, when it is one of the fixed list; null otherwise. */
export function accessReasonOf(message: string | undefined | null): AccessGroupsReason | null {
  const word = /^[a-z_]+/.exec(message ?? '')?.[0];
  if (word === undefined) return null;
  if (KNOWN_REASONS.has(word)) return word as AccessGroupsReason;
  if (NOT_FOUND_WORDS.has(word)) return 'not_found';
  if (INVALID_WORDS.has(word)) return 'invalid_argument';
  return null;
}

function countOf(message: string | undefined | null): number | null {
  const match = /^count_required:\s*(\d{1,12})\b/.exec(message ?? '');
  return match ? Number(match[1]) : null;
}

export interface AccessServiceDeps {
  db: () => RpcClient | null;
  signal: AbortSignal;
}

export type Row = Record<string, unknown>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function refused(rpc: string, reason: AccessGroupsReason): AccessGroupsError {
  return new AccessGroupsError(rpc, null, reason);
}

export function badResponse(rpc: string): AccessGroupsError {
  return new AccessGroupsError(rpc, 'bad_response');
}

export function tenantKeyOf(scope: TenantScope): string {
  assertTenantScope(scope);
  return scopeKey(scope);
}

/** A lowercase UUID, or a refusal with the given reason. */
export function uuidOf(rpc: string, value: unknown, reason: AccessGroupsReason = 'invalid_argument'): string {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_RE.test(id)) throw refused(rpc, reason);
  return id;
}

export async function callAccessRpc(deps: AccessServiceDeps, rpc: string, args: Row): Promise<unknown> {
  const db = deps.db();
  if (!db) throw new AccessGroupsError(rpc, 'db_unavailable');
  deps.signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(deps.signal);
  deps.signal.throwIfAborted();
  if (response.error) {
    const message = response.error.message;
    const reason = accessReasonOf(message);
    const failure = new AccessGroupsError(rpc, response.error.code ?? null, reason, reason === 'count_required' ? countOf(message) : null);
    console.warn('[RAG Access] access call failed', { rpc, code: failure.code, reason: failure.reason });
    throw failure;
  }
  return response.data;
}

/** The rows of a TABLE function; anything else is a bad response. */
export async function callAccessRows(deps: AccessServiceDeps, rpc: string, args: Row): Promise<Row[]> {
  const data = await callAccessRpc(deps, rpc, args);
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data) || data.some((row) => typeof row !== 'object' || row === null)) throw badResponse(rpc);
  return data as Row[];
}

export function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

export function count(row: Row, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function timestamp(row: Row, key: string): string | null {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

/** A required string column; a row without it is a bad response. */
export function required(rpc: string, row: Row, key: string): string {
  const value = text(row, key);
  if (value === null) throw badResponse(rpc);
  return value;
}

/** A UUID column of a returned row; anything else is a bad response. */
export function rowId(rpc: string, value: unknown): string {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  if (!UUID_RE.test(id)) throw badResponse(rpc);
  return id;
}
