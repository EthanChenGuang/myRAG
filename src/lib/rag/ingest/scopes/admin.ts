import type { RpcClient } from '../../backend/supabase-rpc';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';

/**
 * Admin service for scope tags (DATA-18, D-38, D-40, D-50). Tags narrow retrieval inside the caller's already verified tenant; they are not
 * access control and grant or hide nothing. Every call names the actor the route guard verified and the one workspace tenant key the guard
 * admitted; the SQL functions check the actor again (rag_upload_approval_keys), so the database stays the final authority. Only the fixed
 * reason words of the SQL functions leave this module, never a database message. Logs carry codes only.
 */
export const SCOPE_DIMENSIONS = ['region', 'legal_entity', 'department'] as const;
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

/** Maximum tags on one document (UI-SPEC 6.7; also enforced in rag_set_document_scopes). */
export const MAX_DOCUMENT_SCOPES = 20;

/** RAG_SCOPE_TAGS: while false the admin routes answer 404 and nothing is written. */
export function scopeTagsEnabled(): boolean {
  return currentIngestConfig().scopeTags;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The slug a vocabulary value is stored as, the twin of rag_scope_slug: lower case, every run of characters other than a-z and 0-9 becomes
 * one hyphen, no leading or trailing hyphen. Returns null when nothing valid remains (no ASCII letter or digit, or longer than 64).
 */
export function normalizeScopeValue(raw: string): string | null {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 && slug.length <= 64 && SLUG.test(slug) ? slug : null;
}

export type ScopeFailure =
  | 'not_found'
  | 'not_admin'
  | 'tag_exists'
  | 'unknown_scope_value'
  | 'too_many_scopes'
  | 'value_immutable'
  | 'invalid_dimension'
  | 'invalid_value'
  | 'invalid_label'
  | 'invalid_aliases'
  | 'invalid_argument'
  | 'unavailable';

export type ScopeError = { ok: false; reason: ScopeFailure };

export interface ScopeAdminInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  /** The workspace the guard admitted the actor for. */
  tenantKey: string;
  signal: AbortSignal;
}

export interface VocabularyEntry {
  id: string;
  dimension: ScopeDimension;
  value: string;
  label: string;
  aliases: string[];
  active: boolean;
  updatedAt: string;
}

export type ListVocabularyResult = { ok: true; items: VocabularyEntry[] } | ScopeError;
export type VocabularyEntryResult = { ok: true; item: VocabularyEntry } | ScopeError;
export type SetDocumentScopesResult = { ok: true; documentId: string; scopes: string[]; chunksUpdated: number } | ScopeError;

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | ScopeError;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SQL_REASONS = new Set<ScopeFailure>([
  'not_found',
  'not_admin',
  'tag_exists',
  'unknown_scope_value',
  'too_many_scopes',
  'value_immutable',
  'invalid_dimension',
  'invalid_value',
  'invalid_label',
  'invalid_aliases',
  'invalid_argument',
]);

function failureOf(message: string | undefined): ScopeError {
  const word = /^[a-z_]+/.exec(message ?? '')?.[0] as ScopeFailure | undefined;
  return { ok: false, reason: word !== undefined && SQL_REASONS.has(word) ? word : 'unavailable' };
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
      if (failure.reason === 'unavailable') console.error('[RAG Admin] scope tag call failed', { rpc, code: response.error.code ?? null });
      return failure;
    }
    return { ok: true, rows: (Array.isArray(response.data) ? response.data : []) as Row[] };
  } catch (error) {
    console.error('[RAG Admin] scope tag call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function strings(row: Row, key: string): string[] | null {
  const value = row[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

function timeOf(row: Row, key: string): string | null {
  const value = row[key];
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function isDimension(value: unknown): value is ScopeDimension {
  return typeof value === 'string' && (SCOPE_DIMENSIONS as readonly string[]).includes(value);
}

function validScope(input: ScopeAdminInput): boolean {
  return UUID.test(input.actorUserId) && TENANT_KEY.test(input.tenantKey);
}

function entryOf(row: Row): VocabularyEntry | null {
  const id = text(row, 'id');
  const dimension = row.dimension;
  const value = text(row, 'value');
  const label = text(row, 'label');
  const aliases = strings(row, 'aliases');
  const updatedAt = timeOf(row, 'updated_at');
  if (id === null || !isDimension(dimension) || value === null || label === null || aliases === null || updatedAt === null) return null;
  if (typeof row.active !== 'boolean') return null;
  return { id, dimension, value, label, aliases, active: row.active, updatedAt };
}

function oneEntry(result: Call): VocabularyEntryResult {
  if (!result.ok) return result;
  const item = result.rows.length === 1 ? entryOf(result.rows[0] as Row) : null;
  return item === null ? { ok: false, reason: 'unavailable' } : { ok: true, item };
}

/** The workspace's vocabulary in dimension order, then label. */
export async function listVocabulary(input: ScopeAdminInput): Promise<ListVocabularyResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  const result = await call('rag_scope_vocabulary_list', { p_actor: input.actorUserId.toLowerCase(), p_tenant_key: input.tenantKey }, input.signal);
  if (!result.ok) return result;
  const items: VocabularyEntry[] = [];
  for (const row of result.rows) {
    const item = entryOf(row);
    if (item === null) return { ok: false, reason: 'unavailable' };
    items.push(item);
  }
  return { ok: true, items };
}

export interface CreateVocabularyEntryInput extends ScopeAdminInput {
  dimension: ScopeDimension;
  value: string;
  label: string;
  aliases: string[];
}

/** Creates one value; the value is normalized to its slug first (the database normalizes again and stays the authority). */
export async function createVocabularyEntry(input: CreateVocabularyEntryInput): Promise<VocabularyEntryResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  const value = normalizeScopeValue(input.value);
  if (value === null) return { ok: false, reason: 'invalid_value' };
  return oneEntry(
    await call(
      'rag_scope_vocabulary_create',
      {
        p_actor: input.actorUserId.toLowerCase(),
        p_tenant_key: input.tenantKey,
        p_dimension: input.dimension,
        p_value: value,
        p_label: input.label,
        p_aliases: input.aliases,
      },
      input.signal,
    ),
  );
}

export interface UpdateVocabularyEntryInput extends ScopeAdminInput {
  id: string;
  label?: string;
  aliases?: string[];
  active?: boolean;
  /** When given, must equal the stored dimension: the dimension and value of an entry never change. */
  dimension?: ScopeDimension;
  value?: string;
}

export async function updateVocabularyEntry(input: UpdateVocabularyEntryInput): Promise<VocabularyEntryResult> {
  if (!validScope(input) || !UUID.test(input.id)) return { ok: false, reason: 'invalid_argument' };
  return oneEntry(
    await call(
      'rag_scope_vocabulary_update',
      {
        p_actor: input.actorUserId.toLowerCase(),
        p_tenant_key: input.tenantKey,
        p_id: input.id.toLowerCase(),
        p_label: input.label ?? null,
        p_aliases: input.aliases ?? null,
        p_active: input.active ?? null,
        p_dimension: input.dimension ?? null,
        p_value: input.value ?? null,
      },
      input.signal,
    ),
  );
}

export interface SetDocumentScopesInput extends ScopeAdminInput {
  documentId: string;
  /** The complete tag list, dimension:value strings; an empty list clears the document's tags. */
  scopes: string[];
}

/** Writes the document's complete tag list and its chunks' copy in one transaction; the cache entries naming the document are dropped. */
export async function setDocumentScopes(input: SetDocumentScopesInput): Promise<SetDocumentScopesResult> {
  if (!validScope(input) || !UUID.test(input.documentId)) return { ok: false, reason: 'invalid_argument' };
  const result = await call(
    'rag_set_document_scopes',
    { p_document_id: input.documentId.toLowerCase(), p_tenant_key: input.tenantKey, p_scopes: input.scopes, p_actor: input.actorUserId.toLowerCase() },
    input.signal,
  );
  if (!result.ok) return result;
  const row = result.rows.length === 1 ? (result.rows[0] as Row) : null;
  const documentId = row ? text(row, 'document_id') : null;
  const scopes = row ? strings(row, 'scopes') : null;
  const chunksUpdated = row?.chunks_updated;
  if (documentId === null || scopes === null || typeof chunksUpdated !== 'number') return { ok: false, reason: 'unavailable' };
  return { ok: true, documentId, scopes, chunksUpdated };
}

export const DOCUMENT_VIEWS = ['all', 'suggested', 'untagged'] as const;
export type DocumentView = (typeof DOCUMENT_VIEWS)[number];

export interface ScopeSuggestionItem {
  dimension: ScopeDimension;
  value: string;
  source: 'rule' | 'model';
}

export interface TaggedDocument {
  documentId: string;
  filename: string;
  docType: string | null;
  status: string;
  version: number;
  scopes: string[];
  suggestions: ScopeSuggestionItem[];
  uploadedAt: string;
}

export type ListDocumentsWithScopesResult =
  | { ok: true; items: TaggedDocument[]; total: number; suggestedTotal: number; limit: number; offset: number }
  | ScopeError;

export interface ListDocumentsWithScopesInput extends ScopeAdminInput {
  /** dimension:value tags; OR within a dimension, AND across dimensions. Null or empty: no tag filter. */
  scopes: string[] | null;
  /** File-name search; % and _ are literal. */
  query: string | null;
  view: DocumentView;
  limit?: number;
  offset?: number;
}

const DEFAULT_DOCUMENT_PAGE = 50;
const MAX_DOCUMENT_PAGE = 100;
const MAX_SUGGESTIONS = 30;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/** Only the three named fields of a well-formed suggestion item (ScopeTagSuggestionItem); anything else is dropped. */
function suggestionsOf(value: unknown): ScopeSuggestionItem[] {
  if (!Array.isArray(value)) return [];
  const items: ScopeSuggestionItem[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const { dimension, value: slug, source } = item as Row;
    if (!isDimension(dimension) || typeof slug !== 'string' || !SLUG.test(slug) || (source !== 'rule' && source !== 'model')) continue;
    items.push({ dimension, value: slug, source });
    if (items.length === MAX_SUGGESTIONS) break;
  }
  return items;
}

function taggedDocumentOf(row: Row): TaggedDocument | null {
  const documentId = text(row, 'id');
  const scopes = strings(row, 'scopes');
  const uploadedAt = timeOf(row, 'uploaded_at');
  const version = row.version;
  if (documentId === null || scopes === null || uploadedAt === null || typeof version !== 'number') return null;
  return {
    documentId,
    filename: text(row, 'filename') ?? '',
    docType: text(row, 'doc_type'),
    status: text(row, 'status') ?? '',
    version,
    scopes,
    suggestions: suggestionsOf(row.suggestions),
    uploadedAt,
  };
}

/** Current documents of the workspace with their tags and stored suggestions, newest first, one page; never any document text. */
export async function listDocumentsWithScopes(input: ListDocumentsWithScopesInput): Promise<ListDocumentsWithScopesResult> {
  if (!validScope(input) || !(DOCUMENT_VIEWS as readonly string[]).includes(input.view)) return { ok: false, reason: 'invalid_argument' };
  const limit = clamp(input.limit, DEFAULT_DOCUMENT_PAGE, 1, MAX_DOCUMENT_PAGE);
  const offset = clamp(input.offset, 0, 0, 1_000_000);
  const scopes = input.scopes && input.scopes.length > 0 ? [...new Set(input.scopes)].sort() : null;
  const query = input.query?.trim() ? input.query.trim() : null;
  const args = (pageLimit: number, pageOffset: number) => ({
    p_actor: input.actorUserId.toLowerCase(),
    p_tenant_key: input.tenantKey,
    p_scopes: scopes,
    p_query: query,
    p_limit: pageLimit,
    p_offset: pageOffset,
    p_filter: input.view,
  });

  const page = await call('rag_list_documents_with_scopes', args(limit, offset), input.signal);
  if (!page.ok) return page;
  let counts: Row | undefined = page.rows[0];
  if (counts === undefined && offset > 0) {
    const first = await call('rag_list_documents_with_scopes', args(1, 0), input.signal);
    if (!first.ok) return first;
    counts = first.rows[0];
  }
  const total = counts === undefined ? 0 : Number(counts.total_count);
  const suggestedTotal = counts === undefined ? 0 : Number(counts.suggested_count);
  if (!Number.isFinite(total) || !Number.isFinite(suggestedTotal)) return { ok: false, reason: 'unavailable' };
  const items: TaggedDocument[] = [];
  for (const row of page.rows) {
    const item = taggedDocumentOf(row);
    if (item === null) return { ok: false, reason: 'unavailable' };
    items.push(item);
  }
  return { ok: true, items, total, suggestedTotal, limit, offset };
}
