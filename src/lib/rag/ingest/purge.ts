import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { RpcClient } from '../backend/supabase-rpc';
import { redisvlInvalidationTarget } from '../cache/emit';
import type { SemanticCache } from '../cache/types';
import { backfillScope } from '../tenant/backfill-scope';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { removeVersionObjects, versionPrefix } from './artifacts';
import { getIngestDeps } from './deps';
import { assertUploadImageKey, getPublicImageStore, PUBLIC_IMAGE_PREFIX } from './images/public-store';
import { assertListPrefix, getObjectStore } from './object-store';

/**
 * The only application entry to the purge SQL (rag_purge_*, D-11): an irreversible removal of every version of a lineage from every
 * database store in one transaction (0727), then the storage objects after commit and a stored check (D-15, D-16, D-37). Only the fixed
 * SQL words leave this module; logs carry ids and counts, never file names or object paths.
 */

export type PurgeFailure = 'not_found' | 'invalid_argument' | 'tenant_mismatch' | 'unavailable';

export const PURGE_ADMIN_REASON_CODES = ['owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other'] as const;
export type PurgeAdminReasonCode = (typeof PURGE_ADMIN_REASON_CODES)[number];
export type PurgeReasonCode = PurgeAdminReasonCode | 'source_deleted';
export const PURGE_NOTE_MAX = 500;

export type PurgeCheckResult = 'verified' | 'pending' | 'remaining';

export interface PurgeCheck {
  /** Rows or objects the check still finds, per store, in the server's order. */
  left: Record<string, number>;
  /** Stored objects (and cache invalidations) waiting for the next retry. */
  pendingFiles: number;
  /** External index deletions still queued (Phase 7 targets in state pending). */
  queuedExternal: number;
  result: PurgeCheckResult;
  checkedAt: string;
}

export interface PurgeActor {
  kind: 'admin' | 'source_sync';
  id: string;
}

export interface PurgeReason {
  code: PurgeReasonCode;
  note?: string | null;
}

export type PurgeLineageResult =
  | { ok: true; auditId: string; lineageId: string; removed: Record<string, number>; check: PurgeCheck }
  | { ok: false; reason: PurgeFailure };

export interface PurgeDocumentAsAdminInput {
  documentId: string;
  /** The admin the route guard verified; the database checks admin_users and the tenants this user administers again. */
  actorUserId: string;
  reasonCode: PurgeAdminReasonCode;
  reasonNote: string | null;
  signal: AbortSignal;
}

export interface LineageDocumentRow {
  id: string;
  source: string | null;
  sourceFileId: string | null;
}

export interface PurgeDeps {
  db: () => RpcClient | null;
  lineageDocuments: (tenantKey: string, lineageId: string, signal: AbortSignal) => Promise<LineageDocumentRow[] | null>;
  cacheTarget: () => Pick<SemanticCache, 'invalidateTenant'> | null;
  scopeOf: (tenantKey: string, signal: AbortSignal) => Promise<TenantScope | null>;
}

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | { ok: false; reason: PurgeFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQL_REASONS = new Set<PurgeFailure>(['not_found', 'invalid_argument', 'tenant_mismatch']);

let depsOverride: Partial<PurgeDeps> = {};

interface DocumentsReader {
  from(table: 'documents'): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown[] | null; error: { code?: string } | null }>;
        };
      };
    };
  };
}

/** The versions of a lineage as stored before the purge: their ids and, for an uploaded image, the key the upload route stored it under. */
async function readLineageDocuments(tenantKey: string, lineageId: string, signal: AbortSignal): Promise<LineageDocumentRow[] | null> {
  let admin: DocumentsReader | null;
  try {
    admin = getSupabaseAdmin() as unknown as DocumentsReader | null;
  } catch {
    return null;
  }
  if (!admin) return null;
  const { data, error } = await admin.from('documents').select('id, source, source_file_id').eq('tenant_key', tenantKey).eq('lineage_id', lineageId).abortSignal(signal);
  if (error) {
    console.error('[RAG Admin] purge could not read the lineage versions', { lineageId, code: error.code ?? null });
    return null;
  }
  return (data ?? []).flatMap((row) => {
    const value = objectOf(row);
    const id = text(value, 'id');
    return id === null ? [] : [{ id, source: text(value, 'source'), sourceFileId: text(value, 'source_file_id') }];
  });
}

async function defaultScopeOf(tenantKey: string, signal: AbortSignal): Promise<TenantScope | null> {
  const resolved = await backfillScope(tenantKey, { signal });
  return resolved.ok ? resolved.scope : null;
}

function deps(): PurgeDeps {
  return {
    db: depsOverride.db ?? (() => getIngestDeps().db()),
    lineageDocuments: depsOverride.lineageDocuments ?? readLineageDocuments,
    cacheTarget: depsOverride.cacheTarget ?? redisvlInvalidationTarget,
    scopeOf: depsOverride.scopeOf ?? defaultScopeOf,
  };
}

export function setPurgeDepsForTests(next: Partial<PurgeDeps>): void {
  depsOverride = { ...next };
}

export function resetPurgeDepsForTests(): void {
  depsOverride = {};
}

function failureOf(message: string | undefined): PurgeFailure {
  const text = message ?? '';
  if (/^ingest_refused/.test(text)) return 'tenant_mismatch';
  const word = /^[a-z_]+/.exec(text)?.[0] as PurgeFailure | undefined;
  return word !== undefined && SQL_REASONS.has(word) ? word : 'unavailable';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** One RPC on the admin client. A database message never leaves this module; an unexpected failure is logged once with the RPC and code. */
async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db = deps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const reason = failureOf(response.error.message);
      if (reason === 'unavailable') console.error('[RAG Admin] purge call failed', { rpc, code: response.error.code ?? null });
      return { ok: false, reason };
    }
    const data = response.data;
    return { ok: true, rows: (Array.isArray(data) ? data : data === null || data === undefined ? [] : [data]) as Row[] };
  } catch (error) {
    if (isAbort(error)) throw error;
    console.error('[RAG Admin] purge call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function strings(row: Row, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function timeOf(row: Row, key: string): string | null {
  const value = row[key];
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

/** A scalar function answers with the bare value on PostgREST and with a one-column row on the fake edge. */
function scalarOf(rows: Row[], name: string): unknown {
  const first = rows[0] as unknown;
  if (first === undefined) return null;
  if (typeof first !== 'object' || first === null) return first;
  return name in (first as Row) ? (first as Row)[name] : Object.values(first as Row)[0];
}

function objectOf(value: unknown): Row {
  if (typeof value === 'string') {
    try {
      return objectOf(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function countsOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [store, n] of Object.entries(objectOf(value))) {
    const parsed = Number(n);
    if (Number.isFinite(parsed) && parsed >= 0) out[store] = Math.trunc(parsed);
  }
  return out;
}

function validReason(reason: PurgeReason): boolean {
  const note = reason.note ?? null;
  if (note !== null && (typeof note !== 'string' || note.length > PURGE_NOTE_MAX)) return false;
  if (reason.code === 'other' && (note === null || note.trim() === '')) return false;
  return reason.code === 'source_deleted' || (PURGE_ADMIN_REASON_CODES as readonly string[]).includes(reason.code);
}


// ---- Post-commit object removal (D-15, D-37) ----

/** Time the work after the commit may take; it never follows the request's signal, so a closed tab cannot stop it half way. */
const POST_COMMIT_TIMEOUT_MS = 45_000;
const FINISH_TIMEOUT_MS = 15_000;
const RECENT_MS = 7 * 86_400_000;
const UPLOAD_FOLDER = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

/**
 * Something the purge could not remove yet, stored on the audit row as text and retried by the reconcile run. Locations are derived
 * from ids and hashes: the lineage prefixes, a parse-cache prefix (tenant, file hash, parser), the user folder of an uploaded image with
 * the SHA-256 of its key (the key embeds the file name), or the RedisVL cache.
 */
type PendingItem =
  | { kind: 'original_files'; prefix: string }
  | { kind: 'parse_cache_files'; prefix: string }
  | { kind: 'page_images'; prefix: string }
  | { kind: 'uploaded_image'; folder: string; hash: string }
  | { kind: 'semantic_cache' };

function encodePending(item: PendingItem): string {
  switch (item.kind) {
    case 'uploaded_image':
      return `uploaded_image:${item.folder}sha256:${item.hash}`;
    case 'semantic_cache':
      return 'semantic_cache:redisvl';
    default:
      return `${item.kind}:${item.prefix}`;
  }
}

function decodePending(value: string): PendingItem | null {
  const colon = value.indexOf(':');
  if (colon < 0) return null;
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (kind === 'semantic_cache') return rest === 'redisvl' ? { kind } : null;
  if (kind === 'uploaded_image') {
    const match = /^([0-9a-f-]{36}\/)sha256:([0-9a-f]{64})$/.exec(rest);
    return match && UPLOAD_FOLDER.test(match[1] as string) ? { kind, folder: match[1] as string, hash: match[2] as string } : null;
  }
  if (kind === 'original_files' || kind === 'parse_cache_files' || kind === 'page_images') return rest.endsWith('/') ? { kind, prefix: rest } : null;
  return null;
}

interface Upload {
  folder: string;
  hash: string;
  key: string | null;
}

interface LineageTarget {
  auditId: string;
  tenantKey: string;
  lineageId: string;
  versionIds: string[];
  /** Parse-cache prefixes the SQL removed (or that are still pending): only these are listed, never a shared entry of another lineage. */
  parsePrefixes: string[];
  uploads: Upload[];
}

interface StepResult {
  removed: number;
  pending: PendingItem | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function originalsPrefix(tenantKey: string, lineageId: string): string {
  // versionPrefix validates the tenant key and the lineage id; the lineage prefix is the part before the version.
  return versionPrefix(tenantKey, lineageId, 1).slice(0, -2);
}

function imagePrefix(tenantKey: string, lineageId: string): string {
  return `${PUBLIC_IMAGE_PREFIX}${originalsPrefix(tenantKey, lineageId)}`;
}

function isOwnParsePrefix(tenantKey: string, prefix: string): boolean {
  if (!prefix.startsWith(`${tenantKey}/_parse-cache/`) || !prefix.endsWith('/')) return false;
  try {
    assertListPrefix(prefix);
    return true;
  } catch {
    return false;
  }
}

/** Originals and parse files of every version under `<tenant>/<lineage>/`: the keys the SQL returned, then whatever a listing still finds. */
async function removeOriginals(tenantKey: string, lineageId: string, keys: string[], signal: AbortSignal): Promise<StepResult> {
  const prefix = originalsPrefix(tenantKey, lineageId);
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9]{1,10})/`);
  let removed = 0;
  let failed = 0;
  let refused = 0;
  const sweep = async (candidates: string[]): Promise<void> => {
    const byVersion = new Map<number, string[]>();
    for (const key of candidates) {
      const version = Number(pattern.exec(key)?.[1]);
      if (!Number.isInteger(version) || version < 1) {
        refused += 1;
        continue;
      }
      byVersion.set(version, [...(byVersion.get(version) ?? []), key]);
    }
    for (const [version, own] of byVersion) {
      const result = await removeVersionObjects({ tenantKey, lineageId, version, keys: own, signal });
      removed += result.removed;
      failed += result.failed;
    }
  };
  await sweep([...new Set(keys)]);
  try {
    const listed = await getObjectStore().list(prefix, { signal });
    await sweep(listed);
  } catch {
    failed += 1;
  }
  if (refused > 0) console.warn('[RAG Admin] purge skipped object keys outside the lineage prefix', { lineageId, refused });
  return { removed, pending: failed > 0 ? { kind: 'original_files', prefix } : null };
}

/** Parse-cache objects under one prefix the SQL removed; a prefix outside the tenant's `_parse-cache/` folder is refused. */
async function removeParseCache(tenantKey: string, prefix: string, signal: AbortSignal): Promise<StepResult> {
  if (!isOwnParsePrefix(tenantKey, prefix)) {
    console.warn('[RAG Admin] purge skipped a parse-cache prefix outside the tenant');
    return { removed: 0, pending: null };
  }
  let removed = 0;
  let failed = 0;
  try {
    const store = getObjectStore();
    for (const key of await store.list(prefix, { signal })) {
      if (!key.startsWith(prefix)) continue;
      try {
        await store.remove(key, { signal });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    failed += 1;
  }
  return { removed, pending: failed > 0 ? { kind: 'parse_cache_files', prefix } : null };
}

/** Page pictures under `rag/<tenant>/<lineage>/` in the public bucket (the store checks the prefix and every key). */
async function removePictures(tenantKey: string, lineageId: string, prefix: string, signal: AbortSignal): Promise<StepResult> {
  if (prefix !== imagePrefix(tenantKey, lineageId)) {
    console.warn('[RAG Admin] purge skipped an image prefix outside the lineage', { lineageId });
    return { removed: 0, pending: null };
  }
  try {
    const store = getPublicImageStore();
    const keys = await store.list(prefix, { signal });
    if (keys.length > 0) await store.remove(keys, { within: prefix, signal });
    return { removed: keys.length, pending: null };
  } catch {
    return { removed: 0, pending: { kind: 'page_images', prefix } };
  }
}

/** The image the upload route stored for an image_upload source. A retry knows only the folder and the key's hash, and finds it by listing. */
async function removeUploadedImage(upload: Upload, signal: AbortSignal): Promise<StepResult> {
  const pending: PendingItem = { kind: 'uploaded_image', folder: upload.folder, hash: upload.hash };
  try {
    const store = getPublicImageStore();
    let key = upload.key;
    if (key === null) {
      key = (await store.listUploads(upload.folder, { signal })).find((candidate) => sha256(candidate) === upload.hash) ?? null;
      if (key === null) return { removed: 0, pending: null };
    }
    await store.removeUpload(key, { signal });
    return { removed: 1, pending: null };
  } catch {
    return { removed: 0, pending };
  }
}

/** RedisVL entries of the tenant that cite the purged versions (D-11); pgvector entries went in the transaction. */
async function invalidateCache(tenantKey: string, versionIds: string[], scope: TenantScope | null, signal: AbortSignal): Promise<StepResult> {
  let target: Pick<SemanticCache, 'invalidateTenant'> | null;
  try {
    target = deps().cacheTarget();
  } catch {
    target = null;
  }
  if (!target) return { removed: 0, pending: null };
  try {
    const resolved = scope ?? (await deps().scopeOf(tenantKey, signal));
    if (!resolved) return { removed: 0, pending: { kind: 'semantic_cache' } };
    const deleted = await target.invalidateTenant(resolved, versionIds.length > 0 ? versionIds : undefined, { signal });
    return { removed: Number.isInteger(deleted) && deleted > 0 ? deleted : 0, pending: null };
  } catch {
    return { removed: 0, pending: { kind: 'semantic_cache' } };
  }
}

function uploadOf(row: LineageDocumentRow): Upload | null {
  if (row.source !== 'image_upload' || row.sourceFileId === null) return null;
  try {
    const key = assertUploadImageKey(row.sourceFileId);
    const folder = UPLOAD_FOLDER.exec(key)?.[0];
    return folder ? { folder, hash: sha256(key), key } : null;
  } catch {
    return null;
  }
}

async function runPendingItem(target: LineageTarget, item: PendingItem, scope: TenantScope | null, signal: AbortSignal): Promise<StepResult> {
  switch (item.kind) {
    case 'original_files':
      if (item.prefix !== originalsPrefix(target.tenantKey, target.lineageId)) return { removed: 0, pending: item };
      return removeOriginals(target.tenantKey, target.lineageId, [], signal);
    case 'parse_cache_files':
      if (!isOwnParsePrefix(target.tenantKey, item.prefix)) return { removed: 0, pending: item };
      return removeParseCache(target.tenantKey, item.prefix, signal);
    case 'page_images':
      return removePictures(target.tenantKey, target.lineageId, item.prefix, signal);
    case 'uploaded_image':
      return removeUploadedImage({ folder: item.folder, hash: item.hash, key: null }, signal);
    case 'semantic_cache':
      return invalidateCache(target.tenantKey, target.versionIds, scope, signal);
  }
}

// ---- The check (D-16, D-45) ----

async function listedCount(list: () => Promise<string[]>): Promise<number | null> {
  try {
    return (await list()).length;
  } catch {
    return null;
  }
}

function addPending(items: PendingItem[], item: PendingItem): void {
  const encoded = encodePending(item);
  if (!items.some((existing) => encodePending(existing) === encoded)) items.push(item);
}

export interface VerifyPurgeInput {
  auditId: string;
  tenantKey: string;
  lineageId: string;
  /** Pending items as stored on the audit row (or found by this pass). */
  pending: string[];
  /** Parse-cache prefixes to list; pending parse-cache items are listed too. */
  parsePrefixes?: string[];
  /** Object counts of this pass, merged into the audit row. */
  objectCounts?: Record<string, number>;
  signal?: AbortSignal;
}

export type VerifyPurgeResult = { ok: true; check: PurgeCheck } | { ok: false; reason: PurgeFailure };

/**
 * Runs rag_purge_verify, lists the three object locations, and stores the result on the audit row: verified only when every count is
 * 0, no object is pending and no external target is pending or dead; pending while objects or targets are queued; remaining when a row
 * is left or a target is dead. An object the listing still finds becomes a pending item, so the next retry removes it.
 */
export async function verifyPurge(input: VerifyPurgeInput): Promise<VerifyPurgeResult> {
  const signal = input.signal ?? AbortSignal.timeout(POST_COMMIT_TIMEOUT_MS);
  const known: string[] = [];
  const items: PendingItem[] = [];
  for (const value of input.pending) {
    const item = decodePending(value);
    if (item) addPending(items, item);
    else known.push(value);
  }
  const verified = await call('rag_purge_verify', { p_tenant_key: input.tenantKey, p_lineage_id: input.lineageId }, signal);
  if (!verified.ok) return verified;

  const left: Record<string, number> = {};
  const external: Record<string, number> = {};
  let remaining = false;
  let queuedExternal = 0;
  for (const row of verified.rows) {
    const store = text(row, 'store');
    const n = Number(row.remaining);
    if (store === null || !Number.isFinite(n)) return { ok: false, reason: 'unavailable' };
    if (store.startsWith('external:')) {
      const state = text(row, 'state');
      if (state === 'dead') {
        external[store] = 1;
        remaining = true;
      } else {
        external[store] = 0;
        if (n > 0) queuedExternal += 1;
      }
      continue;
    }
    left[store] = n;
    if (n > 0) remaining = true;
  }

  const originals = originalsPrefix(input.tenantKey, input.lineageId);
  const originalsLeft = await listedCount(() => getObjectStore().list(originals, { signal }));
  left.original_files = originalsLeft ?? 0;
  if (originalsLeft !== 0) addPending(items, { kind: 'original_files', prefix: originals });

  const parsePrefixes = new Set((input.parsePrefixes ?? []).filter((prefix) => isOwnParsePrefix(input.tenantKey, prefix)));
  for (const item of items) if (item.kind === 'parse_cache_files') parsePrefixes.add(item.prefix);
  let parseLeft = 0;
  for (const prefix of parsePrefixes) {
    const n = await listedCount(() => getObjectStore().list(prefix, { signal }));
    parseLeft += n ?? 0;
    if (n !== 0) addPending(items, { kind: 'parse_cache_files', prefix });
  }
  left.parse_cache_files = parseLeft;

  const pictures = imagePrefix(input.tenantKey, input.lineageId);
  const picturesLeft = await listedCount(() => getPublicImageStore().list(pictures, { signal }));
  left.page_images = picturesLeft ?? 0;
  if (picturesLeft !== 0) addPending(items, { kind: 'page_images', prefix: pictures });

  let uploadsLeft = 0;
  for (const item of items) {
    if (item.kind !== 'uploaded_image') continue;
    try {
      const keys = await getPublicImageStore().listUploads(item.folder, { signal });
      if (keys.some((key) => sha256(key) === item.hash)) uploadsLeft += 1;
    } catch {
      uploadsLeft += 1;
    }
  }
  left.uploaded_image = uploadsLeft;
  Object.assign(left, external);

  const pending = [...items.map(encodePending), ...known];
  const pendingFiles = pending.length;
  const result: PurgeCheckResult = remaining ? 'remaining' : pendingFiles > 0 || queuedExternal > 0 ? 'pending' : 'verified';
  const checkedAt = new Date().toISOString();
  const check: PurgeCheck = { left, pendingFiles, queuedExternal, result, checkedAt };
  const finished = await call(
    'rag_purge_audit_finish',
    {
      p_audit_id: input.auditId,
      p_object_counts: input.objectCounts ?? {},
      p_pending: pending,
      p_verification: { result, left, pending_files: pendingFiles, queued_external: queuedExternal, checked_at: checkedAt },
      p_result: result === 'remaining' ? 'failed' : result,
    },
    AbortSignal.timeout(FINISH_TIMEOUT_MS),
  );
  if (!finished.ok) return finished;
  return { ok: true, check };
}

/** A purge that committed but whose check could not be stored: reported as pending; the reconcile run checks it again. */
function unchecked(pendingFiles: number): PurgeCheck {
  return { left: {}, pendingFiles, queuedExternal: 0, result: 'pending', checkedAt: new Date().toISOString() };
}

async function purgeTenantLineage(
  tenantKey: string,
  lineageId: string,
  actor: PurgeActor,
  reason: PurgeReason,
  scope: TenantScope | null,
  signal: AbortSignal,
): Promise<PurgeLineageResult> {
  // Read before the purge: once it commits, the rows that name the uploaded image are gone. Nothing is purged when this read fails.
  let documents: LineageDocumentRow[] | null;
  try {
    documents = await deps().lineageDocuments(tenantKey, lineageId, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    documents = null;
  }
  if (documents === null) return { ok: false, reason: 'unavailable' };

  const purged = await call(
    'rag_purge_lineage',
    {
      p_tenant_key: tenantKey,
      p_lineage_id: lineageId,
      p_actor: { kind: actor.kind, id: actor.id.toLowerCase() },
      p_reason: reason.note === null || reason.note === undefined ? { code: reason.code } : { code: reason.code, note: reason.note },
    },
    signal,
  );
  if (!purged.ok) return purged;
  const row = purged.rows[0];
  const auditId = row ? text(row, 'audit_id') : null;
  if (!row || auditId === null) return { ok: false, reason: 'unavailable' };
  const removed = countsOf(row.counts);

  const after = AbortSignal.timeout(POST_COMMIT_TIMEOUT_MS);
  const target: LineageTarget = {
    auditId,
    tenantKey,
    lineageId,
    versionIds: documents.map((document) => document.id),
    parsePrefixes: strings(row, 'parse_cache_prefixes'),
    uploads: documents.map(uploadOf).filter((upload): upload is Upload => upload !== null),
  };
  const pending: PendingItem[] = [];
  const objectCounts: Record<string, number> = { original_files: 0, parse_cache_files: 0, page_images: 0 };
  const record = (store: string, step: StepResult): void => {
    if (store in objectCounts || step.removed > 0) objectCounts[store] = (objectCounts[store] ?? 0) + step.removed;
    if (step.pending) addPending(pending, step.pending);
  };
  record('original_files', await removeOriginals(tenantKey, lineageId, strings(row, 'object_keys'), after));
  for (const prefix of target.parsePrefixes) record('parse_cache_files', await removeParseCache(tenantKey, prefix, after));
  for (const prefix of strings(row, 'image_prefixes')) record('page_images', await removePictures(tenantKey, lineageId, prefix, after));
  for (const upload of target.uploads) record('uploaded_image', await removeUploadedImage(upload, after));
  const cache = await invalidateCache(tenantKey, target.versionIds, scope, after);
  if (cache.pending) addPending(pending, cache.pending);

  const checked = await verifyPurge({
    auditId,
    tenantKey,
    lineageId,
    pending: pending.map(encodePending),
    parsePrefixes: target.parsePrefixes,
    objectCounts,
    signal: after,
  });
  if (!checked.ok) {
    console.error('[RAG Admin] purge committed but its check was not stored', { auditId, lineageId });
    return { ok: true, auditId, lineageId, removed: { ...removed, ...objectCounts }, check: unchecked(pending.length) };
  }
  return { ok: true, auditId, lineageId, removed: { ...removed, ...objectCounts }, check: checked.check };
}

/** Scope-based entry for source sync (plan 06.3-21): the tenant comes from the minted scope, never from the caller. */
export async function purgeLineage(
  scope: TenantScope,
  lineageId: string,
  actor: PurgeActor,
  reason: PurgeReason,
  options: { signal: AbortSignal },
): Promise<PurgeLineageResult> {
  assertTenantScope(scope);
  if (!UUID.test(lineageId) || !UUID.test(actor.id) || (actor.kind !== 'admin' && actor.kind !== 'source_sync') || !validReason(reason)) {
    return { ok: false, reason: 'invalid_argument' };
  }
  return purgeTenantLineage(scopeKey(scope).toLowerCase(), lineageId.toLowerCase(), actor, reason, scope, options.signal);
}

/**
 * Purges the whole lineage of one document for an admin of its tenant (D-34). The tenant and lineage come from SQL; an unknown id,
 * another tenant's id and a non-admin all answer not_found.
 */
export async function purgeDocumentAsAdmin(input: PurgeDocumentAsAdminInput): Promise<PurgeLineageResult> {
  if (!UUID.test(input.documentId) || !UUID.test(input.actorUserId)) return { ok: false, reason: 'invalid_argument' };
  const reason: PurgeReason = { code: input.reasonCode, note: input.reasonNote };
  if (!(PURGE_ADMIN_REASON_CODES as readonly string[]).includes(input.reasonCode) || !validReason(reason)) return { ok: false, reason: 'invalid_argument' };
  const actor = input.actorUserId.toLowerCase();
  const target = await call('rag_purge_admin_target', { p_document_id: input.documentId.toLowerCase(), p_actor: actor }, input.signal);
  if (!target.ok) return target;
  const row = target.rows[0];
  const tenantKey = row ? text(row, 'tenant_key') : null;
  const lineageId = row ? text(row, 'lineage_id') : null;
  if (tenantKey === null || lineageId === null) return { ok: false, reason: 'unavailable' };
  return purgeTenantLineage(tenantKey, lineageId, { kind: 'admin', id: actor }, reason, null, input.signal);
}

// ---- Reconcile helpers (plan 06.3-21 calls them on its schedule) ----

interface PendingRecord {
  id: string;
  tenantKey: string;
  lineageId: string;
  versionIds: string[];
  pending: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

async function pendingRecords(limit: number, signal: AbortSignal): Promise<{ ok: true; records: PendingRecord[] } | { ok: false; reason: PurgeFailure }> {
  const listed = await call('rag_purge_audit_pending', { p_limit: limit }, signal);
  if (!listed.ok) return listed;
  const records: PendingRecord[] = [];
  for (const row of listed.rows) {
    const id = text(row, 'id');
    const tenantKey = text(row, 'tenant_key');
    const lineageId = text(row, 'lineage_id');
    if (id === null || tenantKey === null || lineageId === null || !UUID.test(lineageId)) continue;
    records.push({
      id,
      tenantKey,
      lineageId,
      versionIds: strings(row, 'version_ids'),
      pending: strings(row, 'pending_object_paths'),
      startedAt: timeOf(row, 'started_at'),
      finishedAt: timeOf(row, 'finished_at'),
    });
  }
  return { ok: true, records };
}

export type RetryPendingResult = { ok: true; records: number; cleared: number; stillPending: number } | { ok: false; reason: PurgeFailure };

/** Retries the pending objects and cache invalidations of purge records, then stores a new check for each record it touched. */
export async function retryPendingPurgeObjects(input: { limit?: number; signal: AbortSignal }): Promise<RetryPendingResult> {
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit as number, 1), 1000) : 50;
  const listed = await pendingRecords(limit, input.signal);
  if (!listed.ok) return listed;
  let records = 0;
  let cleared = 0;
  let stillPending = 0;
  for (const record of listed.records) {
    if (record.pending.length === 0) continue;
    input.signal.throwIfAborted();
    records += 1;
    const target: LineageTarget = {
      auditId: record.id,
      tenantKey: record.tenantKey,
      lineageId: record.lineageId,
      versionIds: record.versionIds,
      parsePrefixes: [],
      uploads: [],
    };
    const left: string[] = [];
    for (const value of record.pending) {
      const item = decodePending(value);
      if (!item) {
        left.push(value);
        continue;
      }
      let step: StepResult;
      try {
        step = await runPendingItem(target, item, null, input.signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        step = { removed: 0, pending: item };
      }
      if (step.pending) left.push(encodePending(step.pending));
      else cleared += 1;
    }
    const checked = await verifyPurge({ auditId: record.id, tenantKey: record.tenantKey, lineageId: record.lineageId, pending: left, signal: input.signal });
    stillPending += checked.ok ? checked.check.pendingFiles : left.length;
  }
  if (records > 0) console.log('[RAG Admin] purge pending objects retried', { records, cleared, stillPending });
  return { ok: true, records, cleared, stillPending };
}

export type RescrubResult = { ok: true; records: number; scrubbed: number } | { ok: false; reason: PurgeFailure };

/** Runs the chat scrub again for purges of the last 7 days, so a stale browser tab that wrote a quote back loses it again (C-10). */
export async function rescrubRecentPurges(input: { signal: AbortSignal }): Promise<RescrubResult> {
  const listed = await pendingRecords(1000, input.signal);
  if (!listed.ok) return listed;
  const since = Date.now() - RECENT_MS;
  let records = 0;
  let scrubbed = 0;
  for (const record of listed.records) {
    if (record.finishedAt === null || Date.parse(record.finishedAt) < since || record.versionIds.length === 0) continue;
    const scrub = await call(
      'rag_purge_scrub_chats',
      {
        p_tenant_key: record.tenantKey,
        p_lineage_id: record.lineageId,
        p_document_ids: record.versionIds,
        p_withdrawn_at: record.startedAt ?? record.finishedAt,
      },
      input.signal,
    );
    if (!scrub.ok) return scrub;
    records += 1;
    const n = Number(scalarOf(scrub.rows, 'rag_purge_scrub_chats'));
    if (Number.isFinite(n) && n > 0) scrubbed += n;
  }
  return { ok: true, records, scrubbed };
}

/** True when an admin purged this connector file in the scope's tenant (D-35): the sync must not bring it back. */
export async function isPurgeTombstoned(
  scope: TenantScope,
  sourceConnectionId: string,
  sourceKey: string,
  options: { signal: AbortSignal },
): Promise<{ ok: true; tombstoned: boolean } | { ok: false; reason: PurgeFailure }> {
  assertTenantScope(scope);
  if (sourceConnectionId.trim() === '' || sourceKey === '') return { ok: false, reason: 'invalid_argument' };
  const answer = await call(
    'rag_purge_tombstone_exists',
    { p_tenant_key: scopeKey(scope).toLowerCase(), p_source_connection_id: sourceConnectionId, p_source_key: sourceKey },
    options.signal,
  );
  if (!answer.ok) return answer;
  const value = scalarOf(answer.rows, 'rag_purge_tombstone_exists');
  return typeof value === 'boolean' ? { ok: true, tombstoned: value } : { ok: false, reason: 'unavailable' };
}
