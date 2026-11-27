import type { RpcClient } from '../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import type { SemanticCache } from '../cache/types';
import { getIngestDeps } from './deps';

/**
 * The only application entry to the purge SQL (rag_purge_*, D-11): an irreversible removal of every version of a lineage from every
 * database store in one transaction (0727), then the storage objects after commit and a stored check (D-15, D-16, D-37). Only the fixed
 * SQL words leave this module; logs carry ids and counts, never file names or object paths.
 */

export type PurgeFailure = 'not_found' | 'invalid_argument' | 'tenant_mismatch' | 'unavailable';

export const PURGE_ADMIN_REASON_CODES = ['owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other'] as const;
export type PurgeAdminReasonCode = (typeof PURGE_ADMIN_REASON_CODES)[number];
export type PurgeReasonCode = PurgeAdminReasonCode | 'source_deleted';
export const PURGE_NOTE_MAX = 500;

export type PurgeCheckResult = 'verified' | 'pending' | 'remaining';

export interface PurgeCheck {
  /** Rows or objects the check still finds, per store, in the server's order. */
  left: Record<string, number>;
  /** Stored objects (and cache invalidations) waiting for the next retry. */
  pendingFiles: number;
  /** External index deletions still queued (Phase 7 targets in state pending). */
  queuedExternal: number;
  result: PurgeCheckResult;
  checkedAt: string;
}

export interface PurgeActor {
  kind: 'admin' | 'source_sync';
  id: string;
}

export interface PurgeReason {
  code: PurgeReasonCode;
  note?: string | null;
}

export type PurgeLineageResult =
  | { ok: true; auditId: string; lineageId: string; removed: Record<string, number>; check: PurgeCheck }
  | { ok: false; reason: PurgeFailure };

export interface PurgeDocumentAsAdminInput {
  documentId: string;
  /** The admin the route guard verified; the database checks admin_users and the tenants this user administers again. */
  actorUserId: string;
  reasonCode: PurgeAdminReasonCode;
  reasonNote: string | null;
  signal: AbortSignal;
}

export interface LineageDocumentRow {
  id: string;
  source: string | null;
  sourceFileId: string | null;
}

export interface PurgeDeps {
  db: () => RpcClient | null;
  lineageDocuments: (tenantKey: string, lineageId: string, signal: AbortSignal) => Promise<LineageDocumentRow[] | null>;
  cacheTarget: () => Pick<SemanticCache, 'invalidateTenant'> | null;
  scopeOf: (tenantKey: string, signal: AbortSignal) => Promise<TenantScope | null>;
}

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | { ok: false; reason: PurgeFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQL_REASONS = new Set<PurgeFailure>(['not_found', 'invalid_argument', 'tenant_mismatch']);

let depsOverride: Partial<PurgeDeps> = {};

function deps(): PurgeDeps {
  return {
    db: depsOverride.db ?? (() => getIngestDeps().db()),
    lineageDocuments: depsOverride.lineageDocuments ?? (async () => []),
    cacheTarget: depsOverride.cacheTarget ?? (() => null),
    scopeOf: depsOverride.scopeOf ?? (async () => null),
  };
}

export function setPurgeDepsForTests(next: Partial<PurgeDeps>): void {
  depsOverride = { ...next };
}

export function resetPurgeDepsForTests(): void {
  depsOverride = {};
}

function failureOf(message: string | undefined): PurgeFailure {
  const text = message ?? '';
  if (/^ingest_refused/.test(text)) return 'tenant_mismatch';
  const word = /^[a-z_]+/.exec(text)?.[0] as PurgeFailure | undefined;
  return word !== undefined && SQL_REASONS.has(word) ? word : 'unavailable';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** One RPC on the admin client. A database message never leaves this module; an unexpected failure is logged once with the RPC and code. */
async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db = deps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const reason = failureOf(response.error.message);
      if (reason === 'unavailable') console.error('[RAG Admin] purge call failed', { rpc, code: response.error.code ?? null });
      return { ok: false, reason };
    }
    const data = response.data;
    return { ok: true, rows: (Array.isArray(data) ? data : data === null || data === undefined ? [] : [data]) as Row[] };
  } catch (error) {
    if (isAbort(error)) throw error;
    console.error('[RAG Admin] purge call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function objectOf(value: unknown): Row {
  if (typeof value === 'string') {
    try {
      return objectOf(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function countsOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [store, n] of Object.entries(objectOf(value))) {
    const parsed = Number(n);
    if (Number.isFinite(parsed) && parsed >= 0) out[store] = Math.trunc(parsed);
  }
  return out;
}

function validReason(reason: PurgeReason): boolean {
  const note = reason.note ?? null;
  if (note !== null && (typeof note !== 'string' || note.length > PURGE_NOTE_MAX)) return false;
  if (reason.code === 'other' && (note === null || note.trim() === '')) return false;
  return reason.code === 'source_deleted' || (PURGE_ADMIN_REASON_CODES as readonly string[]).includes(reason.code);
}

interface VerifyTarget {
  auditId: string;
  tenantKey: string;
  lineageId: string;
  pending: string[];
}

/** Combines the database check with the pending items and stores it on the audit row (D-16, D-45). */
async function verifyAndFinish(target: VerifyTarget, objectCounts: Record<string, number>, signal: AbortSignal): Promise<{ ok: true; check: PurgeCheck } | { ok: false; reason: PurgeFailure }> {
  const verified = await call('rag_purge_verify', { p_tenant_key: target.tenantKey, p_lineage_id: target.lineageId }, signal);
  if (!verified.ok) return verified;
  const left: Record<string, number> = {};
  let remaining = false;
  let queuedExternal = 0;
  for (const row of verified.rows) {
    const store = text(row, 'store');
    const n = Number(row.remaining);
    if (store === null || !Number.isFinite(n)) return { ok: false, reason: 'unavailable' };
    if (store.startsWith('external:')) {
      const state = text(row, 'state');
      if (state === 'dead') {
        left[store] = 1;
        remaining = true;
      } else if (n > 0) {
        left[store] = 0;
        queuedExternal += 1;
      } else {
        left[store] = 0;
      }
      continue;
    }
    left[store] = n;
    if (n > 0) remaining = true;
  }
  const pendingFiles = target.pending.length;
  const result: PurgeCheckResult = remaining ? 'remaining' : pendingFiles > 0 || queuedExternal > 0 ? 'pending' : 'verified';
  const checkedAt = new Date().toISOString();
  const check: PurgeCheck = { left, pendingFiles, queuedExternal, result, checkedAt };
  const finished = await call(
    'rag_purge_audit_finish',
    {
      p_audit_id: target.auditId,
      p_object_counts: objectCounts,
      p_pending: target.pending,
      p_verification: { result, left, pending_files: pendingFiles, queued_external: queuedExternal, checked_at: checkedAt },
      p_result: result === 'remaining' ? 'failed' : result,
    },
    signal,
  );
  if (!finished.ok) return finished;
  return { ok: true, check };
}

async function purgeTenantLineage(tenantKey: string, lineageId: string, actor: PurgeActor, reason: PurgeReason, signal: AbortSignal): Promise<PurgeLineageResult> {
  const purged = await call(
    'rag_purge_lineage',
    {
      p_tenant_key: tenantKey,
      p_lineage_id: lineageId,
      p_actor: { kind: actor.kind, id: actor.id.toLowerCase() },
      p_reason: reason.note === null || reason.note === undefined ? { code: reason.code } : { code: reason.code, note: reason.note },
    },
    signal,
  );
  if (!purged.ok) return purged;
  const row = purged.rows[0];
  const auditId = row ? text(row, 'audit_id') : null;
  if (!row || auditId === null) return { ok: false, reason: 'unavailable' };
  const removed = countsOf(row.counts);
  const objectCounts: Record<string, number> = {};
  const pending: string[] = [];
  const checked = await verifyAndFinish({ auditId, tenantKey, lineageId, pending }, objectCounts, signal);
  if (!checked.ok) {
    console.error('[RAG Admin] purge committed but its check was not stored', { auditId, lineageId });
    return { ok: true, auditId, lineageId, removed: { ...removed, ...objectCounts }, check: unchecked(pending.length) };
  }
  return { ok: true, auditId, lineageId, removed: { ...removed, ...objectCounts }, check: checked.check };
}

/** A purge that committed but whose check could not be read or stored: reported as pending so the reconcile run checks it again. */
function unchecked(pendingFiles: number): PurgeCheck {
  return { left: {}, pendingFiles, queuedExternal: 0, result: 'pending', checkedAt: new Date().toISOString() };
}

/** Scope-based entry for source sync (plan 06.3-21): the tenant comes from the minted scope, never from the caller. */
export async function purgeLineage(
  scope: TenantScope,
  lineageId: string,
  actor: PurgeActor,
  reason: PurgeReason,
  options: { signal: AbortSignal },
): Promise<PurgeLineageResult> {
  assertTenantScope(scope);
  if (!UUID.test(lineageId) || !UUID.test(actor.id) || (actor.kind !== 'admin' && actor.kind !== 'source_sync') || !validReason(reason)) {
    return { ok: false, reason: 'invalid_argument' };
  }
  return purgeTenantLineage(scopeKey(scope).toLowerCase(), lineageId.toLowerCase(), actor, reason, options.signal);
}

/**
 * Purges the whole lineage of one document for an admin of its tenant (D-34). The tenant and lineage come from SQL; an unknown id,
 * another tenant's id and a non-admin all answer not_found.
 */
export async function purgeDocumentAsAdmin(input: PurgeDocumentAsAdminInput): Promise<PurgeLineageResult> {
  if (!UUID.test(input.documentId) || !UUID.test(input.actorUserId)) return { ok: false, reason: 'invalid_argument' };
  const reason: PurgeReason = { code: input.reasonCode, note: input.reasonNote };
  if (!(PURGE_ADMIN_REASON_CODES as readonly string[]).includes(input.reasonCode) || !validReason(reason)) return { ok: false, reason: 'invalid_argument' };
  const actor = input.actorUserId.toLowerCase();
  const target = await call('rag_purge_admin_target', { p_document_id: input.documentId.toLowerCase(), p_actor: actor }, input.signal);
  if (!target.ok) return target;
  const row = target.rows[0];
  const tenantKey = row ? text(row, 'tenant_key') : null;
  const lineageId = row ? text(row, 'lineage_id') : null;
  if (tenantKey === null || lineageId === null) return { ok: false, reason: 'unavailable' };
  return purgeTenantLineage(tenantKey, lineageId, { kind: 'admin', id: actor }, reason, input.signal);
}

export async function retryPendingPurgeObjects(_input: { limit?: number; signal: AbortSignal }): Promise<{ ok: true; records: number; cleared: number; stillPending: number } | { ok: false; reason: PurgeFailure }> {
  return { ok: false, reason: 'unavailable' };
}

export async function rescrubRecentPurges(_input: { signal: AbortSignal }): Promise<{ ok: true; records: number; scrubbed: number } | { ok: false; reason: PurgeFailure }> {
  return { ok: false, reason: 'unavailable' };
}

export async function isPurgeTombstoned(
  _scope: TenantScope,
  _sourceConnectionId: string,
  _sourceKey: string,
  _options: { signal: AbortSignal },
): Promise<{ ok: true; tombstoned: boolean } | { ok: false; reason: PurgeFailure }> {
  return { ok: false, reason: 'unavailable' };
}
