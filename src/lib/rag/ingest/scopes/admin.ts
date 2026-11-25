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

export async function createVocabularyEntry(input: CreateVocabularyEntryInput): Promise<VocabularyEntryResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  return oneEntry(
    await call(
      'rag_scope_vocabulary_create',
      {
        p_actor: input.actorUserId.toLowerCase(),
        p_tenant_key: input.tenantKey,
        p_dimension: input.dimension,
        p_value: input.value,
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
