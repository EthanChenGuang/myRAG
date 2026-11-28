import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient } from '../../backend/supabase-rpc';
import { getRagDeps } from '../../deps';
import type { UploadApprovalMode } from '../config';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import { afterPublish } from '../post-publish';

/**
 * Admin service for held uploads (SEC-09, D-36, D-37, D-50). Every call names the actor the route guard verified and the workspace tenant
 * key the guard admitted; the SQL functions check the actor again (rag_upload_approval_keys), so the database stays the final authority.
 * Only the fixed reason words of the SQL functions leave this module, never a database message. Logs carry ids and counts only.
 */
export type ApprovalFailure =
  | 'not_found'
  | 'not_pending'
  | 'superseded_by_newer'
  | 'approve_failed'
  | 'reject_failed'
  | 'invalid_kind'
  | 'invalid_ref'
  | 'invalid_argument'
  | 'unavailable';

export type ApprovalError = { ok: false; reason: ApprovalFailure; detail?: string };

export interface ApprovalScopeInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  /** The workspace the guard admitted the actor for. */
  tenantKey: string;
  signal: AbortSignal;
}

export interface UserDisplay {
  id: string;
  display: string;
}

export interface PendingUpload {
  documentId: string;
  lineageId: string;
  tenantKey: string;
  filename: string;
  source: string;
  docType: string | null;
  version: number;
  uploader: UserDisplay | null;
  uploadedAt: string;
  newVersion: boolean;
}

export interface UploadExemption {
  id: string;
  kind: 'connector' | 'uploader';
  ref: string;
  display: string;
  addedBy: UserDisplay | null;
  addedAt: string;
}

export interface ExemptionChoice {
  ref: string;
  display: string;
}

export type ListPendingUploadsResult =
  | { ok: true; mode: UploadApprovalMode; items: PendingUpload[]; total: number; limit: number; offset: number }
  | ApprovalError;

export type ListExemptionsResult = { ok: true; items: UploadExemption[]; total: number; limit: number; offset: number } | ApprovalError;

export type ExemptionChoicesResult = { ok: true; connector: ExemptionChoice[]; uploader: ExemptionChoice[] } | ApprovalError;

export type ApproveUploadResult =
  | { ok: true; documentId: string; version: number; supersededDocumentId: string | null }
  | ApprovalError;

export type RejectUploadResult = { ok: true; documentId: string; lineageId: string; version: number; outcome: string } | ApprovalError;

export type AddExemptionResult = { ok: true; outcome: 'added' | 'exists'; item: UploadExemption } | ApprovalError;

export type RemoveExemptionResult = { ok: true; id: string } | ApprovalError;

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | ApprovalError;

type LookupClient = Pick<SupabaseClient, 'from' | 'auth'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CHOICES = 200;
const MAX_REF_LENGTH = 512;
const SQL_REASONS = new Set<ApprovalFailure>([
  'not_found',
  'not_pending',
  'superseded_by_newer',
  'approve_failed',
  'reject_failed',
  'invalid_kind',
  'invalid_ref',
]);

function failureOf(message: string | undefined): ApprovalError {
  const match = /^([a-z_]+)(?::\s*([a-z_]+))?/.exec(message ?? '');
  const word = match?.[1] as ApprovalFailure | undefined;
  if (word === undefined || !SQL_REASONS.has(word)) return { ok: false, reason: 'unavailable' };
  return match?.[2] !== undefined && (word === 'approve_failed' || word === 'reject_failed') ? { ok: false, reason: word, detail: match[2] } : { ok: false, reason: word };
}

async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const failure = failureOf(response.error.message);
      if (failure.reason === 'unavailable') console.error('[RAG Admin] upload approval call failed', { rpc, code: response.error.code ?? null });
      return failure;
    }
    return { ok: true, rows: (Array.isArray(response.data) ? response.data : []) as Row[] };
  } catch (error) {
    console.error('[RAG Admin] upload approval call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function lookupClient(): LookupClient | null {
  try {
    return getRagDeps().adminClient() as LookupClient | null;
  } catch {
    return null;
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function integer(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function timeOf(row: Row, key: string): string | null {
  const value = row[key];
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function validScope(input: ApprovalScopeInput): boolean {
  return UUID.test(input.actorUserId) && TENANT_KEY.test(input.tenantKey);
}

function totalOf(rows: Row[]): number {
  return rows.length > 0 ? Number(rows[0]?.total_count) : 0;
}

/** Display names for user ids from the auth user record (email, then name), with the id as the fallback. Failures fall back silently. */
export async function displayUsers(ids: Array<string | null>, signal: AbortSignal): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)))];
  const names = new Map<string, string>(unique.map((id) => [id, id]));
  const client = lookupClient();
  if (!client || unique.length === 0) return names;
  await Promise.all(
    unique.map(async (id) => {
      try {
        signal.throwIfAborted();
        const { data } = await client.auth.admin.getUserById(id);
        const user = data?.user;
        const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
        const label = [user?.email, meta.full_name, meta.name].find((value): value is string => typeof value === 'string' && value.trim() !== '');
        if (label) names.set(id, label.trim());
      } catch {
        // the id stays the display
      }
    }),
  );
  return names;
}

function userDisplay(id: string | null, names: Map<string, string>): UserDisplay | null {
  return id === null ? null : { id, display: names.get(id) ?? id };
}

/**
 * The document's tenant, read on the admin client, must be the workspace the guard admitted. An unknown id and another workspace's id give
 * the same not_found, and nothing is called.
 */
async function documentInWorkspace(documentId: string, tenantKey: string, signal: AbortSignal): Promise<{ ok: true } | ApprovalError> {
  const client = lookupClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const { data, error } = await client.from('documents').select('tenant_key').eq('id', documentId).abortSignal(signal).maybeSingle();
    if (error) return { ok: false, reason: 'unavailable' };
    const row = (data ?? null) as Row | null;
    return row !== null && row.tenant_key === tenantKey ? { ok: true } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function pendingOf(row: Row, names: Map<string, string>): PendingUpload | null {
  const documentId = text(row, 'document_id');
  const lineageId = text(row, 'lineage_id');
  const tenantKey = text(row, 'tenant_key');
  const version = integer(row, 'version');
  const uploadedAt = timeOf(row, 'uploaded_at');
  if (documentId === null || lineageId === null || tenantKey === null || version === null || uploadedAt === null) return null;
  return {
    documentId,
    lineageId,
    tenantKey,
    filename: text(row, 'filename') ?? '',
    source: text(row, 'source') ?? '',
    docType: text(row, 'doc_type'),
    version,
    uploader: userDisplay(text(row, 'uploader_id'), names),
    uploadedAt,
    newVersion: row.new_version === true,
  };
}

/** Pending uploads of one workspace, oldest first, one page, with the approval mode the process runs with. */
export async function listPendingUploads(input: ApprovalScopeInput & { limit?: number; offset?: number }): Promise<ListPendingUploadsResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  const actor = input.actorUserId.toLowerCase();
  const limit = clamp(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(input.offset, 0, 0, 1_000_000);
  const args = (pageLimit: number, pageOffset: number) => ({ p_actor: actor, p_tenant_key: input.tenantKey, p_limit: pageLimit, p_offset: pageOffset });

  const page = await call('rag_list_pending_uploads', args(limit, offset), input.signal);
  if (!page.ok) return page;
  let total = totalOf(page.rows);
  if (page.rows.length === 0 && offset > 0) {
    const first = await call('rag_list_pending_uploads', args(1, 0), input.signal);
    if (!first.ok) return first;
    total = totalOf(first.rows);
  }
  if (!Number.isFinite(total)) return { ok: false, reason: 'unavailable' };
  const names = await displayUsers(page.rows.map((row) => text(row, 'uploader_id')), input.signal);
  const items: PendingUpload[] = [];
  for (const row of page.rows) {
    const item = pendingOf(row, names);
    if (item === null) return { ok: false, reason: 'unavailable' };
    items.push(item);
  }
  return { ok: true, mode: currentIngestConfig().uploadApproval, items, total, limit, offset };
}

/**
 * Approves one held upload: the database stamps the approver, publishes the version and writes the audit row. Post-publish work
 * (supersession detection, translation) is started the way a normal publish starts it, without delaying the answer.
 */
export async function approveUpload(input: ApprovalScopeInput & { documentId: string }): Promise<ApproveUploadResult> {
  if (!validScope(input) || !UUID.test(input.documentId)) return { ok: false, reason: 'invalid_argument' };
  const documentId = input.documentId.toLowerCase();
  const inWorkspace = await documentInWorkspace(documentId, input.tenantKey, input.signal);
  if (!inWorkspace.ok) return inWorkspace;
  const result = await call('rag_approve_upload', { p_document_id: documentId, p_actor: input.actorUserId.toLowerCase() }, input.signal);
  if (!result.ok) return result;
  const row = result.rows[0];
  const approvedId = row ? text(row, 'document_id') : null;
  const version = row ? integer(row, 'version') : null;
  if (!row || approvedId === null || version === null || text(row, 'outcome') !== 'published') return { ok: false, reason: 'unavailable' };
  void afterPublish({ documentId: approvedId, tenantKey: input.tenantKey });
  return { ok: true, documentId: approvedId, version, supersededDocumentId: text(row, 'superseded_document_id') };
}

/** Rejects one held upload through the soft delete; the current version of its lineage, if any, stays in use. */
export async function rejectUpload(input: ApprovalScopeInput & { documentId: string }): Promise<RejectUploadResult> {
  if (!validScope(input) || !UUID.test(input.documentId)) return { ok: false, reason: 'invalid_argument' };
  const documentId = input.documentId.toLowerCase();
  const inWorkspace = await documentInWorkspace(documentId, input.tenantKey, input.signal);
  if (!inWorkspace.ok) return inWorkspace;
  const result = await call('rag_reject_upload', { p_document_id: documentId, p_actor: input.actorUserId.toLowerCase() }, input.signal);
  if (!result.ok) return result;
  const row = result.rows[0];
  const rejectedId = row ? text(row, 'document_id') : null;
  const lineageId = row ? text(row, 'lineage_id') : null;
  const version = row ? integer(row, 'version') : null;
  const outcome = row ? text(row, 'outcome') : null;
  if (!row || rejectedId === null || lineageId === null || version === null || outcome === null) return { ok: false, reason: 'unavailable' };
  return { ok: true, documentId: rejectedId, lineageId, version, outcome };
}

// Exemptions

interface WorkspaceUsers {
  /** null: every user of a single-tenant deployment. */
  ids: string[] | null;
}

async function workspaceUsers(client: LookupClient, tenantKey: string, signal: AbortSignal): Promise<WorkspaceUsers> {
  if (tenantKey === 's:default') return { ids: null };
  const id = tenantKey.slice(2);
  if (tenantKey.startsWith('u:')) return { ids: [id] };
  const { data, error } = await client.from('organization_members').select('user_id').eq('organization_id', id).abortSignal(signal);
  if (error) throw new Error('[RAG Admin] organization members lookup failed');
  return { ids: ((data ?? []) as Row[]).map((row) => text(row, 'user_id')).filter((value): value is string => value !== null) };
}

async function connectionRows(client: LookupClient, users: WorkspaceUsers, signal: AbortSignal, connectionId?: string): Promise<Row[]> {
  if (users.ids !== null && users.ids.length === 0) return [];
  let builder = client.from('nango_connections').select('connection_id, provider, user_id');
  if (connectionId !== undefined) builder = builder.eq('connection_id', connectionId);
  if (users.ids !== null) builder = builder.in('user_id', users.ids);
  const { data, error } = await builder.limit(MAX_CHOICES).abortSignal(signal);
  if (error) throw new Error('[RAG Admin] connections lookup failed');
  return (data ?? []) as Row[];
}

function connectionDisplay(row: Row): string {
  const provider = text(row, 'provider');
  const connection = text(row, 'connection_id') ?? '';
  return provider ? `${provider} (${connection})` : connection;
}

async function connectionNames(client: LookupClient | null, refs: string[], signal: AbortSignal): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!client || refs.length === 0) return names;
  try {
    const { data, error } = await client
      .from('nango_connections')
      .select('connection_id, provider, user_id')
      .in('connection_id', refs)
      .abortSignal(signal);
    if (error) return names;
    for (const row of (data ?? []) as Row[]) {
      const ref = text(row, 'connection_id');
      if (ref !== null) names.set(ref, connectionDisplay(row));
    }
  } catch {
    // the ref stays the display
  }
  return names;
}

function exemptionOf(row: Row, users: Map<string, string>, connections: Map<string, string>): UploadExemption | null {
  const id = text(row, 'id');
  const kind = text(row, 'kind');
  const ref = text(row, 'ref');
  const addedAt = timeOf(row, 'created_at');
  if (id === null || ref === null || addedAt === null || (kind !== 'connector' && kind !== 'uploader')) return null;
  return {
    id,
    kind,
    ref,
    display: kind === 'uploader' ? users.get(ref) ?? ref : connections.get(ref) ?? ref,
    addedBy: userDisplay(text(row, 'created_by'), users),
    addedAt,
  };
}

async function exemptionsOf(rows: Row[], signal: AbortSignal): Promise<UploadExemption[] | null> {
  const users = await displayUsers(
    rows.flatMap((row) => [text(row, 'created_by'), text(row, 'kind') === 'uploader' ? text(row, 'ref') : null]),
    signal,
  );
  const connectorRefs = rows.filter((row) => text(row, 'kind') === 'connector').map((row) => text(row, 'ref')).filter((ref): ref is string => ref !== null);
  const connections = await connectionNames(lookupClient(), [...new Set(connectorRefs)], signal);
  const items: UploadExemption[] = [];
  for (const row of rows) {
    const item = exemptionOf(row, users, connections);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** Exemptions of one workspace, oldest first, one page. */
export async function listExemptions(input: ApprovalScopeInput & { limit?: number; offset?: number }): Promise<ListExemptionsResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  const limit = clamp(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(input.offset, 0, 0, 1_000_000);
  const page = await call(
    'rag_upload_exemption_list',
    { p_actor: input.actorUserId.toLowerCase(), p_tenant_key: input.tenantKey, p_limit: limit, p_offset: offset },
    input.signal,
  );
  if (!page.ok) return page;
  const total = totalOf(page.rows);
  if (!Number.isFinite(total)) return { ok: false, reason: 'unavailable' };
  const items = await exemptionsOf(page.rows, input.signal);
  if (items === null) return { ok: false, reason: 'unavailable' };
  return { ok: true, items, total, limit, offset };
}

/** What a new exemption of this workspace may name: its connections and its users (organization members, or the workspace owner). */
export async function exemptionChoices(input: ApprovalScopeInput): Promise<ExemptionChoicesResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  const client = lookupClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    const users = await workspaceUsers(client, input.tenantKey, input.signal);
    let userIds: string[];
    if (users.ids !== null) {
      userIds = users.ids.slice(0, MAX_CHOICES);
    } else {
      const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: MAX_CHOICES });
      if (error) return { ok: false, reason: 'unavailable' };
      userIds = (data?.users ?? []).map((user) => user.id).filter((id) => UUID.test(id));
    }
    const names = await displayUsers(userIds, input.signal);
    const connections = await connectionRows(client, users, input.signal);
    const connector = connections
      .map((row) => ({ ref: text(row, 'connection_id'), display: connectionDisplay(row) }))
      .filter((choice): choice is ExemptionChoice => choice.ref !== null);
    return { ok: true, connector, uploader: userIds.map((id) => ({ ref: id, display: names.get(id) ?? id })) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** A ref names an existing connection or user of the workspace; anything else is invalid_ref before the database is asked. */
async function refBelongsToWorkspace(client: LookupClient, input: ApprovalScopeInput, kind: 'connector' | 'uploader', ref: string): Promise<boolean> {
  const users = await workspaceUsers(client, input.tenantKey, input.signal);
  if (kind === 'connector') return (await connectionRows(client, users, input.signal, ref)).length > 0;
  if (!UUID.test(ref)) return false;
  const id = ref.toLowerCase();
  if (users.ids !== null) return users.ids.map((value) => value.toLowerCase()).includes(id);
  const { data, error } = await client.auth.admin.getUserById(id);
  if (error && !/not.?found/i.test(error.message ?? '')) throw new Error('[RAG Admin] user lookup failed');
  return typeof data?.user?.id === 'string';
}

export async function addExemption(input: ApprovalScopeInput & { kind: string; ref: string }): Promise<AddExemptionResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  if (input.kind !== 'connector' && input.kind !== 'uploader') return { ok: false, reason: 'invalid_kind' };
  const kind = input.kind;
  const ref = kind === 'uploader' ? input.ref.trim().toLowerCase() : input.ref.trim();
  if (ref === '' || ref.length > MAX_REF_LENGTH) return { ok: false, reason: 'invalid_ref' };
  const client = lookupClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    if (!(await refBelongsToWorkspace(client, input, kind, ref))) return { ok: false, reason: 'invalid_ref' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const result = await call(
    'rag_upload_exemption_add',
    { p_actor: input.actorUserId.toLowerCase(), p_tenant_key: input.tenantKey, p_kind: kind, p_ref: ref },
    input.signal,
  );
  if (!result.ok) return result;
  const row = result.rows[0];
  const outcome = row ? text(row, 'outcome') : null;
  const items = row ? await exemptionsOf([row], input.signal) : null;
  if (!row || (outcome !== 'added' && outcome !== 'exists') || items === null || items.length !== 1) return { ok: false, reason: 'unavailable' };
  return { ok: true, outcome, item: items[0] as UploadExemption };
}

export async function removeExemption(input: ApprovalScopeInput & { exemptionId: string }): Promise<RemoveExemptionResult> {
  if (!validScope(input) || !UUID.test(input.exemptionId)) return { ok: false, reason: 'invalid_argument' };
  const exemptionId = input.exemptionId.toLowerCase();
  const client = lookupClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    const { data, error } = await client
      .from('rag_upload_approval_exemptions')
      .select('tenant_key')
      .eq('id', exemptionId)
      .abortSignal(input.signal)
      .maybeSingle();
    if (error) return { ok: false, reason: 'unavailable' };
    if (((data ?? null) as Row | null)?.tenant_key !== input.tenantKey) return { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const result = await call('rag_upload_exemption_remove', { p_actor: input.actorUserId.toLowerCase(), p_exemption_id: exemptionId }, input.signal);
  if (!result.ok) return result;
  const removed = result.rows[0] ? text(result.rows[0], 'id') : null;
  return removed === null ? { ok: false, reason: 'unavailable' } : { ok: true, id: removed };
}
