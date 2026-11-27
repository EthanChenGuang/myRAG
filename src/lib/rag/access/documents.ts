import type { TenantScope } from '../tenant/scope';
import {
  badResponse,
  callAccessRows,
  count,
  refused,
  rowId,
  stringArray,
  tenantKeyOf,
  text,
  timestamp,
  UUID_RE,
  uuidOf,
  type AccessServiceDeps,
  type Row,
} from './errors';

export type AccessAudienceKind = 'everyone' | 'uploader_only' | 'groups';
export type AccessDocumentFilter = 'restricted' | 'uploader_only' | 'everyone' | 'all';

/** The audience view of one current document (0924). Group names are the admin's to see; this is an admin-only read. */
export interface DocumentAudience {
  documentId: string;
  filename: string | null;
  docType: string | null;
  status: string | null;
  createdAt: string | null;
  kind: AccessAudienceKind;
  groupIds: string[];
  groupNames: string[];
  peopleCount: number;
  fallbackReason: string | null;
  connectorManaged: boolean;
  source: string | null;
}

export interface AccessDocumentPage {
  documents: DocumentAudience[];
  nextCursor: string | null;
}

export interface AccessDocumentCounts {
  restricted: number;
  uploaderOnly: number;
  everyone: number;
  all: number;
}

/** Either everyone, or groups by id. Keys are never accepted from the caller: this module builds them. */
export type DocumentsAccessInput = { documentIds: readonly string[] } & ({ everyone: true } | { groupIds: readonly string[] });

export interface SetDocumentsAccessResult {
  changed: number;
  /** Connector-managed documents; their access follows the source (D-20). */
  skipped: number;
  /** Ids that are not a document of this tenant. */
  notFound: number;
  /** The new audience of every changed document. */
  audiences: DocumentAudience[];
}

export interface UploadAccessOutcome {
  documentId: string;
  outcome: 'changed' | 'unchanged';
  keys: string[];
}

export const ACCESS_DOCUMENTS_MAX_IDS = 500;
export const ACCESS_DOCUMENTS_PAGE_SIZE = 50;
const ACCESS_FILTERS: readonly AccessDocumentFilter[] = ['restricted', 'uploader_only', 'everyone', 'all'];
const ACCESS_KEY_RE = /^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const CURSOR_MAX = 600;
const QUERY_MAX = 200;
const SETTER = 'rag_set_document_access_groups';

function documentIdsOf(rpc: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ACCESS_DOCUMENTS_MAX_IDS) throw refused(rpc, 'invalid_argument');
  return [...new Set(value.map((item) => uuidOf(rpc, item)))];
}

function relabelKeysOf(rpc: string, input: DocumentsAccessInput): string[] {
  if ('everyone' in input && input.everyone === true) return ['all'];
  const ids = 'groupIds' in input ? input.groupIds : null;
  if (!Array.isArray(ids) || ids.length === 0) throw refused(rpc, 'empty_access');
  const keys = ids.map((item) => {
    const id = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!UUID_RE.test(id)) throw refused(rpc, 'empty_access');
    return `g:${id}`;
  });
  return [...new Set(keys)].sort();
}

function kindOf(rpc: string, value: unknown): AccessAudienceKind {
  if (value === 'everyone' || value === 'uploader_only' || value === 'groups') return value;
  throw badResponse(rpc);
}

function parseAudience(rpc: string, row: Row): DocumentAudience {
  return {
    documentId: rowId(rpc, row.document_id),
    filename: text(row, 'filename'),
    docType: text(row, 'doc_type'),
    status: text(row, 'status'),
    createdAt: timestamp(row, 'created_at'),
    kind: kindOf(rpc, row.kind),
    groupIds: stringArray(row.group_ids).map((id) => rowId(rpc, id)),
    groupNames: stringArray(row.group_names),
    peopleCount: count(row, 'people_count'),
    fallbackReason: text(row, 'fallback_reason'),
    connectorManaged: row.connector_managed === true,
    source: text(row, 'source'),
  };
}

/** The audience view of the given current documents of the caller's tenant; ids of other tenants or superseded versions are left out. */
export async function documentAudiences(scope: TenantScope, documentIds: readonly string[], deps: AccessServiceDeps): Promise<DocumentAudience[]> {
  const rpc = 'rag_access_document_audience';
  const tenantKey = tenantKeyOf(scope);
  if (Array.isArray(documentIds) && documentIds.length === 0) return [];
  const ids = documentIdsOf(rpc, documentIds);
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_document_ids: ids });
  return rows.map((row) => parseAudience(rpc, row));
}

/**
 * D-17: an admin relabels documents to everyone or to groups named by id. Connector-managed documents are skipped (counted); a call on a single
 * connector-managed document raises access_managed_by_connector, and on a single unknown id not_found. The actor is the admin the route guard
 * verified.
 */
export async function setDocumentsAccess(
  scope: TenantScope,
  input: DocumentsAccessInput,
  actorId: string,
  deps: AccessServiceDeps,
): Promise<SetDocumentsAccessResult> {
  const tenantKey = tenantKeyOf(scope);
  const ids = documentIdsOf(SETTER, input?.documentIds);
  const keys = relabelKeysOf(SETTER, input);
  const actor = uuidOf(SETTER, actorId, 'actor_required');
  const rows = await callAccessRows(deps, SETTER, {
    p_tenant_key: tenantKey,
    p_document_ids: ids,
    p_keys: keys,
    p_actor: actor,
    p_actor_kind: 'admin',
    p_reason: 'admin_set',
  });

  const changedIds: string[] = [];
  let skipped = 0;
  let notFound = 0;
  for (const row of rows) {
    const outcome = text(row, 'outcome');
    if (outcome === 'changed') changedIds.push(rowId(SETTER, row.document_id));
    else if (outcome === 'skipped_connector') skipped += 1;
    else if (outcome === 'not_found') notFound += 1;
    else if (outcome !== 'unchanged') throw badResponse(SETTER);
  }
  if (ids.length === 1 && skipped === 1) throw refused(SETTER, 'access_managed_by_connector');
  if (ids.length === 1 && notFound === 1) throw refused(SETTER, 'not_found');

  const audiences = changedIds.length > 0 ? await documentAudiences(scope, changedIds, deps) : [];
  console.log('[RAG Access] documents relabelled', { changed: changedIds.length, skipped, notFound });
  return { changed: changedIds.length, skipped, notFound, audiences };
}

/**
 * D-16, A-07: applies the label an uploader chose (already limited by uploadAccessKeys) to the new document, with actor kind system and reason
 * upload. The uploader id is the verified session's.
 */
export async function setUploadAccess(
  scope: TenantScope,
  documentId: string,
  keys: readonly string[],
  uploaderId: string,
  deps: AccessServiceDeps,
): Promise<UploadAccessOutcome> {
  const tenantKey = tenantKeyOf(scope);
  const id = uuidOf(SETTER, documentId, 'not_found');
  if (!Array.isArray(keys) || keys.length === 0) throw refused(SETTER, 'empty_access');
  const normalised = keys.map((key) => (typeof key === 'string' ? key.trim().toLowerCase() : ''));
  if (normalised.some((key) => !ACCESS_KEY_RE.test(key))) throw refused(SETTER, 'empty_access');
  const label = normalised.includes('all') ? ['all'] : [...new Set(normalised)].sort();
  const actor = uuidOf(SETTER, uploaderId, 'actor_required');
  const rows = await callAccessRows(deps, SETTER, {
    p_tenant_key: tenantKey,
    p_document_ids: [id],
    p_keys: label,
    p_actor: actor,
    p_actor_kind: 'system',
    p_reason: 'upload',
  });
  const row = rows[0];
  const outcome = row ? text(row, 'outcome') : null;
  if (outcome === 'not_found') throw refused(SETTER, 'not_found');
  if (outcome !== 'changed' && outcome !== 'unchanged') throw badResponse(SETTER);
  return { documentId: id, outcome, keys: stringArray(row?.after_groups) };
}

function filterOf(rpc: string, value: unknown): AccessDocumentFilter {
  if (value === undefined || value === null || value === '') return 'all';
  if (typeof value === 'string' && (ACCESS_FILTERS as readonly string[]).includes(value)) return value as AccessDocumentFilter;
  throw refused(rpc, 'invalid_filter');
}

function queryOf(value: unknown): string | null {
  const query = typeof value === 'string' ? value.trim().slice(0, QUERY_MAX) : '';
  return query === '' ? null : query;
}

/** The admin document list (Config UI): current documents with their audience, filtered and searched by file name, paged by cursor. */
export async function listAccessDocuments(
  scope: TenantScope,
  input: { filter?: AccessDocumentFilter | string | null; query?: string | null; cursor?: string | null; limit?: number },
  deps: AccessServiceDeps,
): Promise<AccessDocumentPage> {
  const rpc = 'rag_access_documents_list';
  const tenantKey = tenantKeyOf(scope);
  const filter = filterOf(rpc, input.filter);
  const cursor = input.cursor === undefined || input.cursor === null || input.cursor === '' ? null : input.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > CURSOR_MAX || !/^[A-Za-z0-9+/=]+$/.test(cursor))) throw refused(rpc, 'invalid_cursor');
  const limit = Math.min(Math.max(typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : ACCESS_DOCUMENTS_PAGE_SIZE, 1), ACCESS_DOCUMENTS_PAGE_SIZE);
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_filter: filter, p_query: queryOf(input.query), p_cursor: cursor, p_limit: limit });
  const last = rows[rows.length - 1];
  return { documents: rows.map((row) => parseAudience(rpc, row)), nextCursor: rows.length === limit && last ? text(last, 'cursor') : null };
}

/** The four filter counts, under the same optional file-name query as the list. */
export async function documentAccessCounts(scope: TenantScope, input: { query?: string | null }, deps: AccessServiceDeps): Promise<AccessDocumentCounts> {
  const rpc = 'rag_access_documents_counts';
  const tenantKey = tenantKeyOf(scope);
  const rows = await callAccessRows(deps, rpc, { p_tenant_key: tenantKey, p_query: queryOf(input?.query) });
  const row = rows[0];
  if (!row) throw badResponse(rpc);
  return { restricted: count(row, 'restricted'), uploaderOnly: count(row, 'uploader_only'), everyone: count(row, 'everyone'), all: count(row, 'all') };
}
