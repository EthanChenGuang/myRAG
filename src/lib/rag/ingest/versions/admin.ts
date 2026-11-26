import type { RpcClient } from '../../backend/supabase-rpc';
import { getRagDeps } from '../../deps';
import { assertTenantScope, scopeKey, type TenantScope } from '../../tenant/scope';
import { displayUsers } from '../approval/admin';
import { uploaderOf } from '../approval/resolve';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import type { StageContext } from '../types';

/**
 * "Replaces…" at upload and the supersession admin service (DATA-19, D-41, D-50). The uploader may name the document a new upload
 * replaces: the route checks it belongs to the upload's own tenant, is current and is not the upload's own lineage, before anything is
 * stored. The pipeline records the intent on the version; after publish the detector hook raises it (origin uploader) and, when the
 * uploader is an admin of the tenant, confirms it at once. A member's intent stays a pending candidate for an admin. Logs carry ids only.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

/** "Replaces…" counts only under the unified pipeline with RAG_SUPERSESSION_DETECT=on (UI-SPEC decision 9); otherwise it is not offered. */
export function replacesEnabled(config: Pick<IngestConfig, 'pipeline' | 'supersessionDetect'> = currentIngestConfig()): boolean {
  return config.pipeline === 'unified' && config.supersessionDetect === 'on';
}

export type UploadReplacesFailure = 'invalid_replaces' | 'replaces_not_found' | 'replaces_same_lineage' | 'unavailable';

export type ValidateUploadReplacesResult =
  /** replacesDocumentId is undefined when the upload names none or the field is ignored (switch off or legacy pipeline). */
  | { ok: true; replacesDocumentId: string | undefined; ignored: boolean }
  | { ok: false; reason: UploadReplacesFailure };

function single(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Route-side check of the upload's "Replaces…" field, before any document row or stored object exists. The named document must be a
 * current, ready document of the scope's own tenant (another tenant's id and a non-current document get the same replaces_not_found) and
 * must not be the lineage the upload itself writes into (same source and source key).
 */
export async function validateUploadReplaces(
  scope: TenantScope,
  raw: unknown,
  options: { signal: AbortSignal; source: string; sourceKey: string; config?: Pick<IngestConfig, 'pipeline' | 'supersessionDetect'> },
): Promise<ValidateUploadReplacesResult> {
  const value = single(raw);
  if (value === null) return { ok: true, replacesDocumentId: undefined, ignored: false };
  const config = options.config ?? currentIngestConfig();
  if (!replacesEnabled(config)) {
    console.warn('[Ingest] upload replaces ignored', { reason: config.pipeline === 'unified' ? 'supersession_off' : 'legacy_pipeline' });
    return { ok: true, replacesDocumentId: undefined, ignored: true };
  }
  if (!UUID.test(value)) return { ok: false, reason: 'invalid_replaces' };
  assertTenantScope(scope);
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  const documentId = value.toLowerCase();
  try {
    options.signal.throwIfAborted();
    const response = await db
      .rpc('rag_supersession_replace_target', { p_tenant_key: scopeKey(scope).toLowerCase(), p_document_id: documentId })
      .abortSignal(options.signal);
    if (response.error) {
      console.error('[Ingest] upload replaces lookup failed', { code: response.error.code ?? null });
      return { ok: false, reason: 'unavailable' };
    }
    const row = (Array.isArray(response.data) ? response.data[0] : response.data) as Row | null | undefined;
    if (!row || typeof row.document_id !== 'string') return { ok: false, reason: 'replaces_not_found' };
    if (row.source === options.source && row.source_key === options.sourceKey) return { ok: false, reason: 'replaces_same_lineage' };
    return { ok: true, replacesDocumentId: documentId, ignored: false };
  } catch (error) {
    console.error('[Ingest] upload replaces lookup failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

/** Whether a "Replaces…" by this user in this workspace is confirmed at once (an admin of the tenant). A failed lookup answers false. */
export async function replacesConfirmedAtOnce(scope: TenantScope, userId: string, signal: AbortSignal): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return false;
  try {
    signal.throwIfAborted();
    const response = await db
      .rpc('rag_is_tenant_admin', { p_user: userId.toLowerCase(), p_tenant_key: scopeKey(scope).toLowerCase() })
      .abortSignal(signal);
    return !response.error && response.data === true;
  } catch {
    return false;
  }
}

/**
 * Publish stage: records the upload's "Replaces…" intent on the version (metadata.supersession_replaces) before it is published or held,
 * so the post-publish hook finds it after an approval too. confirm is true only when the uploader is an admin of the tenant now; the SQL
 * confirmation checks the actor again. Nothing is written without a replacesDocumentId or with the switch off.
 */
export async function recordReplacesIntent(ctx: StageContext, documentId: string): Promise<void> {
  const target = ctx.input.replacesDocumentId;
  if (typeof target !== 'string' || !UUID.test(target) || ctx.config.supersessionDetect !== 'on') return;
  const actor = uploaderOf(ctx) ?? ctx.state.approval?.uploader_id ?? null;
  let confirm = false;
  if (actor !== null) {
    try {
      confirm = await ctx.writer.isTenantAdmin(actor);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      console.warn('[Ingest] replaces admin check unavailable; leaving the candidate pending', { documentId });
    }
  }
  await ctx.writer.setFields(documentId, {
    metadata: { supersession_replaces: { document_id: target.toLowerCase(), actor, confirm } },
  });
}

// --- Admin service (D-50) -----------------------------------------------------------------------------------------------------------

export type SupersessionAdminFailure =
  | 'not_found'
  | 'already_decided'
  | 'direction_required'
  | 'direction_conflict'
  | 'stale_candidate'
  | 'not_confirmed'
  | 'invalid_argument'
  | 'unavailable';

type AdminError = { ok: false; reason: SupersessionAdminFailure };

export interface SupersessionScopeInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  /** The one workspace the guard admitted the actor for. */
  tenantKey: string;
  signal: AbortSignal;
}

export interface SupersessionDocumentView {
  id: string;
  fileName: string;
  docType: string | null;
  docDate: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  uploadedAt: string | null;
  uploader: { id: string; display: string } | null;
}

export type SupersessionEntry =
  | {
      kind: 'candidate';
      id: string;
      origin: string;
      direction: 'document_newer' | 'candidate_newer' | null;
      stale: boolean;
      signals: { title_match: boolean; content_overlap_percent: number; conflicting_numbers: number };
      document: SupersessionDocumentView | null;
      candidateDocument: SupersessionDocumentView | null;
      createdAt: string | null;
    }
  | {
      kind: 'link';
      id: string;
      linkId: string;
      origin: string;
      older: SupersessionDocumentView | null;
      newer: SupersessionDocumentView | null;
      decidedAt: string | null;
      decidedBy: { id: string; display: string } | null;
    };

const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ADMIN_REASONS = new Set<SupersessionAdminFailure>([
  'not_found',
  'already_decided',
  'direction_required',
  'direction_conflict',
  'stale_candidate',
  'not_confirmed',
]);

function validScope(input: SupersessionScopeInput): boolean {
  return UUID.test(input.actorUserId) && TENANT_KEY.test(input.tenantKey);
}

async function adminCall(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: true; rows: Row[] } | AdminError> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const word = /^[a-z_]+/.exec(response.error.message ?? '')?.[0] as SupersessionAdminFailure | undefined;
      if (word !== undefined && ADMIN_REASONS.has(word)) return { ok: false, reason: word };
      console.error('[RAG Admin] supersession call failed', { rpc, code: response.error.code ?? null });
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, rows: (Array.isArray(response.data) ? response.data : response.data ? [response.data] : []) as Row[] };
  } catch (error) {
    console.error('[RAG Admin] supersession call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

type LookupClient = { from(table: string): unknown };

async function candidateInWorkspace(candidateId: string, tenantKey: string, signal: AbortSignal): Promise<{ ok: true } | AdminError> {
  let client: LookupClient | null = null;
  try {
    client = getRagDeps().adminClient() as LookupClient | null;
  } catch {
    client = null;
  }
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    type Query = { select(c: string): Query; eq(c: string, v: unknown): Query; abortSignal(s: AbortSignal): Query; maybeSingle(): Promise<{ data: unknown; error: unknown }> };
    const query = (client.from('rag_supersession_candidates') as Query).select('tenant_key').eq('id', candidateId).abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) return { ok: false, reason: 'unavailable' };
    const row = (data ?? null) as Row | null;
    return row !== null && row.tenant_key === tenantKey ? { ok: true } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function str(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function timeOf(row: Row, key: string): string | null {
  const value = row[key];
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function dateOf(row: Row, key: string): string | null {
  const value = row[key];
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function documentView(value: unknown, names: Map<string, string>): SupersessionDocumentView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Row;
  const id = str(row, 'id');
  if (id === null) return null;
  const uploaderId = str(row, 'uploader_id');
  return {
    id,
    fileName: str(row, 'filename') ?? '',
    docType: str(row, 'doc_type'),
    docDate: dateOf(row, 'doc_date'),
    effectiveFrom: dateOf(row, 'effective_from'),
    effectiveTo: dateOf(row, 'effective_to'),
    uploadedAt: timeOf(row, 'uploaded_at'),
    uploader: uploaderId === null ? null : { id: uploaderId, display: names.get(uploaderId) ?? uploaderId },
  };
}

/** The named signal fields only; any other key of the stored signals object stays in the database. */
function signalsView(value: unknown): { title_match: boolean; content_overlap_percent: number; conflicting_numbers: number } {
  const row = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Row;
  const count = (key: string, max: number) => {
    const raw = row[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), max) : 0;
  };
  return { title_match: row.title_match === true, content_overlap_percent: count('content_overlap_percent', 100), conflicting_numbers: count('conflicting_numbers', 1_000_000) };
}

function directionOf(value: unknown): 'document_newer' | 'candidate_newer' | null {
  return value === 'document_newer' || value === 'candidate_newer' ? value : null;
}

function uploaderIdOf(value: unknown): string | null {
  return typeof value === 'object' && value !== null ? str(value as Row, 'uploader_id') : null;
}

export type ListSupersessionResult = { ok: true; items: SupersessionEntry[]; total: number; limit: number; offset: number } | AdminError;

/** Pending candidates of one workspace (stale ones flagged) and its confirmed links, one page. Works with the switch off too. */
export async function listSupersession(input: SupersessionScopeInput & { limit?: number; offset?: number }): Promise<ListSupersessionResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit as number, 1), 100) : 50;
  const offset = Number.isInteger(input.offset) ? Math.min(Math.max(input.offset as number, 0), 1_000_000) : 0;
  const page = await adminCall(
    'rag_list_supersession',
    { p_actor: input.actorUserId.toLowerCase(), p_tenant_key: input.tenantKey, p_limit: limit, p_offset: offset },
    input.signal,
  );
  if (!page.ok) return page;
  const names = await displayUsers(
    page.rows.flatMap((row) => [uploaderIdOf(row.document), uploaderIdOf(row.candidate_document), str(row, 'decided_by')]),
    input.signal,
  );
  const items: SupersessionEntry[] = [];
  for (const row of page.rows) {
    const id = str(row, 'candidate_id');
    if (id === null || row.tenant_key !== input.tenantKey) return { ok: false, reason: 'unavailable' };
    const origin = str(row, 'origin') ?? 'detected';
    if (row.kind === 'link') {
      const linkId = str(row, 'link_id');
      if (linkId === null) return { ok: false, reason: 'unavailable' };
      const decidedBy = str(row, 'decided_by');
      items.push({
        kind: 'link',
        id,
        linkId,
        origin,
        older: documentView(row.document, names),
        newer: documentView(row.candidate_document, names),
        decidedAt: timeOf(row, 'decided_at'),
        decidedBy: decidedBy === null ? null : { id: decidedBy, display: names.get(decidedBy) ?? decidedBy },
      });
    } else {
      items.push({
        kind: 'candidate',
        id,
        origin,
        direction: directionOf(row.direction),
        stale: row.stale === true,
        signals: signalsView(row.signals),
        document: documentView(row.document, names),
        candidateDocument: documentView(row.candidate_document, names),
        createdAt: timeOf(row, 'created_at'),
      });
    }
  }
  const total = page.rows.length > 0 ? Number(page.rows[0]?.total_count) : 0;
  return { ok: true, items, total: Number.isFinite(total) ? total : 0, limit, offset };
}

export type ConfirmSupersessionResult = { ok: true; candidateId: string; olderDocumentId: string; newerDocumentId: string } | AdminError;

/**
 * Confirms one candidate of the admitted workspace: the older document leaves retrieval in one transaction (0806). A candidate without a
 * direction needs olderDocumentId (direction_required otherwise). The semantic cache follows from the triggers on is_current.
 */
export async function confirmSupersession(
  input: SupersessionScopeInput & { candidateId: string; olderDocumentId?: string | null },
): Promise<ConfirmSupersessionResult> {
  if (!validScope(input) || !UUID.test(input.candidateId)) return { ok: false, reason: 'invalid_argument' };
  if (input.olderDocumentId !== undefined && input.olderDocumentId !== null && !UUID.test(input.olderDocumentId)) {
    return { ok: false, reason: 'invalid_argument' };
  }
  const candidateId = input.candidateId.toLowerCase();
  const inWorkspace = await candidateInWorkspace(candidateId, input.tenantKey, input.signal);
  if (!inWorkspace.ok) return inWorkspace;
  const result = await adminCall(
    'rag_confirm_supersession',
    { p_candidate_id: candidateId, p_actor: input.actorUserId.toLowerCase(), p_older_document_id: input.olderDocumentId ? input.olderDocumentId.toLowerCase() : null },
    input.signal,
  );
  if (!result.ok) return result;
  const row = result.rows[0];
  const older = row ? str(row, 'older_document_id') : null;
  const newer = row ? str(row, 'newer_document_id') : null;
  if (!row || str(row, 'outcome') !== 'confirmed' || older === null || newer === null) return { ok: false, reason: 'unavailable' };
  return { ok: true, candidateId, olderDocumentId: older, newerDocumentId: newer };
}

export type DismissSupersessionResult = { ok: true; candidateId: string } | AdminError;

/** Dismisses one pending candidate of the admitted workspace; no document changes. */
export async function dismissSupersession(input: SupersessionScopeInput & { candidateId: string }): Promise<DismissSupersessionResult> {
  if (!validScope(input) || !UUID.test(input.candidateId)) return { ok: false, reason: 'invalid_argument' };
  const candidateId = input.candidateId.toLowerCase();
  const inWorkspace = await candidateInWorkspace(candidateId, input.tenantKey, input.signal);
  if (!inWorkspace.ok) return inWorkspace;
  const result = await adminCall('rag_dismiss_supersession', { p_candidate_id: candidateId, p_actor: input.actorUserId.toLowerCase() }, input.signal);
  if (!result.ok) return result;
  if (str(result.rows[0] ?? {}, 'outcome') !== 'dismissed') return { ok: false, reason: 'unavailable' };
  return { ok: true, candidateId };
}

export type UndoSupersessionResult = { ok: true; candidateId: string; olderDocumentId: string; newerDocumentId: string | null } | AdminError;

/** Undoes one confirmation of the admitted workspace: the older document is current again and the candidate pending again. */
export async function undoSupersession(input: SupersessionScopeInput & { candidateId: string }): Promise<UndoSupersessionResult> {
  if (!validScope(input) || !UUID.test(input.candidateId)) return { ok: false, reason: 'invalid_argument' };
  const candidateId = input.candidateId.toLowerCase();
  const inWorkspace = await candidateInWorkspace(candidateId, input.tenantKey, input.signal);
  if (!inWorkspace.ok) return inWorkspace;
  const result = await adminCall('rag_undo_supersession', { p_candidate_id: candidateId, p_actor: input.actorUserId.toLowerCase() }, input.signal);
  if (!result.ok) return result;
  const row = result.rows[0];
  const older = row ? str(row, 'older_document_id') : null;
  if (!row || str(row, 'outcome') !== 'undone' || older === null) return { ok: false, reason: 'unavailable' };
  return { ok: true, candidateId, olderDocumentId: older, newerDocumentId: str(row, 'newer_document_id') };
}
