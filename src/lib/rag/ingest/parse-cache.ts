import { z } from 'zod/v3';
import { ParseResultSchema, type IngestionJob, type ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../backend/supabase-rpc';
import { isArtifactName, safeContentType } from './artifacts';
import { getIngestDeps } from './deps';
import { getObjectStore } from './object-store';
import type { ParseArtifact } from './parsers/shared';

type Row = Record<string, unknown>;

/** The name of the serialized ParseResult next to the stored artifacts of a cache entry. */
export const PARSE_RESULT_OBJECT = 'result.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A failed cache call. Carries the function and a stable code only: database messages can echo keys and tenant data. */
export class ParseCacheError extends Error {
  readonly code: string;

  constructor(code: string, rpc: string | null = null) {
    super(`[Parse Cache]${rpc ? ` ${rpc}` : ''} failed (${code})`);
    this.name = 'ParseCacheError';
    this.code = code;
  }
}

export interface ParseCacheRow {
  id: string;
  tenantKey: string;
  fileSha256: string;
  parser: string;
  parserVersion: string;
  optionsHash: string;
  objectPrefix: string;
  result: Record<string, unknown>;
  byteSize: number | null;
}

const MetaSchema = z.object({
  artifacts: z.array(z.object({ name: z.string(), content_type: z.string() })).default([]),
});

function db(): RpcClient {
  const client = getIngestDeps().db();
  if (!client) throw new ParseCacheError('no_db');
  return client;
}

async function callRpc(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]> {
  signal.throwIfAborted();
  const response = await db().rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    const word = response.error.code === '22023' ? /^parse_cache_refused: ([a-z_]+)/.exec(response.error.message ?? '')?.[1] : null;
    throw new ParseCacheError(word ?? response.error.code ?? 'rpc_failed', rpc);
  }
  // A function that returns a scalar answers with the bare value on PostgREST and with a one-column row on the fake edge.
  const data: unknown = response.data;
  return Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
}

async function callRows(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Row[]> {
  return (await callRpc(rpc, args, signal)).filter((row): row is Row => typeof row === 'object' && row !== null);
}

function rowOf(row: Row): ParseCacheRow {
  const text = (key: string): string => {
    const value = row[key];
    if (typeof value !== 'string' || value === '') throw new ParseCacheError('bad_row');
    return value;
  };
  const size = row.byte_size;
  const result = row.result;
  return {
    id: text('id'),
    tenantKey: text('tenant_key'),
    fileSha256: text('file_sha256'),
    parser: text('parser'),
    parserVersion: text('parser_version'),
    optionsHash: text('options_hash'),
    objectPrefix: text('object_prefix'),
    result: typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : {},
    byteSize: typeof size === 'number' ? size : typeof size === 'string' && /^\d+$/.test(size) ? Number(size) : null,
  };
}

/** The entry of this job's tenant and file for one parser, version and options hash, or null. The tenant comes from the job row inside SQL. */
export async function lookupParseCache(
  jobId: string,
  parser: string,
  parserVersion: string,
  optionsHash: string,
  signal: AbortSignal,
): Promise<ParseCacheRow | null> {
  const rows = await callRows(
    'rag_parse_cache_lookup',
    { p_job_id: jobId, p_parser: parser, p_parser_version: parserVersion, p_options_hash: optionsHash },
    signal,
  );
  const first = rows[0];
  return first && first.id ? rowOf(first) : null;
}

/**
 * Stores a parse result under the SQL-derived prefix of its tenant, file, parser, version and options hash, then records the row.
 * The objects are written first, so a row never points at a missing object; a second writer of the same key gets the existing row.
 */
export async function putParseResult(
  jobId: string,
  parser: string,
  parserVersion: string,
  optionsHash: string,
  result: ParseResult,
  artifacts: ParseArtifact[],
  signal: AbortSignal,
): Promise<ParseCacheRow> {
  const prefixRows = await callRpc(
    'rag_parse_cache_prefix',
    { p_job_id: jobId, p_parser: parser, p_parser_version: parserVersion, p_options_hash: optionsHash },
    signal,
  );
  const prefixRow = prefixRows[0];
  const prefix = typeof prefixRow === 'string' ? prefixRow : (Object.values((prefixRow ?? {}) as Row)[0] as unknown);
  if (typeof prefix !== 'string' || !prefix.endsWith('/')) throw new ParseCacheError('no_prefix', 'rag_parse_cache_prefix');

  const store = getObjectStore();
  const body = new TextEncoder().encode(JSON.stringify(result));
  await store.put(`${prefix}${PARSE_RESULT_OBJECT}`, body, { contentType: 'application/json', signal });
  let total = body.byteLength;
  const kept: Array<{ name: string; content_type: string }> = [];
  for (const artifact of artifacts) {
    if (!isArtifactName(artifact.name) || artifact.name === PARSE_RESULT_OBJECT) continue;
    const contentType = safeContentType(artifact.contentType);
    await store.put(`${prefix}${artifact.name}`, artifact.bytes, { contentType, signal });
    total += artifact.bytes.byteLength;
    kept.push({ name: artifact.name, content_type: contentType });
  }

  const rows = await callRows(
    'rag_parse_cache_put',
    {
      p_job_id: jobId,
      p_parser: parser,
      p_parser_version: parserVersion,
      p_options_hash: optionsHash,
      p_object_prefix: prefix,
      p_result: { parser: result.parser, parser_version: result.parser_version, page_count: result.page_count, artifacts: kept },
      p_byte_size: total,
    },
    signal,
  );
  const row = rows[0];
  if (!row) throw new ParseCacheError('no_row', 'rag_parse_cache_put');
  return rowOf(row);
}

export interface ParseCacheContent {
  result: ParseResult;
  artifacts: ParseArtifact[];
  entry: ParseCacheRow;
}

/**
 * The cached parse of a job, by cache id. The id is checked inside SQL against the job's own tenant (rag_set_document_parse_cache
 * also links the cache to the version for the re-chunk path), then the entry is read back through the tenant-checked document
 * lookup, so an id from another tenant is refused before any object is read. A merged Docling entry is not stored by this plan.
 */
export async function readParseResultForJob(job: IngestionJob, cacheId: string, signal: AbortSignal): Promise<ParseCacheContent> {
  if (!UUID.test(cacheId)) throw new ParseCacheError('cache_not_found');
  if (!job.document_id) throw new ParseCacheError('document_not_linked');
  await callRpc('rag_set_document_parse_cache', { p_job_id: job.id, p_cache_id: cacheId }, signal);
  const rows = await callRows('rag_parse_cache_for_document', { p_tenant_key: job.tenant_key, p_document_id: job.document_id }, signal);
  const first = rows[0];
  if (!first || !first.id) throw new ParseCacheError('cache_not_found');
  const entry = rowOf(first);
  if (entry.id !== cacheId || entry.tenantKey !== job.tenant_key || !entry.objectPrefix.startsWith(`${job.tenant_key}/_parse-cache/`)) {
    throw new ParseCacheError('cache_tenant_mismatch');
  }
  if (entry.parser === 'merged') throw new ParseCacheError('merged_entry_unsupported');

  const store = getObjectStore();
  const stored = await store.get(`${entry.objectPrefix}${PARSE_RESULT_OBJECT}`, { signal });
  if (!stored) throw new ParseCacheError('result_missing');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8').decode(stored.bytes));
  } catch {
    throw new ParseCacheError('result_invalid');
  }
  const parsed = ParseResultSchema.safeParse(json);
  if (!parsed.success) throw new ParseCacheError('result_invalid');

  const meta = MetaSchema.safeParse(entry.result);
  const artifacts: ParseArtifact[] = [];
  for (const listed of meta.success ? meta.data.artifacts : []) {
    if (!isArtifactName(listed.name)) continue;
    const object = await store.get(`${entry.objectPrefix}${listed.name}`, { signal });
    if (!object) throw new ParseCacheError('artifact_missing');
    artifacts.push({ name: listed.name, bytes: object.bytes, contentType: listed.content_type });
  }
  return { result: parsed.data, artifacts, entry };
}
