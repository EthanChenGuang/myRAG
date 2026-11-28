import type { AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';
import type { TenantIdentifierPatterns } from '../../identifiers/patterns';
import { normalizeIdentifier } from '../../ids/normalize';
import { MAX_CHUNK_IDENTIFIERS, MAX_IDENTIFIER_CHARS, type ChunkIdentifiers } from '../../identifiers/extract';
import { assertTenantScope, scopeKey, type TenantScope } from '../../tenant/scope';

/**
 * TPL-04 identifier feed (D-25, F-13): values of attributes flagged in_identifier_index become identifier entries that the Phase 4.2
 * indexer (indexDocumentForLookup) merges into every chunk's identifier arrays; the document union follows in SQL. This module writes no
 * identifier column itself. Logs carry counts and code words only, never an identifier or a value.
 */

export interface AttributeIdentifierEntry {
  /** The value as stored. */
  raw: string;
  /** normalizeIdentifier(raw). */
  norm: string;
}

/**
 * One entry per flagged attribute with a string value, in key order; an empty normalised form or a form longer than the indexer stores is
 * skipped; two attributes with the same normalised form give one entry (the first key). Only code definitions can be flagged (1001), so a
 * flagged value is one string. Pure.
 */
export function attributeIdentifierEntries(
  definitions: readonly AttributeDefinition[],
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): AttributeIdentifierEntry[] {
  if (!attributes) return [];
  const flagged = new Set(definitions.filter((definition) => definition.in_identifier_index).map((definition) => definition.key));
  if (flagged.size === 0) return [];
  const seen = new Set<string>();
  const entries: AttributeIdentifierEntry[] = [];
  for (const key of Object.keys(attributes).sort()) {
    if (!flagged.has(key)) continue;
    const value = attributes[key];
    if (typeof value !== 'string') continue;
    const norm = normalizeIdentifier(value);
    if (norm === '' || seen.has(norm) || value.length > MAX_IDENTIFIER_CHARS || norm.length > MAX_IDENTIFIER_CHARS) continue;
    seen.add(norm);
    entries.push({ raw: value, norm });
  }
  return entries;
}

/**
 * Appends the attribute entries to every chunk's entries in order, skipping a normalised form the chunk already has; raw and norm stay
 * aligned. The per-chunk cap of the indexer holds: entries past it are counted in truncated. Pure.
 */
export function mergeAttributeIdentifiers(
  chunkEntries: readonly ChunkIdentifiers[],
  attributeEntries: readonly AttributeIdentifierEntry[],
): ChunkIdentifiers[] {
  if (attributeEntries.length === 0) return [...chunkEntries];
  return chunkEntries.map((chunk) => {
    const seen = new Set(chunk.norm);
    const raw = [...chunk.raw];
    const norm = [...chunk.norm];
    let truncated = chunk.truncated;
    for (const entry of attributeEntries) {
      if (seen.has(entry.norm)) continue;
      if (norm.length >= MAX_CHUNK_IDENTIFIERS) {
        truncated += 1;
        continue;
      }
      seen.add(entry.norm);
      raw.push(entry.raw);
      norm.push(entry.norm);
    }
    return { raw, norm, truncated };
  });
}

/** A schema or attribute read failed; the indexer counts it as an identifier failure for the document. */
export class AttributeIdentifierReadError extends Error {
  constructor() {
    super('[Ingest] attribute identifiers could not be read');
    this.name = 'AttributeIdentifierReadError';
  }
}

/**
 * The document's attribute identifier entries for the indexer, read for the scope's tenant only. Null while RAG_DOC_ATTRIBUTES is
 * effectively off (nothing is read) or the tenant has no flagged definition (only the cached schema is read). Throws
 * AttributeIdentifierReadError when the schema or the attributes cannot be read.
 */
export async function loadAttributeIdentifiers(
  scope: TenantScope,
  documentId: string,
  options: { signal: AbortSignal; db?: RpcClient },
): Promise<AttributeIdentifierEntry[] | null> {
  const [{ docAttributesEnabled, loadAttributeSchema }, { readDocumentAttributes }, { getIngestDeps }] = await Promise.all([
    import('./schema'),
    import('./apply'),
    import('../deps'),
  ]);
  if (!docAttributesEnabled()) return null;
  assertTenantScope(scope);
  const schema = await loadAttributeSchema(scope, { signal: options.signal });
  options.signal.throwIfAborted();
  if (!schema.ok) throw new AttributeIdentifierReadError();
  if (!schema.definitions.some((definition) => definition.in_identifier_index)) return null;
  const db = options.db ?? getIngestDeps().db();
  if (!db) throw new AttributeIdentifierReadError();
  const read = await readDocumentAttributes(db, scopeKey(scope), [documentId], options.signal);
  if (!read.ok) throw new AttributeIdentifierReadError();
  const attributes = read.rows.find((row) => row.documentId === documentId)?.attributes ?? null;
  return attributeIdentifierEntries(schema.definitions, attributes as Record<string, unknown> | null);
}

// --- Re-index (D-24, D-25) -------------------------------------------------------------------------------------------------------------

export const ATTRIBUTE_IDENTIFIER_FEED_OFF = 'attribute_identifier_feed_off';
/** Documents per rag_attribute_identifier_documents page (the function allows 1..1000). */
export const REINDEX_PAGE_SIZE = 500;
const LISTING_RPC = 'rag_attribute_identifier_documents';
const LOG = '[RAG Attributes]';

let feedOffWarned = false;

/** Once per process: RAG_IDENTIFIER_INDEX is off, so attribute identifiers are not written. */
export function warnAttributeIdentifierFeedOff(): void {
  if (feedOffWarned) return;
  feedOffWarned = true;
  console.warn('[RAG Config] RAG_IDENTIFIER_INDEX is off: identifiers from flagged attributes are not written to the identifier index', {
    code: ATTRIBUTE_IDENTIFIER_FEED_OFF,
  });
}

export function resetAttributeIdentifierFeedForTests(): void {
  feedOffWarned = false;
}

/** The listing call failed; carries the RPC error code only. */
export class AttributeIdentifierListingError extends Error {
  readonly code: string | null;
  constructor(code: string | null) {
    super(`[RAG Attributes] ${LISTING_RPC} failed`);
    this.name = 'AttributeIdentifierListingError';
    this.code = code;
  }
}

export interface ReindexAttributeIdentifiersDeps {
  db: RpcClient;
  signal: AbortSignal;
  /** RAG_IDENTIFIER_INDEX; defaults to the typed RAG configuration. */
  identifierIndex?: () => boolean | Promise<boolean>;
  pageSize?: number;
  /** Test seam passed to the indexer. */
  loadPatterns?: (scope: TenantScope, options: { signal: AbortSignal }) => Promise<TenantIdentifierPatterns>;
}

export interface ReindexAttributeIdentifiersReport {
  status: 'done' | 'feed_off';
  documents: number;
  failed: number;
  chunksWritten: number;
  documentsChanged: number;
}

async function identifierIndexOn(deps: ReindexAttributeIdentifiersDeps): Promise<boolean> {
  if (deps.identifierIndex) return deps.identifierIndex();
  const [{ loadRagConfig }, { getRagDeps }] = await Promise.all([import('../../config'), import('../../deps')]);
  return loadRagConfig(getRagDeps().ragEnv()).v2.identifierIndex;
}

function pageSizeOf(deps: { pageSize?: number }): number {
  const size = deps.pageSize ?? REINDEX_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new RangeError('page size must be within 1..1000');
  return size;
}

async function listPage(db: RpcClient, tenantKey: string, after: string | null, limit: number, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const response = await db.rpc(LISTING_RPC, { p_tenant_key: tenantKey, p_after: after, p_limit: limit }).abortSignal(signal);
  if (response.error) throw new AttributeIdentifierListingError(response.error.code ?? null);
  const ids: string[] = [];
  for (const row of (Array.isArray(response.data) ? response.data : []) as Array<Record<string, unknown>>) {
    if (typeof row.document_id !== 'string') throw new AttributeIdentifierListingError('bad_response');
    ids.push(row.document_id);
  }
  return ids;
}

async function* tenantDocuments(scope: TenantScope, deps: { db: RpcClient; signal: AbortSignal; pageSize?: number }): AsyncGenerator<string> {
  const limit = pageSizeOf(deps);
  const tenantKey = scopeKey(scope);
  let after: string | null = null;
  for (;;) {
    const page = await listPage(deps.db, tenantKey, after, limit, deps.signal);
    yield* page;
    if (page.length < limit) return;
    after = page[page.length - 1] ?? after;
  }
}

/** How many documents a re-index of 'all' would visit (the 1007 listing); writes nothing. */
export async function countAttributeIdentifierDocuments(scope: TenantScope, deps: { db: RpcClient; signal: AbortSignal; pageSize?: number }): Promise<number> {
  assertTenantScope(scope);
  let count = 0;
  for await (const _id of tenantDocuments(scope, deps)) count += 1;
  return count;
}

/**
 * Re-indexes documents through indexDocumentForLookup (the one writer of the identifier columns): the given ids, or with 'all' every
 * document of the 1007 listing in keyset pages. The schema is read fresh once first so a changed flag applies. With RAG_IDENTIFIER_INDEX
 * off nothing is read or written and the once-per-process warning is logged. Counts only.
 */
export async function reindexAttributeIdentifiers(
  scope: TenantScope,
  documentIds: readonly string[] | 'all',
  deps: ReindexAttributeIdentifiersDeps,
): Promise<ReindexAttributeIdentifiersReport> {
  assertTenantScope(scope);
  const report: ReindexAttributeIdentifiersReport = { status: 'done', documents: 0, failed: 0, chunksWritten: 0, documentsChanged: 0 };
  if (!(await identifierIndexOn(deps))) {
    warnAttributeIdentifierFeedOff();
    return { ...report, status: 'feed_off' };
  }
  if (documentIds !== 'all' && documentIds.length === 0) return report;
  const [{ indexDocumentForLookup }, { createIngestWriter }, { loadAttributeSchema }] = await Promise.all([
    import('../write-indexers'),
    import('../writer'),
    import('./schema'),
  ]);
  const schema = await loadAttributeSchema(scope, { signal: deps.signal, fresh: true });
  deps.signal.throwIfAborted();
  if (!schema.ok) throw new AttributeIdentifierReadError();
  const writer = createIngestWriter({ db: deps.db, scope, signal: deps.signal });
  const ids: AsyncIterable<string> | Iterable<string> = documentIds === 'all' ? tenantDocuments(scope, deps) : [...new Set(documentIds)];
  for await (const documentId of ids) {
    deps.signal.throwIfAborted();
    const result = await indexDocumentForLookup({
      writer,
      scope,
      documentId,
      tables: false,
      identifiers: true,
      signal: deps.signal,
      loadAttributeIdentifiers: (s, id, options) => loadAttributeIdentifiers(s, id, { ...options, db: deps.db }),
      ...(deps.loadPatterns ? { loadPatterns: deps.loadPatterns } : {}),
    });
    if (result.identifiers === null || result.warnings.includes('index_identifiers_failed')) {
      report.failed += 1;
      continue;
    }
    report.documents += 1;
    report.chunksWritten += result.identifiers.chunksWritten;
    if (result.identifiers.documentChanged) report.documentsChanged += 1;
  }
  return report;
}

export interface RunnerLines {
  out(line: string): void;
  err(line: string): void;
}

/** The output lines of a re-index: the count line and the cache effect, or the off line. */
export async function reindexReportLines(report: ReindexAttributeIdentifiersReport, repairCommand: string): Promise<{ out: string[]; err: string[] }> {
  if (report.status === 'feed_off') return { out: [`${LOG} identifier index: RAG_IDENTIFIER_INDEX is off; nothing was written`], err: [] };
  const { CACHE_EFFECT } = await import('../../identifiers/cli');
  const out = [`${LOG} identifier index: ${report.documents} documents re-indexed`, `${LOG} ${CACHE_EFFECT}`];
  const err = report.failed > 0 ? [`${LOG} identifier index: ${report.failed} documents failed; run ${repairCommand} to repair`] : [];
  return { out, err };
}

export const reindexCommand = (tenantKey: string): string => `npm run rag:attributes -- --tenant ${tenantKey} --reindex-identifiers --apply`;

export interface AttributeIdentifierReindexDeps extends Omit<ReindexAttributeIdentifiersDeps, 'db'> {
  rpc?: RpcClient | null;
  io: RunnerLines;
}

/**
 * `rag:attributes --tenant <key> --reindex-identifiers [--dry-run | --apply]`: the report first; without apply exit 2; with apply the
 * tenant's documents that carry attributes are re-indexed. Exit 0 done (also with the identifier index off), 1 failed.
 */
export async function runAttributeIdentifierReindex(input: { scope: TenantScope; apply: boolean }, deps: AttributeIdentifierReindexDeps): Promise<0 | 1 | 2> {
  const db = deps.rpc === undefined ? (await import('../deps')).getIngestDeps().db() : deps.rpc;
  if (!db) {
    deps.io.err(`${LOG} the database is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }
  const count = await countAttributeIdentifierDocuments(input.scope, { db, signal: deps.signal, ...(deps.pageSize ? { pageSize: deps.pageSize } : {}) });
  deps.io.out(`${LOG} documents to re-index: ${count}`);
  if (!input.apply) {
    deps.io.out(`${LOG} report only: nothing was written; run again with --apply to re-index`);
    return 2;
  }
  const report = await reindexAttributeIdentifiers(input.scope, 'all', { ...deps, db });
  const lines = await reindexReportLines(report, reindexCommand(scopeKey(input.scope)));
  for (const line of lines.out) deps.io.out(line);
  for (const line of lines.err) deps.io.err(line);
  return report.failed > 0 ? 1 : 0;
}
