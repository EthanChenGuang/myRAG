import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { monitorSettings, type MonitorSettings } from '@/lib/rag/monitor/config';

export type EvalRunRequestReason = 'backfill_completed' | 'reembed_completed' | 'manual';
export type EvalRunRequestStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export type EvalRunCloseStatus = 'done' | 'skipped' | 'failed';

const TABLE = 'rag_eval_run_requests';
const COLUMNS = 'id,tenant_key,reason,ref_id,status,skip_reason,result_summary,requested_at,updated_at';
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const REF_ID_RE = /^[A-Za-z0-9:._-]{1,200}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EVAL_RUN_PAGE_MAX = 20;
export const EVAL_RUN_CLAIM_MAX = 20;

/** A reason or check code: lower snake case, as the 0961 skip_reason check allows. */
export const ReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * The numbers-only close summary (T-05.3-253): a gate result word, failed check names as codes and integer counts keyed by codes.
 * No free text fits: every string is a short code.
 */
export const EvalRunResultSummarySchema = z
  .object({
    result: z.enum(['pass', 'fail', 'error']).optional(),
    failed_checks: z.array(ReasonCodeSchema).max(64).optional(),
    counts: z.record(ReasonCodeSchema, z.number().int().min(0).max(1_000_000_000)).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value.counts ?? {}).length <= 64, { message: 'at most 64 counts', path: ['counts'] });

export type EvalRunResultSummary = z.infer<typeof EvalRunResultSummarySchema>;

export interface EvalRunRequest {
  id: string;
  tenant_key: string;
  reason: EvalRunRequestReason;
  ref_id: string;
  status: EvalRunRequestStatus;
  skip_reason: string | null;
  result_summary: EvalRunResultSummary | null;
  requested_at: string;
  updated_at: string;
}

type AdminClient = Pick<SupabaseClient, 'from'>;
type TenantKeyClient = Pick<SupabaseClient, 'rpc'>;

type SettingsReader = () => Pick<MonitorSettings, 'configGate'>;

export interface RequestTenantNightlyInput {
  tenantKey: string;
  reason: Exclude<EvalRunRequestReason, 'manual'> | 'manual';
  refId: string;
}

/**
 * D-19: asks for a tenant nightly run through one rag_eval_run_requests row (0961, idempotent on tenant, reason and ref id).
 * Only with RAG_CONFIG_GATE warn or enforce (D-57: off writes nothing). Never throws: a failure is logged with its name and the
 * caller's run goes on unchanged (T-05.3-251).
 */
export async function requestTenantNightly(
  rpc: RpcClient,
  input: RequestTenantNightlyInput,
  options: { settings?: SettingsReader; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; requested: boolean }> {
  try {
    const settings = (options.settings ?? monitorSettings)();
    if (settings.configGate === 'off') return { ok: true, requested: false };
    const tenantKey = input.tenantKey.trim().toLowerCase();
    if (!TENANT_KEY_RE.test(tenantKey) || !REF_ID_RE.test(input.refId)) {
      console.warn('[Config Gate] nightly request skipped: invalid key', { reason: input.reason });
      return { ok: false, requested: false };
    }
    let request = rpc.rpc('rag_eval_run_request_enqueue', { p_tenant_key: tenantKey, p_reason: input.reason, p_ref_id: input.refId });
    if (options.signal) request = request.abortSignal(options.signal);
    const { data, error } = await request;
    if (error) {
      console.error('[Config Gate] nightly request failed', { reason: input.reason, code: error.code ?? 'rpc_error' });
      return { ok: false, requested: false };
    }
    const inserted = data === true;
    console.log('[Config Gate] nightly requested', { reason: input.reason, inserted: inserted ? 1 : 0 });
    return { ok: true, requested: inserted };
  } catch (error) {
    console.error('[Config Gate] nightly request failed', { reason: input.reason, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, requested: false };
  }
}

/** The tenants this admin administers, resolved in SQL by rag_admin_tenant_keys (service_role only); null when unreadable. */
export async function adminTenantKeys(admin: TenantKeyClient, actorUserId: string): Promise<string[] | null> {
  const { data, error } = await admin.rpc('rag_admin_tenant_keys', { p_actor: actorUserId });
  if (error || !Array.isArray(data)) return null;
  return cleanKeys(data.filter((key): key is string => typeof key === 'string'));
}

function summaryOf(value: unknown): EvalRunResultSummary | null {
  if (value === null || value === undefined) return null;
  const parsed = EvalRunResultSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function rowOf(value: unknown): EvalRunRequest | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.tenant_key !== 'string' || typeof row.requested_at !== 'string') return null;
  return {
    id: row.id,
    tenant_key: row.tenant_key,
    reason: row.reason as EvalRunRequestReason,
    ref_id: String(row.ref_id ?? ''),
    status: row.status as EvalRunRequestStatus,
    skip_reason: typeof row.skip_reason === 'string' ? row.skip_reason : null,
    result_summary: summaryOf(row.result_summary),
    requested_at: row.requested_at,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : row.requested_at,
  };
}

function rowsOf(data: unknown): EvalRunRequest[] {
  return Array.isArray(data) ? data.map(rowOf).filter((row): row is EvalRunRequest => row !== null) : [];
}

function cleanKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key) => TENANT_KEY_RE.test(key)))];
}

export interface EvalRunCursor {
  requestedAt: string;
  id: string;
}

const CursorSchema = z.object({ r: z.string().regex(TIMESTAMP_RE), i: z.string().regex(UUID_RE) }).strict();

export function encodeEvalRunCursor(row: Pick<EvalRunRequest, 'requested_at' | 'id'>): string {
  return Buffer.from(JSON.stringify({ r: row.requested_at, i: row.id }), 'utf8').toString('base64url');
}

export function decodeEvalRunCursor(value: string): EvalRunCursor | null {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.success ? { requestedAt: parsed.data.r, id: parsed.data.i } : null;
  } catch {
    return null;
  }
}

export type ListResult = { ok: true; requests: EvalRunRequest[]; nextCursor: string | null } | { ok: false };

/** Requests of the given tenants (resolved server-side by the caller), newest first, at most 20 per page. */
export async function listEvalRunRequests(
  admin: AdminClient,
  input: { tenantKeys: readonly string[]; limit?: number; cursor?: EvalRunCursor | null },
): Promise<ListResult> {
  const keys = cleanKeys(input.tenantKeys);
  if (keys.length === 0) return { ok: true, requests: [], nextCursor: null };
  const limit = Math.max(1, Math.min(EVAL_RUN_PAGE_MAX, Math.trunc(input.limit ?? EVAL_RUN_PAGE_MAX)));
  let query = admin.from(TABLE).select(COLUMNS).in('tenant_key', keys);
  if (input.cursor) {
    const { requestedAt, id } = input.cursor;
    query = query.or(`requested_at.lt."${requestedAt}",and(requested_at.eq."${requestedAt}",id.lt.${id})`);
  }
  const { data, error } = await query.order('requested_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
  if (error || !Array.isArray(data)) return { ok: false };
  const rows = rowsOf(data);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length > 0 ? encodeEvalRunCursor(page[page.length - 1]) : null;
  return { ok: true, requests: page, nextCursor };
}

export type ClaimResult = { ok: true; requests: EvalRunRequest[] } | { ok: false };

/**
 * Moves the oldest pending requests of the given tenants to running and returns the rows this call moved. The update is
 * conditional on status pending, so two concurrent claims never return the same row.
 */
export async function claimEvalRunRequests(admin: AdminClient, input: { tenantKeys: readonly string[]; limit?: number }): Promise<ClaimResult> {
  const keys = cleanKeys(input.tenantKeys);
  if (keys.length === 0) return { ok: true, requests: [] };
  const limit = Math.max(1, Math.min(EVAL_RUN_CLAIM_MAX, Math.trunc(input.limit ?? 5)));
  const pending = await admin
    .from(TABLE)
    .select('id')
    .eq('status', 'pending')
    .in('tenant_key', keys)
    .order('requested_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  if (pending.error || !Array.isArray(pending.data)) return { ok: false };
  const ids = (pending.data as Array<{ id?: unknown }>).map((row) => row.id).filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return { ok: true, requests: [] };
  const { data, error } = await admin
    .from(TABLE)
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .in('id', ids)
    .eq('status', 'pending')
    .in('tenant_key', keys)
    .select(COLUMNS);
  if (error || !Array.isArray(data)) return { ok: false };
  const claimed = rowsOf(data).sort((a, b) => (a.requested_at < b.requested_at ? -1 : a.requested_at > b.requested_at ? 1 : a.id.localeCompare(b.id)));
  return { ok: true, requests: claimed };
}

export interface CloseInput {
  id: string;
  tenantKeys: readonly string[];
  status: EvalRunCloseStatus;
  skipReason?: string | null;
  resultSummary?: EvalRunResultSummary | null;
}

export type CloseResult =
  | { ok: true; request: EvalRunRequest }
  | { ok: false; reason: 'invalid' | 'not_found' | 'not_running' | 'unavailable' };

/** Closes one running request as done, skipped (with a reason code) or failed. Pending and closed rows are refused. */
export async function closeEvalRunRequest(admin: AdminClient, input: CloseInput): Promise<CloseResult> {
  const keys = cleanKeys(input.tenantKeys);
  if (!UUID_RE.test(input.id)) return { ok: false, reason: 'not_found' };
  const skipReason = input.skipReason ?? null;
  if (input.status === 'skipped' ? skipReason === null || !ReasonCodeSchema.safeParse(skipReason).success : skipReason !== null) {
    return { ok: false, reason: 'invalid' };
  }
  const summary = input.resultSummary ?? null;
  if (summary !== null && !EvalRunResultSummarySchema.safeParse(summary).success) return { ok: false, reason: 'invalid' };
  if (keys.length === 0) return { ok: false, reason: 'not_found' };

  const { data, error } = await admin
    .from(TABLE)
    .update({ status: input.status, skip_reason: skipReason, result_summary: summary, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .eq('status', 'running')
    .in('tenant_key', keys)
    .select(COLUMNS);
  if (error || !Array.isArray(data)) return { ok: false, reason: 'unavailable' };
  const [closed] = rowsOf(data);
  if (closed) return { ok: true, request: closed };

  const existing = await admin.from(TABLE).select('id,status').eq('id', input.id).in('tenant_key', keys).limit(1);
  if (existing.error || !Array.isArray(existing.data)) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: existing.data.length > 0 ? 'not_running' : 'not_found' };
}
