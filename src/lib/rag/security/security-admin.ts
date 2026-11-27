import {
  ReviewCheckDetailsSchema,
  SecurityAlertViewSchema,
  SecurityEventViewSchema,
  SecurityUploaderViewSchema,
  LinkPreviewStatusSchema,
  type LinkPreviewStatus,
  type ReviewCheckDetails,
  type ReviewItem,
  type SecurityAlertView,
  type SecurityEventView,
  type SecurityUploaderView,
} from '@/lib/rag-eval/contracts.generated';
import { readAnswerConfig, type UploaderHoldMode } from '../generation/answer-config';
import { isAllowedHost, normalizeHost, parseLinkAllowlist } from './link-allowlist';

/**
 * D-45 to D-47: the security-events admin service. Every read and action takes the tenant keys the actor administers, resolved in SQL
 * (rag_security_admin_keys, 0945): a deployment admin gets every tenant, an organization admin or domain expert only theirs. A row of
 * another tenant is reported as not found. Responses carry named view fields only: ids, counts, times, rule ids, workspace and file names,
 * the uploader's id and display name, and the e-mail only for deployment admins. No question, answer, chunk, document or target text.
 * Logs carry counts and status words only.
 */

type Row = Record<string, unknown>;

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface FilterBuilder extends PromiseLike<QueryResult> {
  select(columns: string): FilterBuilder;
  eq(column: string, value: unknown): FilterBuilder;
  in(column: string, values: unknown[]): FilterBuilder;
  order(column: string, options?: { ascending?: boolean }): FilterBuilder;
  limit(count: number): FilterBuilder;
}

/** The admin (service-role) client surface this module uses. */
export interface SecurityAdminDb {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<QueryResult>;
  from(table: string): { select(columns: string): FilterBuilder };
  auth: {
    admin: {
      getUserById(id: string): PromiseLike<{ data: { user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null } | null; error: unknown }>;
    };
  };
}

export interface SecurityActor {
  userId: string;
  /** Verified by the route guard (checkAdmin) and checked again in SQL. */
  deploymentAdmin: boolean;
  tenantKeys: string[];
}

export type SecurityFailure = 'not_found' | 'hold_disabled' | 'already_held' | 'not_held' | 'already_acknowledged' | 'unavailable';
export type SecurityResult<T> = ({ ok: true } & T) | { ok: false; reason: SecurityFailure };

export const SECURITY_PAGE_SIZE = 50;
const MAX_OFFSET = 1_000_000;
const PREVIEW_TIMEOUT_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const HOST_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const STATUS_WORDS = new Set(['ok', 'already_held', 'not_held', 'already_acknowledged', 'not_found']);

export const SECURITY_EVENT_SOURCES = ['ingest_injection', 'retrieval_injection', 'output_guard', 'hidden_text', 'untrusted_link'] as const;
export type SecurityEventSource = (typeof SECURITY_EVENT_SOURCES)[number];

export interface SecuritySettings {
  eventsRecorded: boolean;
  holdMode: UploaderHoldMode;
  alertLevel: number;
  windowHours: number;
}

export function readSecuritySettings(source: Record<string, string | undefined> = process.env): SecuritySettings {
  const config = readAnswerConfig(source);
  return {
    eventsRecorded: config.securityEvents,
    holdMode: config.uploaderHold,
    alertLevel: config.uploaderAlertThreshold,
    windowHours: config.uploaderAlertWindowHours,
  };
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function strings(row: Row, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function timeOf(value: unknown): string | null {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function rowsOf(data: unknown): Row[] {
  return Array.isArray(data) ? data.filter((row): row is Row => row !== null && typeof row === 'object') : [];
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null;
}

function clampOffset(offset: number | undefined): number {
  return typeof offset === 'number' && Number.isInteger(offset) ? Math.min(Math.max(offset, 0), MAX_OFFSET) : 0;
}

async function callRpc(db: SecurityAdminDb, name: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const { data, error } = await db.rpc(name, args);
    if (error) {
      console.error('[RAG Admin] security call failed', { rpc: name, code: errorCode(error) });
      return { ok: false };
    }
    return { ok: true, data };
  } catch (error) {
    console.error('[RAG Admin] security call failed', { rpc: name, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false };
  }
}

/**
 * The tenant keys the actor may read and act on, resolved in SQL. A deployment admin flag the database does not confirm, a lookup
 * failure or an empty answer all give no key; the route then denies.
 */
export async function resolveAdminTenants(
  db: SecurityAdminDb,
  actor: { userId: string; deploymentAdmin: boolean },
): Promise<{ ok: true; tenantKeys: string[] } | { ok: false }> {
  if (!UUID_RE.test(actor.userId)) return { ok: false };
  const result = await callRpc(db, 'rag_security_admin_keys', { p_actor: actor.userId.toLowerCase(), p_deployment_admin: actor.deploymentAdmin });
  if (!result.ok) return { ok: false };
  const keys = Array.isArray(result.data) ? result.data.filter((key): key is string => typeof key === 'string' && TENANT_KEY_RE.test(key)) : [];
  return { ok: true, tenantKeys: [...new Set(keys)] };
}

export function actorAdministers(actor: SecurityActor, tenantKey: string): boolean {
  return TENANT_KEY_RE.test(tenantKey) && actor.tenantKeys.includes(tenantKey);
}

export interface UploaderView {
  name: string | null;
  email: string | null;
}

/**
 * Display names from the auth user record (full name, then name; never the e-mail as a name), and the e-mail only for deployment admins
 * (D-47). A failed lookup leaves both null; the id is always returned next to them.
 */
export async function resolveUploaderViews(
  db: SecurityAdminDb,
  userIds: ReadonlyArray<string | null>,
  actor: { deploymentAdmin: boolean },
): Promise<Map<string, UploaderView>> {
  const unique = [...new Set(userIds.map(uuidOrNull).filter((id): id is string => id !== null))];
  const views = new Map<string, UploaderView>(unique.map((id) => [id, { name: null, email: null }]));
  await Promise.all(
    unique.map(async (id) => {
      try {
        const { data } = await db.auth.admin.getUserById(id);
        const user = data?.user ?? null;
        if (!user) return;
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        const name = [meta.full_name, meta.name].find((value): value is string => typeof value === 'string' && value.trim() !== '');
        const email = actor.deploymentAdmin && typeof user.email === 'string' && user.email.trim() !== '' ? user.email.trim() : null;
        views.set(id, { name: name ? name.trim() : null, email });
      } catch {
        // both stay null
      }
    }),
  );
  return views;
}

/** Organization names for o: keys; s:default and personal u: workspaces have no stored name. */
async function workspaceNames(db: SecurityAdminDb, tenantKeys: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(tenantKeys.filter((key) => key.startsWith('o:')).map((key) => key.slice(2)))].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return names;
  try {
    const { data, error } = await db.from('organizations').select('id,name').in('id', ids);
    if (error) return names;
    for (const row of rowsOf(data)) {
      const id = uuidOrNull(row.id);
      const name = text(row, 'name');
      if (id && name) names.set(`o:${id}`, name);
    }
  } catch {
    // names stay unknown
  }
  return names;
}

/** File names of documents, keyed by id, only where the document belongs to the given tenant; a document that is gone is absent. */
async function documentRows(db: SecurityAdminDb, pairs: ReadonlyArray<{ documentId: string; tenantKey: string }>): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  const ids = [...new Set(pairs.map((pair) => uuidOrNull(pair.documentId)).filter((id): id is string => id !== null))];
  if (ids.length === 0) return found;
  const { data, error } = await db.from('documents').select('id,filename,tenant_key,user_id').in('id', ids);
  if (error) throw new Error('security_documents_read_failed');
  const tenantOf = new Map(pairs.map((pair) => [pair.documentId.toLowerCase(), pair.tenantKey]));
  for (const row of rowsOf(data)) {
    const id = uuidOrNull(row.id);
    if (id && row.tenant_key === tenantOf.get(id)) found.set(id, row);
  }
  return found;
}

function page<T>(items: T[], offset: number): { items: T[]; nextCursor: string | null } {
  const slice = items.slice(offset, offset + SECURITY_PAGE_SIZE);
  return { items: slice, nextCursor: items.length > offset + SECURITY_PAGE_SIZE ? String(offset + SECURITY_PAGE_SIZE) : null };
}

function logDropped(view: string, dropped: number): void {
  if (dropped > 0) console.warn('[RAG Admin] security rows failed the view contract and were left out', { view, dropped });
}

export interface ListEventsInput {
  source?: SecurityEventSource;
  uploader?: string;
  since?: string;
  offset?: number;
}

/** Events of the actor's tenants, newest first, 50 per page with an offset cursor. */
export async function listSecurityEvents(
  db: SecurityAdminDb,
  actor: SecurityActor,
  input: ListEventsInput,
): Promise<SecurityResult<{ items: SecurityEventView[]; nextCursor: string | null }>> {
  const offset = clampOffset(input.offset);
  if (actor.tenantKeys.length === 0) return { ok: true, items: [], nextCursor: null };
  const result = await callRpc(db, 'rag_list_security_events', {
    p_tenant_keys: actor.tenantKeys,
    p_source: input.source ?? null,
    p_uploader: input.uploader ? input.uploader.toLowerCase() : null,
    p_since: input.since ?? null,
    p_limit: SECURITY_PAGE_SIZE + 1,
    p_offset: offset,
  });
  if (!result.ok) return { ok: false, reason: 'unavailable' };
  const rows = rowsOf(result.data).filter((row) => typeof row.tenant_key === 'string' && actor.tenantKeys.includes(row.tenant_key));
  const pageRows = rows.slice(0, SECURITY_PAGE_SIZE);
  try {
    const [names, documents, uploaders] = await Promise.all([
      workspaceNames(db, pageRows.map((row) => String(row.tenant_key))),
      documentRows(
        db,
        pageRows.flatMap((row) => (typeof row.document_id === 'string' ? [{ documentId: row.document_id, tenantKey: String(row.tenant_key) }] : [])),
      ),
      resolveUploaderViews(db, pageRows.map((row) => uuidOrNull(row.uploader_id)), actor),
    ]);
    const items: SecurityEventView[] = [];
    let dropped = 0;
    for (const row of pageRows) {
      const tenantKey = String(row.tenant_key);
      const documentId = uuidOrNull(row.document_id);
      const uploaderId = uuidOrNull(row.uploader_id);
      const uploader = uploaderId ? uploaders.get(uploaderId) : undefined;
      const document = documentId ? documents.get(documentId) : undefined;
      const parsed = SecurityEventViewSchema.safeParse({
        id: row.id,
        created_at: timeOf(row.created_at),
        tenant_key: tenantKey,
        workspace_name: names.get(tenantKey) ?? null,
        source: row.source,
        action: row.action,
        detector: row.detector,
        rule_ids: strings(row, 'rule_ids'),
        document_id: documentId,
        file_name: document ? text(document, 'filename') : null,
        uploader_id: uploaderId,
        uploader_name: uploader?.name ?? null,
        uploader_email: uploader?.email ?? null,
      });
      if (parsed.success) items.push(parsed.data);
      else dropped += 1;
    }
    logDropped('events', dropped);
    return { ok: true, items, nextCursor: rows.length > SECURITY_PAGE_SIZE ? String(offset + SECURITY_PAGE_SIZE) : null };
  } catch {
    console.error('[RAG Admin] security events lookup failed');
    return { ok: false, reason: 'unavailable' };
  }
}

function windowHoursOf(row: Row): number | null {
  const start = timeOf(row.window_start);
  const end = timeOf(row.window_end);
  if (!start || !end) return null;
  const hours = Math.round((Date.parse(end) - Date.parse(start)) / 3_600_000);
  return hours >= 1 ? hours : null;
}

/** Open and acknowledged alerts of the actor's tenants, newest first, 50 per page; openCount counts every open alert. */
export async function listSecurityAlerts(
  db: SecurityAdminDb,
  actor: SecurityActor,
  input: { offset?: number },
  settings: SecuritySettings,
): Promise<SecurityResult<{ items: SecurityAlertView[]; openCount: number; nextCursor: string | null }>> {
  const offset = clampOffset(input.offset);
  if (actor.tenantKeys.length === 0) return { ok: true, items: [], openCount: 0, nextCursor: null };
  const result = await callRpc(db, 'rag_list_security_alerts', { p_tenant_keys: actor.tenantKeys });
  if (!result.ok) return { ok: false, reason: 'unavailable' };
  const rows = rowsOf(result.data).filter((row) => typeof row.tenant_key === 'string' && actor.tenantKeys.includes(row.tenant_key));
  const openCount = rows.filter((row) => row.status === 'open').length;
  const { items: pageRows, nextCursor } = page(rows, offset);
  try {
    const [names, uploaders] = await Promise.all([
      workspaceNames(db, pageRows.map((row) => String(row.tenant_key))),
      resolveUploaderViews(db, pageRows.map((row) => uuidOrNull(row.uploader_id)), actor),
    ]);
    const items: SecurityAlertView[] = [];
    let dropped = 0;
    for (const row of pageRows) {
      const tenantKey = String(row.tenant_key);
      const uploaderId = uuidOrNull(row.uploader_id);
      const uploader = uploaderId ? uploaders.get(uploaderId) : undefined;
      const parsed = SecurityAlertViewSchema.safeParse({
        id: row.id,
        tenant_key: tenantKey,
        workspace_name: names.get(tenantKey) ?? null,
        uploader_id: uploaderId,
        uploader_name: uploader?.name ?? null,
        uploader_email: uploader?.email ?? null,
        event_count: row.event_count,
        window_hours: windowHoursOf(row),
        threshold: Math.max(1, settings.alertLevel),
        opened_at: timeOf(row.created_at),
        status: row.status,
        held: row.held === true,
      });
      if (parsed.success) items.push(parsed.data);
      else dropped += 1;
    }
    logDropped('alerts', dropped);
    return { ok: true, items, openCount, nextCursor };
  } catch {
    console.error('[RAG Admin] security alerts lookup failed');
    return { ok: false, reason: 'unavailable' };
  }
}

/** Active holds of the actor's tenants, keyed by tenant and user, with their start time. */
async function activeHolds(db: SecurityAdminDb, tenantKeys: readonly string[]): Promise<Map<string, string | null>> {
  const holds = new Map<string, string | null>();
  if (tenantKeys.length === 0) return holds;
  const { data, error } = await db
    .from('rag_uploader_holds')
    .select('tenant_key,user_id,created_at,released_at')
    .in('tenant_key', [...tenantKeys])
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error('security_holds_read_failed');
  for (const row of rowsOf(data)) {
    if (row.released_at !== null && row.released_at !== undefined) continue;
    const userId = uuidOrNull(row.user_id);
    if (!userId || typeof row.tenant_key !== 'string' || !tenantKeys.includes(row.tenant_key)) continue;
    holds.set(`${row.tenant_key}|${userId}`, timeOf(row.created_at));
  }
  return holds;
}

/**
 * Per uploader and workspace: events in the window, last event time and the hold state with its start. An uploader with an active hold
 * and no event in the window is listed with zero events, so the hold can still be released.
 */
export async function listSecurityUploaders(
  db: SecurityAdminDb,
  actor: SecurityActor,
  input: { offset?: number },
  settings: SecuritySettings,
): Promise<SecurityResult<{ items: SecurityUploaderView[]; nextCursor: string | null }>> {
  const offset = clampOffset(input.offset);
  if (actor.tenantKeys.length === 0) return { ok: true, items: [], nextCursor: null };
  const result = await callRpc(db, 'rag_list_security_uploaders', { p_tenant_keys: actor.tenantKeys, p_window_hours: settings.windowHours });
  if (!result.ok) return { ok: false, reason: 'unavailable' };
  try {
    const holds = await activeHolds(db, actor.tenantKeys);
    const entries: Array<{ tenantKey: string; userId: string; eventCount: number; lastEventAt: string | null }> = [];
    const seen = new Set<string>();
    for (const row of rowsOf(result.data)) {
      const userId = uuidOrNull(row.uploader_id);
      if (!userId || typeof row.tenant_key !== 'string' || !actor.tenantKeys.includes(row.tenant_key)) continue;
      seen.add(`${row.tenant_key}|${userId}`);
      entries.push({ tenantKey: row.tenant_key, userId, eventCount: Number(row.event_count), lastEventAt: timeOf(row.last_event_at) });
    }
    for (const key of [...holds.keys()].sort()) {
      if (seen.has(key)) continue;
      const [tenantKey, userId] = key.split('|');
      entries.push({ tenantKey, userId, eventCount: 0, lastEventAt: null });
    }
    const { items: pageEntries, nextCursor } = page(entries, offset);
    const [names, uploaders] = await Promise.all([
      workspaceNames(db, pageEntries.map((entry) => entry.tenantKey)),
      resolveUploaderViews(db, pageEntries.map((entry) => entry.userId), actor),
    ]);
    const items: SecurityUploaderView[] = [];
    let dropped = 0;
    for (const entry of pageEntries) {
      const key = `${entry.tenantKey}|${entry.userId}`;
      const uploader = uploaders.get(entry.userId);
      const parsed = SecurityUploaderViewSchema.safeParse({
        user_id: entry.userId,
        display_name: uploader?.name ?? null,
        email: uploader?.email ?? null,
        tenant_key: entry.tenantKey,
        workspace_name: names.get(entry.tenantKey) ?? null,
        event_count: entry.eventCount,
        last_event_at: entry.lastEventAt,
        held: holds.has(key),
        held_since: holds.get(key) ?? null,
      });
      if (parsed.success) items.push(parsed.data);
      else dropped += 1;
    }
    logDropped('uploaders', dropped);
    return { ok: true, items, nextCursor };
  } catch {
    console.error('[RAG Admin] security uploaders lookup failed');
    return { ok: false, reason: 'unavailable' };
  }
}

async function statusWord(db: SecurityAdminDb, name: string, args: Record<string, unknown>): Promise<string | null> {
  const result = await callRpc(db, name, args);
  if (!result.ok) return null;
  return typeof result.data === 'string' && STATUS_WORDS.has(result.data) ? result.data : null;
}

/** The target must be an uploader of a tenant the actor administers; anything else is not found, so ids are not probed. */
async function uploaderAdmitted(db: SecurityAdminDb, actor: SecurityActor, tenantKey: string, userId: string): Promise<boolean | null> {
  if (!actorAdministers(actor, tenantKey) || !UUID_RE.test(userId)) return false;
  const result = await callRpc(db, 'rag_security_uploader_in_tenant', { p_tenant_key: tenantKey, p_user_id: userId.toLowerCase() });
  if (!result.ok) return null;
  return result.data === true;
}

async function holdSince(db: SecurityAdminDb, tenantKey: string, userId: string): Promise<string | null> {
  try {
    return (await activeHolds(db, [tenantKey])).get(`${tenantKey}|${userId}`) ?? null;
  } catch {
    return null;
  }
}

export interface UploaderHoldState {
  tenantKey: string;
  userId: string;
  held: boolean;
  heldSince: string | null;
}

/** D-46: places a hold. Off mode refuses with hold_disabled; a second hold answers already_held. */
export async function holdUploader(
  db: SecurityAdminDb,
  actor: SecurityActor,
  input: { tenantKey: string; userId: string; reason?: string | null },
  settings: SecuritySettings,
): Promise<SecurityResult<{ state: UploaderHoldState }>> {
  const admitted = await uploaderAdmitted(db, actor, input.tenantKey, input.userId);
  if (admitted === null) return { ok: false, reason: 'unavailable' };
  if (!admitted) return { ok: false, reason: 'not_found' };
  if (settings.holdMode === 'off') return { ok: false, reason: 'hold_disabled' };
  const userId = input.userId.toLowerCase();
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const word = await statusWord(db, 'rag_hold_uploader', { p_tenant_key: input.tenantKey, p_user_id: userId, p_actor: actor.userId, p_reason: reason });
  console.log('[RAG Admin] uploader hold', { tenant: input.tenantKey, uploader: userId, actor: actor.userId, status: word ?? 'unavailable' });
  if (word === null) return { ok: false, reason: 'unavailable' };
  if (word === 'already_held') return { ok: false, reason: 'already_held' };
  return { ok: true, state: { tenantKey: input.tenantKey, userId, held: true, heldSince: await holdSince(db, input.tenantKey, userId) } };
}

/** D-46: releases a hold; held uploads stay pending_review until an admin approves them. A second release answers not_held. */
export async function releaseUploaderHold(
  db: SecurityAdminDb,
  actor: SecurityActor,
  input: { tenantKey: string; userId: string },
): Promise<SecurityResult<{ state: UploaderHoldState }>> {
  const admitted = await uploaderAdmitted(db, actor, input.tenantKey, input.userId);
  if (admitted === null) return { ok: false, reason: 'unavailable' };
  if (!admitted) return { ok: false, reason: 'not_found' };
  const userId = input.userId.toLowerCase();
  const word = await statusWord(db, 'rag_release_uploader_hold', { p_tenant_key: input.tenantKey, p_user_id: userId, p_actor: actor.userId });
  console.log('[RAG Admin] uploader hold released', { tenant: input.tenantKey, uploader: userId, actor: actor.userId, status: word ?? 'unavailable' });
  if (word === null) return { ok: false, reason: 'unavailable' };
  if (word === 'not_held') return { ok: false, reason: 'not_held' };
  return { ok: true, state: { tenantKey: input.tenantKey, userId, held: false, heldSince: null } };
}

/** D-45: acknowledges an alert of one of the actor's tenants; another tenant's alert and an unknown id are both not found. */
export async function acknowledgeSecurityAlert(
  db: SecurityAdminDb,
  actor: SecurityActor,
  alertId: string,
): Promise<SecurityResult<{ alertId: string; tenantKey: string }>> {
  if (!UUID_RE.test(alertId) || actor.tenantKeys.length === 0) return { ok: false, reason: 'not_found' };
  const id = alertId.toLowerCase();
  let tenantKey: string | null = null;
  try {
    const { data, error } = await db.from('rag_security_alerts').select('id,tenant_key').eq('id', id).limit(1);
    if (error) return { ok: false, reason: 'unavailable' };
    const row = rowsOf(data)[0];
    tenantKey = row && typeof row.tenant_key === 'string' ? row.tenant_key : null;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (tenantKey === null || !actorAdministers(actor, tenantKey)) return { ok: false, reason: 'not_found' };
  const word = await statusWord(db, 'rag_acknowledge_security_alert', { p_tenant_key: tenantKey, p_alert_id: id, p_actor: actor.userId });
  console.log('[RAG Admin] security alert acknowledged', { tenant: tenantKey, alert: id, actor: actor.userId, status: word ?? 'unavailable' });
  if (word === null) return { ok: false, reason: 'unavailable' };
  if (word === 'not_found') return { ok: false, reason: 'not_found' };
  if (word === 'already_acknowledged') return { ok: false, reason: 'already_acknowledged' };
  return { ok: true, alertId: id, tenantKey };
}

export interface LinkPreviewDeps {
  /** The WhatsApp service's preview hosts, or null when it is not configured or did not answer. */
  previewHosts: () => Promise<string[] | null>;
  allowlistValue: string | undefined;
  siteUrl: string | undefined;
  timeoutMs?: number;
}

async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * D-40: compares the WhatsApp service's preview hosts (getLinkPreviewHosts) with the output allowlist through the Phase 3.2 parser, with
 * its subdomain rule. Host names only; no target is fetched.
 */
export async function linkPreviewStatus(deps: LinkPreviewDeps): Promise<LinkPreviewStatus> {
  const raw = await withTimeout(deps.previewHosts, deps.timeoutMs ?? PREVIEW_TIMEOUT_MS);
  if (raw === null) return { state: 'unknown', preview_hosts: [], hosts_not_allowlisted: [] };
  const hosts = [...new Set(raw.map((host) => normalizeHost(host)).filter((host): host is string => host !== null && HOST_NAME_RE.test(host)))];
  if (hosts.length === 0) return { state: 'none', preview_hosts: [], hosts_not_allowlisted: [] };
  const allowlist = parseLinkAllowlist(deps.allowlistValue, deps.siteUrl);
  const outside = hosts.filter((host) => !isAllowedHost(host, allowlist));
  return LinkPreviewStatusSchema.parse({ state: outside.length > 0 ? 'mismatch' : 'subset', preview_hosts: hosts, hosts_not_allowlisted: outside });
}

const CHECK_REASONS = ['output_guard', 'version_conflict'] as const;
type CheckReason = (typeof CHECK_REASONS)[number];

export function checkReasonOf(item: Pick<ReviewItem, 'reasons'>): CheckReason | null {
  const reasons = item.reasons ?? [];
  return CHECK_REASONS.find((reason) => (reasons as readonly string[]).includes(reason)) ?? null;
}

export interface ReviewSnapshotReader {
  from(table: string): { select(columns: string): FilterBuilder };
}

/**
 * D-55, D-47: the check, the documents (id, file name) and their uploaders of a review item raised by output_guard or version_conflict.
 * The snapshot is read with the caller's client, so RLS decides again; documents and chunks are read on the admin client only under the
 * item's tenant. Null for any other item, which then returns exactly as before.
 */
export async function checkItemDetails(
  ssr: ReviewSnapshotReader,
  db: SecurityAdminDb,
  item: Pick<ReviewItem, 'id' | 'tenant_key' | 'reasons'>,
  actor: { deploymentAdmin: boolean },
): Promise<ReviewCheckDetails | null> {
  const check = checkReasonOf(item);
  if (check === null) return null;
  const { data, error } = await ssr.from('rag_review_items').select('id,tenant_key,snapshot').eq('id', item.id).limit(1);
  if (error) throw new Error('review_snapshot_read_failed');
  const row = rowsOf(data)[0];
  if (!row || row.tenant_key !== item.tenant_key) return null;
  const snapshot = row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot) ? (row.snapshot as Row) : {};
  const tenantKey = item.tenant_key;
  const chunkIds = strings(snapshot, 'chunk_ids').map(uuidOrNull).filter((id): id is string => id !== null).slice(0, 50);
  const documentIds = strings(snapshot, 'document_ids').map(uuidOrNull).filter((id): id is string => id !== null);
  if (chunkIds.length > 0) {
    const chunks = await db.from('document_chunks').select('id,document_id,tenant_key').in('id', chunkIds);
    if (chunks.error) throw new Error('review_chunks_read_failed');
    for (const chunk of rowsOf(chunks.data)) {
      const documentId = uuidOrNull(chunk.document_id);
      if (documentId && (chunk.tenant_key === tenantKey || chunk.tenant_key === null)) documentIds.push(documentId);
    }
  }
  const ordered = [...new Set(documentIds)].slice(0, 50);
  const documents = await documentRows(db, ordered.map((documentId) => ({ documentId, tenantKey })));
  const uploaders = await resolveUploaderViews(db, [...documents.values()].map((document) => uuidOrNull(document.user_id)), actor);
  const detector = text(snapshot, 'detector');
  return ReviewCheckDetailsSchema.parse({
    check,
    detector: detector && /^[a-z][a-z0-9_]{0,63}$/.test(detector) ? detector : null,
    documents: ordered.map((documentId) => {
      const document = documents.get(documentId);
      const uploaderId = document ? uuidOrNull(document.user_id) : null;
      const uploader = uploaderId ? uploaders.get(uploaderId) : undefined;
      return {
        document_id: documentId,
        file_name: document ? text(document, 'filename') : null,
        uploader_id: uploaderId,
        uploader_name: uploader?.name ?? null,
        uploader_email: uploader?.email ?? null,
      };
    }),
  });
}
