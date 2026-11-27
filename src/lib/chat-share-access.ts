import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  accessGroupsEnabled,
  parseTenantKey,
  resolveAccessScope,
  resolveTenantScope,
  scopeKey,
  visibleDocumentIds,
} from '@/lib/rag';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_RE = /^Bearer\s+(\S+)$/i;
const MAX_IDS = 500;
const MAX_IMAGE_URLS = 200;
const MAX_URL_LENGTH = 2048;
const LOOKUP_TIMEOUT_MS = 10_000;

type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: unknown };

/** The service-role reads this module makes; a test injects a fake. */
export interface ShareAccessDeps {
  db?: () => ShareAccessDb | null;
  signal?: AbortSignal;
}

interface ShareQuery extends PromiseLike<QueryResult> {
  select(columns: string): ShareQuery;
  eq(column: string, value: unknown): ShareQuery;
  in(column: string, values: readonly unknown[]): ShareQuery;
  abortSignal(signal: AbortSignal): ShareQuery;
}

export interface ShareAccessDb {
  from(table: string): ShareQuery;
}

/** The chat row as the share and read paths load it. */
export interface SharedChatSource {
  id?: unknown;
  messages?: unknown;
}

export interface CitedRefs {
  documentIds: string[];
  imageUrls: string[];
}

export interface CitedDocument {
  id: string;
  lineageId: string;
  tenantKey: string | null;
  accessGroups: unknown;
  isCurrent: boolean;
}

export type ShareRefusal = 'restricted' | 'unavailable' | null;

function asRecord(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function addId(out: Set<string>, value: unknown): void {
  if (typeof value === 'string' && UUID_RE.test(value.trim())) out.add(value.trim().toLowerCase());
}

function addDocuments(out: Set<string>, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const entry of list) addId(out, asRecord(entry)?.id);
}

function addImages(out: Set<string>, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    const url = asRecord(entry)?.url;
    if (typeof url === 'string' && url.length > 0 && url.length <= MAX_URL_LENGTH) out.add(url);
  }
}

function addCitations(out: Set<string>, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    const citation = asRecord(entry);
    if (!citation) continue;
    addId(out, citation.documentId);
    if (Array.isArray(citation.alsoIn)) for (const dup of citation.alsoIn) addId(out, asRecord(dup)?.documentId);
  }
}

function addCarrier(ids: Set<string>, urls: Set<string>, carrier: Row | null): void {
  if (!carrier) return;
  addDocuments(ids, carrier.usedDocuments);
  addDocuments(ids, carrier.documents);
  addImages(urls, carrier.source_images);
  addImages(urls, carrier.images);
  addCitations(ids, carrier.citations);
}

/**
 * D-27: the documents a chat names, from citation metadata, used-document and document-reference parts, source images and the citations
 * of the chat's answer records. A message without any of these carries nothing that can be checked.
 */
export function citedDocumentIds(messages: unknown, answerCitations: readonly unknown[] = []): CitedRefs {
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const message of Array.isArray(messages) ? messages : []) {
    const record = asRecord(message);
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    addCarrier(ids, urls, metadata);
    addCarrier(ids, urls, record);
    for (const key of ['content', 'parts']) {
      const parts = record[key];
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const value = asRecord(part);
        addCarrier(ids, urls, value);
        addCarrier(ids, urls, asRecord(value?.metadata));
        addCarrier(ids, urls, asRecord(value?.data));
      }
    }
  }
  for (const citations of answerCitations) addCitations(ids, citations);
  return { documentIds: [...ids], imageUrls: [...urls] };
}

function dbOf(deps: ShareAccessDeps): ShareAccessDb | null {
  if (deps.db) return deps.db();
  return getSupabaseAdmin() as unknown as ShareAccessDb | null;
}

async function rowsOf(query: PromiseLike<QueryResult>): Promise<Row[]> {
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw new Error('lookup');
  return data.filter((row): row is Row => asRecord(row) !== null);
}

function lower(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.toLowerCase() : null;
}

function toCited(row: Row): CitedDocument | null {
  const id = lower(row.id);
  if (!id) return null;
  return {
    id,
    lineageId: lower(row.lineage_id) ?? id,
    tenantKey: typeof row.tenant_key === 'string' ? row.tenant_key : null,
    accessGroups: row.access_groups,
    isCurrent: row.is_current === true,
  };
}

const DOCUMENT_COLUMNS = 'id, lineage_id, tenant_key, access_groups, is_current';

/** Every version of every lineage the chat cites; null when a lookup failed (callers fail closed). */
export async function loadCitedDocuments(chat: SharedChatSource, deps: ShareAccessDeps = {}): Promise<CitedDocument[] | null> {
  const db = dbOf(deps);
  if (!db) return null;
  const signal = deps.signal ?? AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  try {
    const answerCitations: unknown[] = [];
    const chatId = lower(chat.id);
    if (chatId && UUID_RE.test(chatId)) {
      const records = await rowsOf(db.from('rag_answer_records').select('citations').eq('chat_id', chatId).abortSignal(signal));
      for (const record of records) answerCitations.push(record.citations);
    }
    const refs = citedDocumentIds(chat.messages, answerCitations);
    const ids = new Set(refs.documentIds);
    if (refs.imageUrls.length > 0) {
      const urls = refs.imageUrls.slice(0, MAX_IMAGE_URLS);
      const chunks = await rowsOf(db.from('document_chunks').select('document_id').in('metadata->>image_url', urls).abortSignal(signal));
      for (const chunk of chunks) addId(ids, chunk.document_id);
      if (refs.imageUrls.length > MAX_IMAGE_URLS) throw new Error('too_many');
    }
    if (ids.size === 0) return [];
    if (ids.size > MAX_IDS) throw new Error('too_many');

    const named = await rowsOf(db.from('documents').select(DOCUMENT_COLUMNS).in('id', [...ids]).abortSignal(signal));
    const byId = new Map<string, CitedDocument>();
    for (const row of named) {
      const doc = toCited(row);
      if (doc) byId.set(doc.id, doc);
    }
    const lineages = [...new Set([...byId.values()].map((doc) => doc.lineageId))];
    if (lineages.length > 0) {
      const versions = await rowsOf(db.from('documents').select(DOCUMENT_COLUMNS).in('lineage_id', lineages).abortSignal(signal));
      for (const row of versions) {
        const doc = toCited(row);
        if (doc) byId.set(doc.id, doc);
      }
    }
    return [...byId.values()];
  } catch {
    console.warn('[RAG Access] shared chat lookup failed');
    return null;
  }
}

function labelledAll(groups: unknown): boolean {
  return Array.isArray(groups) && groups.length === 1 && groups[0] === 'all';
}

/** D-27: whether a chat may get (or keep handing out) a share link: refused when any version of a cited lineage is labelled other than all. */
export async function shareRefusal(chat: SharedChatSource, deps: ShareAccessDeps = {}): Promise<ShareRefusal> {
  if (!accessGroupsEnabled()) return null;
  const documents = await loadCitedDocuments(chat, deps);
  if (documents === null) return 'unavailable';
  return documents.some((doc) => !labelledAll(doc.accessGroups)) ? 'restricted' : null;
}

/** The documents the read check applies to: each lineage's current version, or every known version when none is current. */
function documentsToCheck(documents: CitedDocument[]): CitedDocument[] {
  const lineages = new Map<string, CitedDocument[]>();
  for (const doc of documents) lineages.set(doc.lineageId, [...(lineages.get(doc.lineageId) ?? []), doc]);
  const out: CitedDocument[] = [];
  for (const versions of lineages.values()) {
    const current = versions.filter((doc) => doc.isCurrent);
    out.push(...(current.length > 0 ? current : versions));
  }
  return out;
}

async function viewerSeesTenant(tenantKey: string | null, ids: string[], viewerId: string, signal: AbortSignal): Promise<boolean> {
  const tenant = parseTenantKey(tenantKey);
  if (!tenant) return false;
  const resolved = await resolveTenantScope({
    requestedOrganizationId: tenant.kind === 'org' ? tenant.organizationId : null,
    getUser: async () => ({ id: viewerId }),
    signal,
  });
  if (!resolved.ok || !resolved.scope || scopeKey(resolved.scope) !== tenantKey) return false;
  const access = await resolveAccessScope({ scope: resolved.scope, identity: { kind: 'user', userId: viewerId }, signal });
  if (!access.ok) return false;
  const visible = await visibleDocumentIds(access.scope, ids, { signal });
  return visible.ok && ids.every((id) => visible.ids.has(id));
}

/**
 * D-27, A-13: the live read check for a shared chat. With the switch off, or when every current cited document is labelled all, anyone may
 * read it as today. Otherwise the viewer (resolved lazily from the request's own session) must see every current cited document; an
 * anonymous viewer, a lookup failure or an outsider reads it as an unknown share id.
 */
export async function canViewShared(
  chat: SharedChatSource,
  viewer: () => Promise<string | null>,
  deps: ShareAccessDeps = {},
): Promise<boolean> {
  if (!accessGroupsEnabled()) return true;
  const documents = await loadCitedDocuments(chat, deps);
  if (documents === null) return false;
  const checked = documentsToCheck(documents);
  if (checked.every((doc) => labelledAll(doc.accessGroups))) return true;

  const viewerId = await viewer();
  if (viewerId === null) return false;
  const signal = deps.signal ?? AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  try {
    const tenants = new Map<string | null, string[]>();
    for (const doc of checked) tenants.set(doc.tenantKey, [...(tenants.get(doc.tenantKey) ?? []), doc.id]);
    for (const [tenantKey, ids] of tenants) {
      if (!(await viewerSeesTenant(tenantKey, ids, viewerId, signal))) return false;
    }
    return true;
  } catch {
    console.warn('[RAG Access] shared chat check failed');
    return false;
  }
}

/**
 * D-06: the viewer of a shared chat, from the request's own session only: a Bearer access token validated with auth.getUser(token) when an
 * Authorization header is present, otherwise the cookie session. A missing or invalid session is an anonymous viewer (null), never an error.
 */
export async function sharedViewerId(source: { headers?: Headers | null } = {}): Promise<string | null> {
  try {
    const authorization = source.headers?.get('authorization') ?? null;
    let id: unknown = null;
    if (authorization !== null) {
      const match = BEARER_RE.exec(authorization.trim());
      if (!match) return null;
      const admin = getSupabaseAdmin();
      if (!admin) return null;
      const { data, error } = await admin.auth.getUser(match[1]);
      if (error) return null;
      id = data?.user?.id;
    } else {
      const supabase = await createClient();
      const { data, error } = await supabase.auth.getUser();
      if (error) return null;
      id = data?.user?.id;
    }
    return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}
