import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { getLanguagePack } from '../../lang/registry';
import { getLanguageSettings } from '../../lang/settings';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import { renderTemplateHeader, type TemplateRow } from '../text/embedding-text';
import type { IngestAttributeValues } from '../types';
import { listAttributeDefinitions, type AttributeAdminInput } from './schema';

/**
 * The tenant attribute header (TPL-05, D-26, D-27): the template service over migration 1006, the tenant-keyed template cache, rendering
 * through renderTemplateHeader, the stamp, and the batched header reads the text builders use. Logs and errors carry ids, counts, the
 * template version and code words only, never a template, a header or a value.
 */

export const ATTRIBUTE_HEADER_STAMP_KEY = 'attribute_header_stamp';
/** The metadata value that clears a chunk's stamp column (trigger rag_chunk_attribute_header_stamp). */
export const ATTRIBUTE_HEADER_STAMP_NONE = 'none';
export const HEADER_TEMPLATE_MAX_LENGTH = 200;
export const RENDERED_HEADER_MAX_LENGTH = 500;
export const HEADER_READ_PAGE = 1000;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const PLACEHOLDER_NAME = /^[a-z][a-z0-9_]*$/;
const STAMP = /^t[0-9]{1,9}\.[0-9a-f]{12}$/;
const FALLBACK_LANGUAGE = 'en';
const FALLBACK_SEPARATOR = ', ';
const LOG_ADMIN = '[RAG Admin]';
const LOG_INGEST = '[Ingest]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

type Row = Record<string, unknown>;

/** RAG_ATTRIBUTE_HEADER, effective: needs RAG_DOC_ATTRIBUTES and the unified pipeline (plan 03.3-02). */
export function attributeHeaderEnabled(config: IngestConfig = currentIngestConfig()): boolean {
  return config.attributeHeader;
}

/** Placeholder names in template order, without repeats, as renderTemplateHeader finds them (malformed names included). */
export function placeholdersOf(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The list separator of the deployment's primary language pack (en when no primary language is set). */
export function headerListSeparator(): string {
  let primary: string | null = null;
  try {
    primary = getLanguageSettings().primary;
  } catch {
    primary = null;
  }
  return (primary ? getLanguagePack(primary)?.list_separator : undefined) ?? getLanguagePack(FALLBACK_LANGUAGE)?.list_separator ?? FALLBACK_SEPARATOR;
}

export interface RenderedAttributeHeader {
  /** The rendered line; empty when no segment has all its values. */
  header: string;
  /** The template's placeholder names with the value rendered for each (lists joined), null where the document has none. */
  row: Record<string, string | null>;
}

function valueOf(value: unknown, separator: string): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string');
    return items.length === 0 ? null : items.join(separator);
  }
  return null;
}

/**
 * Renders the header of one document: a row of exactly the template's placeholder names, lists joined with the separator, then
 * renderTemplateHeader per segment; trailing segments are dropped while the result is longer than 500 characters.
 */
export function renderAttributeHeader(
  template: string,
  attributes: IngestAttributeValues | Record<string, unknown> | null | undefined,
  separator: string,
): RenderedAttributeHeader {
  const row: Record<string, string | null> = {};
  for (const name of placeholdersOf(template)) {
    const raw = attributes && Object.hasOwn(attributes, name) ? (attributes as Record<string, unknown>)[name] : null;
    row[name] = valueOf(raw, separator);
  }
  const segments: string[] = [];
  try {
    for (const segment of template.split('|')) {
      const rendered = renderTemplateHeader(segment, row as TemplateRow);
      if (rendered !== '') segments.push(rendered);
    }
  } catch {
    return { header: '', row };
  }
  let header = segments.join(' | ');
  while (segments.length > 0 && [...header].length > RENDERED_HEADER_MAX_LENGTH) {
    segments.pop();
    header = segments.join(' | ');
  }
  return { header, row };
}

/** t<template version>.<first 12 hex of sha256 over the canonical JSON of the rendered row>. */
export function attributeHeaderStamp(version: number, row: Record<string, string | null>): string {
  return `t${version}.${createHash('sha256').update(canonicalJson(row), 'utf8').digest('hex').slice(0, 12)}`;
}

export function isAttributeHeaderStamp(value: unknown): value is string {
  return typeof value === 'string' && STAMP.test(value);
}

// --- Template service --------------------------------------------------------------------------------------------------------------

export interface HeaderTemplate {
  template: string;
  version: number;
}

export type HeaderTemplateFailure = 'not_admin' | 'unknown_placeholder' | 'invalid_argument' | 'unavailable';

export type HeaderTemplateError =
  | { ok: false; reason: Exclude<HeaderTemplateFailure, 'unknown_placeholder'> }
  | { ok: false; reason: 'unknown_placeholder'; placeholders: string[] };

export type GetHeaderTemplateResult =
  | { ok: true; template: string | null; version: number; updatedAt: string | null }
  | HeaderTemplateError;

export type SetHeaderTemplateResult = { ok: true; template: string | null; version: number } | HeaderTemplateError;

const SQL_REASONS = new Set<HeaderTemplateFailure>(['not_admin', 'unknown_placeholder', 'invalid_argument']);

function failureOf(message: string | undefined): HeaderTemplateError {
  const word = /^[a-z_]+(?=$|[^a-z_])/.exec(message ?? '')?.[0] as HeaderTemplateFailure | undefined;
  if (word === 'unknown_placeholder') return { ok: false, reason: 'unknown_placeholder', placeholders: [] };
  return { ok: false, reason: word !== undefined && SQL_REASONS.has(word) ? (word as 'not_admin' | 'invalid_argument') : 'unavailable' };
}

async function adminCall(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: true; rows: Row[] } | HeaderTemplateError> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const failure = failureOf(response.error.message);
      if (failure.reason === 'unavailable') console.error(`${LOG_ADMIN} attribute header call failed`, { rpc, code: response.error.code ?? null });
      return failure;
    }
    return { ok: true, rows: rpcRows(response.data) as Row[] };
  } catch (error) {
    console.error(`${LOG_ADMIN} attribute header call failed`, { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function normalizedInput(input: AttributeAdminInput): { actor: string; tenantKey: string } | null {
  if (typeof input?.actorUserId !== 'string' || typeof input.tenantKey !== 'string') return null;
  const actor = input.actorUserId.toLowerCase();
  const tenantKey = input.tenantKey.toLowerCase();
  return UUID.test(actor) && TENANT_KEY.test(tenantKey) ? { actor, tenantKey } : null;
}

function timeOf(raw: unknown): string | null {
  const time = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
  return time === null || Number.isNaN(time.getTime()) ? null : time.toISOString();
}

function templateRowOf(row: Row | undefined): HeaderTemplate | null {
  if (!row || typeof row.template !== 'string' || typeof row.version !== 'number' || !Number.isInteger(row.version) || row.version < 1) return null;
  return { template: row.template, version: row.version };
}

/** The admitted tenant's template; template null and version 0 while none is saved (or for an actor who is not its admin). */
export async function getHeaderTemplate(input: AttributeAdminInput): Promise<GetHeaderTemplateResult> {
  const scope = normalizedInput(input);
  if (!scope) return { ok: false, reason: 'invalid_argument' };
  const result = await adminCall('rag_attribute_header_template_get', { p_actor: scope.actor, p_tenant_key: scope.tenantKey }, input.signal);
  if (!result.ok) return result;
  if (result.rows.length === 0) return { ok: true, template: null, version: 0, updatedAt: null };
  const stored = templateRowOf(result.rows[0]);
  if (stored === null) {
    console.error(`${LOG_ADMIN} attribute header row malformed`, { rpc: 'rag_attribute_header_template_get' });
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, ...stored, updatedAt: timeOf(result.rows[0]?.updated_at) };
}

/**
 * Saves (or, with null, removes) the admitted tenant's template. A template over 200 characters is refused before any database call;
 * placeholders outside the tenant's in_header keys are refused with their names before the write. Invalidates only this tenant's entry.
 */
export async function setHeaderTemplate(input: AttributeAdminInput, template: string | null): Promise<SetHeaderTemplateResult> {
  const scope = normalizedInput(input);
  if (!scope) return { ok: false, reason: 'invalid_argument' };
  if (template !== null && (typeof template !== 'string' || template.length === 0 || [...template].length > HEADER_TEMPLATE_MAX_LENGTH)) {
    return { ok: false, reason: 'invalid_argument' };
  }
  if (template !== null) {
    const definitions = await listAttributeDefinitions({ actorUserId: scope.actor, tenantKey: scope.tenantKey, signal: input.signal });
    if (!definitions.ok) {
      return definitions.reason === 'not_admin' || definitions.reason === 'invalid_argument'
        ? { ok: false, reason: definitions.reason }
        : { ok: false, reason: 'unavailable' };
    }
    const allowed = new Set(definitions.items.filter((item) => item.in_header).map((item) => item.key));
    const unknown = placeholdersOf(template).filter((name) => !PLACEHOLDER_NAME.test(name) || !allowed.has(name));
    if (unknown.length > 0) return { ok: false, reason: 'unknown_placeholder', placeholders: unknown };
  }
  const result = await adminCall(
    'rag_attribute_header_template_set',
    { p_actor: scope.actor, p_tenant_key: scope.tenantKey, p_template: template },
    input.signal,
  );
  if (!result.ok) {
    if (result.reason === 'unknown_placeholder' && template !== null) return { ok: false, reason: 'unknown_placeholder', placeholders: placeholdersOf(template) };
    return result;
  }
  invalidateHeaderTemplate(scope.tenantKey);
  if (template === null) {
    console.info(`${LOG_ADMIN} attribute header template removed`);
    return { ok: true, template: null, version: 0 };
  }
  const stored = templateRowOf(result.rows[0]);
  if (stored === null) {
    console.error(`${LOG_ADMIN} attribute header row malformed`, { rpc: 'rag_attribute_header_template_set' });
    return { ok: false, reason: 'unavailable' };
  }
  console.info(`${LOG_ADMIN} attribute header template saved`, { version: stored.version });
  return { ok: true, ...stored };
}

// --- Tenant-keyed template cache -----------------------------------------------------------------------------------------------------

export type LoadHeaderTemplateResult = { ok: true; template: HeaderTemplate | null } | { ok: false; reason: 'unavailable' };

const CACHE_MAX_TENANTS = 256;
const CACHE_TTL_MS = 60_000;
const FAILURE_TTL_MS = 5_000;

interface CacheEntry {
  value: LoadHeaderTemplateResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const generations = new Map<string, number>();
const UNAVAILABLE: LoadHeaderTemplateResult = Object.freeze({ ok: false, reason: 'unavailable' }) as LoadHeaderTemplateResult;

export function invalidateHeaderTemplate(tenantKey: string): void {
  const key = tenantKey.toLowerCase();
  cache.delete(key);
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

export function resetHeaderTemplateCacheForTests(): void {
  cache.clear();
  generations.clear();
}

async function readTemplate(db: RpcClient | null, tenantKey: string, signal: AbortSignal): Promise<LoadHeaderTemplateResult> {
  if (!db) return UNAVAILABLE;
  try {
    signal.throwIfAborted();
    const response = await db.rpc('rag_attribute_header_template_for', { p_tenant_key: tenantKey }).abortSignal(signal);
    if (response.error) {
      console.error(`${LOG_INGEST} attribute header template read failed`, { code: response.error.code ?? null });
      return UNAVAILABLE;
    }
    const found = rpcRows(response.data) as Row[];
    if (found.length === 0) return Object.freeze({ ok: true, template: null }) as LoadHeaderTemplateResult;
    const stored = templateRowOf(found[0]);
    if (stored === null) {
      console.error(`${LOG_INGEST} attribute header template row malformed`);
      return UNAVAILABLE;
    }
    return Object.freeze({ ok: true, template: Object.freeze(stored) }) as LoadHeaderTemplateResult;
  } catch (error) {
    if (signal.aborted) throw error;
    console.error(`${LOG_INGEST} attribute header template read failed`, { error: error instanceof Error ? error.name : 'unknown' });
    return UNAVAILABLE;
  }
}

/**
 * The tenant's template from a least-recently-used map keyed by the tenant key only (256 tenants, 60 s; 5 s after a failed load). An
 * entry loaded for one tenant is never served to another.
 */
export async function loadHeaderTemplate(
  tenantKey: string,
  options: { signal: AbortSignal; db?: RpcClient | null; fresh?: boolean },
): Promise<LoadHeaderTemplateResult> {
  const key = typeof tenantKey === 'string' ? tenantKey.toLowerCase() : '';
  if (!TENANT_KEY.test(key)) return UNAVAILABLE;
  const now = getIngestDeps().now();
  if (options.fresh !== true) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    }
  }
  const generation = generations.get(key) ?? 0;
  const value = await readTemplate(options.db === undefined ? getIngestDeps().db() : options.db, key, options.signal);
  if (options.signal.aborted) return value;
  if ((generations.get(key) ?? 0) === generation) {
    cache.delete(key);
    cache.set(key, { value, expiresAt: now + (value.ok ? CACHE_TTL_MS : FAILURE_TTL_MS) });
    while (cache.size > CACHE_MAX_TENANTS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return value;
}

// --- Batched reads -------------------------------------------------------------------------------------------------------------------

export interface StoredAttributeHeader {
  header: string;
  stamp: string;
}

export interface HeaderReadOptions {
  signal: AbortSignal;
  config?: IngestConfig;
  db?: RpcClient | null;
}

async function readPage(db: RpcClient, args: Record<string, unknown>, signal: AbortSignal): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc('rag_attribute_headers', args).abortSignal(signal);
  if (response.error) {
    console.error(`${LOG_INGEST} attribute header read failed`, { code: response.error.code ?? null });
    throw new Error('attribute_header_read_failed');
  }
  return rpcRows(response.data) as Row[];
}

/** Header and stamp of the tenant's stamped documents; an empty map without any call while the switch is effectively off. */
export async function documentHeadersFor(
  tenantKey: string,
  documentIds: readonly string[],
  options: HeaderReadOptions,
): Promise<Map<string, StoredAttributeHeader>> {
  const found = new Map<string, StoredAttributeHeader>();
  if (!attributeHeaderEnabled(options.config) || documentIds.length === 0) return found;
  const db = options.db === undefined ? getIngestDeps().db() : options.db;
  if (!db) throw new Error('attribute_header_read_failed');
  const ids = [...new Set(documentIds)];
  for (let start = 0; start < ids.length; start += HEADER_READ_PAGE) {
    const page = await readPage(db, { p_tenant_key: tenantKey, p_document_ids: ids.slice(start, start + HEADER_READ_PAGE) }, options.signal);
    for (const row of page) {
      if (typeof row.document_id === 'string' && typeof row.header === 'string' && isAttributeHeaderStamp(row.stamp)) {
        found.set(row.document_id, { header: row.header, stamp: row.stamp });
      }
    }
  }
  return found;
}

/**
 * The header of each chunk whose own stamp equals its document's, read per tenant key of the chunks given and in pages of 1,000 ids; an
 * empty map without any call while the switch is effectively off.
 */
export async function chunkHeadersFor(
  chunks: ReadonlyArray<{ chunkId: string; tenantKey: string }>,
  options: HeaderReadOptions,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!attributeHeaderEnabled(options.config) || chunks.length === 0) return found;
  const db = options.db === undefined ? getIngestDeps().db() : options.db;
  if (!db) throw new Error('attribute_header_read_failed');
  const byTenant = new Map<string, string[]>();
  for (const chunk of chunks) {
    const list = byTenant.get(chunk.tenantKey) ?? [];
    if (!list.includes(chunk.chunkId)) list.push(chunk.chunkId);
    byTenant.set(chunk.tenantKey, list);
  }
  for (const [tenantKey, ids] of byTenant) {
    for (let start = 0; start < ids.length; start += HEADER_READ_PAGE) {
      const page = await readPage(db, { p_tenant_key: tenantKey, p_chunk_ids: ids.slice(start, start + HEADER_READ_PAGE) }, options.signal);
      for (const row of page) {
        if (typeof row.chunk_id === 'string' && typeof row.header === 'string') found.set(row.chunk_id, row.header);
      }
    }
  }
  return found;
}

export interface StaleHeaderDocument {
  documentId: string;
  docType: string;
  stamp: string | null;
  staleChunks: number;
}

export type ListStaleHeaderDocumentsResult = { ok: true; items: StaleHeaderDocument[]; more: boolean } | { ok: false; reason: 'unavailable' };

/** Current, ready documents of the tenant that serve a chunk whose stamp differs from the document's (at most 499 per page). */
export async function listStaleHeaderDocuments(
  tenantKey: string,
  options: { signal: AbortSignal; profileId?: string | null; after?: string | null; limit?: number; db?: RpcClient | null },
): Promise<ListStaleHeaderDocumentsResult> {
  const db = options.db === undefined ? getIngestDeps().db() : options.db;
  if (!db) return { ok: false, reason: 'unavailable' };
  const limit = Math.max(1, Math.min(499, Math.trunc(options.limit ?? 200)));
  try {
    options.signal.throwIfAborted();
    const response = await db
      .rpc('rag_attribute_header_stale', {
        p_tenant_key: tenantKey,
        p_profile_id: options.profileId ?? null,
        p_after: options.after ?? null,
        p_limit: limit + 1,
      })
      .abortSignal(options.signal);
    if (response.error) {
      console.error(`${LOG_INGEST} attribute header stale listing failed`, { code: response.error.code ?? null });
      return { ok: false, reason: 'unavailable' };
    }
    const found = (rpcRows(response.data) as Row[]).map((row) => ({
      documentId: String(row.document_id),
      docType: String(row.doc_type),
      stamp: typeof row.stamp === 'string' ? row.stamp : null,
      staleChunks: typeof row.stale_chunks === 'number' ? row.stale_chunks : Number(row.stale_chunks ?? 0),
    }));
    return { ok: true, items: found.slice(0, limit), more: found.length > limit };
  } catch (error) {
    if (options.signal.aborted) throw error;
    console.error(`${LOG_INGEST} attribute header stale listing failed`, { error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}
