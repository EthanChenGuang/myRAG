import type { SupabaseClient } from '@supabase/supabase-js';
import type { TerminologyEntry, TerminologyValidationIssue } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { getLanguageSettings } from '../lang/settings';
import { normalizeLexical } from '../lexical/tokenize';
import { terminologyParams } from './expand';
import { invalidateTerminologyCache } from './load';
import { termKey } from './matcher';
import { validateEntries } from './validate';

/** D-03: the fixed reasons a dictionary admin call can fail with; no database message ever leaves this module. */
export type TerminologyAdminFailure =
  | 'not_admin'
  | 'not_found'
  | 'version_conflict'
  | 'workspace_layer_unavailable'
  | 'limit'
  | 'invalid'
  | 'not_pending'
  | 'unavailable';

export interface TerminologyAdminFailed {
  ok: false;
  reason: TerminologyAdminFailure;
  /** version_conflict: the layer version the write was refused against. */
  currentVersion?: number;
  /** invalid: the validator issues (D-24), errors and warnings. */
  issues?: TerminologyValidationIssue[];
}

export type TerminologyKind = TerminologyEntry['kind'];
export type TerminologyMode = TerminologyEntry['mode'];

/** One stored entry as the admin API returns it (normalized_variants stay server side). */
export interface TerminologyAdminEntry {
  id: string;
  layer_key: string;
  canonical: string;
  variants: string[];
  language: string;
  kind: TerminologyKind;
  mode: TerminologyMode;
  source_language: string | null;
  target_language: string | null;
  enabled: boolean;
  note: string | null;
  suppresses_entry_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The fields an admin sets; the layer, the actor and the normalized variants never come from the request. */
export interface TerminologyEntryInput {
  canonical: string;
  variants: string[];
  language: string;
  kind: TerminologyKind;
  mode?: TerminologyMode;
  enabled?: boolean;
  note?: string | null;
  source_language?: string | null;
  target_language?: string | null;
}

export interface TerminologyAuditItem {
  id: string;
  layer_key: string;
  entry_id: string | null;
  action: string;
  actor: string | null;
  before: unknown;
  after: unknown;
  layer_version: number;
  created_at: string | null;
}

export interface TerminologyLayerVersion {
  layer_key: string;
  version: number;
  entries_sha256: string | null;
}

interface LayerInput {
  /** The id of the admin the route guard verified; the SQL checks admin_users and the layer again. */
  actorUserId: string;
  /** 'shared', or the tenant key of the workspace scope the route resolved. */
  layerKey: string;
  signal: AbortSignal;
}

export type ListTerminologyEntriesResult =
  | {
      ok: true;
      items: TerminologyAdminEntry[];
      total: number;
      limit: number;
      offset: number;
      layerVersion: number;
      entriesSha256: string | null;
      enabledLanguages: string[];
    }
  | TerminologyAdminFailed;

export type WriteTerminologyEntryResult =
  | {
      ok: true;
      entryId: string;
      layerVersion: number;
      entriesSha256: string | null;
      action: 'create' | 'update';
      warnings: TerminologyValidationIssue[];
    }
  | TerminologyAdminFailed;

export type DeleteTerminologyEntryResult = { ok: true; layerVersion: number; entriesSha256: string | null } | TerminologyAdminFailed;

export type SetTerminologySuppressionResult =
  | { ok: true; layerVersion: number; entriesSha256: string | null; suppressed: boolean }
  | TerminologyAdminFailed;

export type TerminologyVersionsResult =
  | { ok: true; shared: TerminologyLayerVersion; workspace: TerminologyLayerVersion | null }
  | TerminologyAdminFailed;

export type ListTerminologyAuditResult =
  | { ok: true; items: TerminologyAuditItem[]; total: number; limit: number; offset: number }
  | TerminologyAdminFailed;

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | TerminologyAdminFailed;

export const SHARED = 'shared';
const PAGE = 100;
const DEFAULT_LIMIT = 50;
const PARALLEL_PAGES = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQL_REASONS = new Map<string, TerminologyAdminFailure>([
  ['not_admin', 'not_admin'],
  ['not_admin_of_layer', 'not_admin'],
  ['not_found', 'not_found'],
  ['version_conflict', 'version_conflict'],
  ['workspace_layer_unavailable', 'workspace_layer_unavailable'],
  ['limit', 'limit'],
  ['invalid_entry', 'invalid'],
  ['not_pending', 'not_pending'],
]);

export const UNAVAILABLE: TerminologyAdminFailed = { ok: false, reason: 'unavailable' };

/** D-35: the enabled registry codes, read only through the Phase 3.2 settings module; empty while the languages are not chosen. */
export function terminologyEnabledLanguages(): string[] {
  const settings = getLanguageSettings();
  return settings.configured ? [...settings.languages] : [];
}

function client(): SupabaseClient | null {
  return getRagDeps().adminClient();
}

function currentVersionOf(details: unknown): number | undefined {
  if (typeof details !== 'string') return undefined;
  try {
    const value = (JSON.parse(details) as { current_version?: unknown }).current_version;
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function failureOf(error: { message?: unknown; details?: unknown }): TerminologyAdminFailed {
  const word = typeof error.message === 'string' ? error.message.trim() : '';
  const reason = SQL_REASONS.get(word);
  if (reason === undefined) return UNAVAILABLE;
  if (reason !== 'version_conflict') return { ok: false, reason };
  const currentVersion = currentVersionOf(error.details);
  return currentVersion === undefined ? { ok: false, reason } : { ok: false, reason, currentVersion };
}

/** One RPC on the service-role client. Logs carry the function name and the error code only, never dictionary text. */
export async function callTerminologyRpc(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db = client() as unknown as RpcClient | null;
  if (!db) return UNAVAILABLE;
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const failure = failureOf(response.error);
      if (failure.reason === 'unavailable') console.error('[RAG Admin] terminology call failed', { rpc, code: response.error.code ?? null });
      return failure;
    }
    const data = response.data;
    const rows = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
    return { ok: true, rows: rows.filter((row): row is Row => !!row && typeof row === 'object') };
  } catch (error) {
    console.error('[RAG Admin] terminology call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return UNAVAILABLE;
  }
}

export function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

export function count(row: Row | undefined, key: string): number {
  const value = row?.[key];
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function strings(row: Row, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function timeOf(row: Row, key: string): string | null {
  const value = row[key];
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function entryOf(row: Row): TerminologyAdminEntry | null {
  const id = text(row, 'id');
  const layerKey = text(row, 'layer_key');
  const canonical = text(row, 'canonical');
  const language = text(row, 'language');
  const kind = text(row, 'kind');
  if (!id || !layerKey || canonical === null || !language || !kind) return null;
  return {
    id,
    layer_key: layerKey,
    canonical,
    variants: strings(row, 'variants'),
    language,
    kind: kind as TerminologyKind,
    mode: row.mode === 'equivalent' ? 'equivalent' : 'one_way',
    source_language: text(row, 'source_language'),
    target_language: text(row, 'target_language'),
    enabled: row.enabled !== false,
    note: text(row, 'note'),
    suppresses_entry_id: text(row, 'suppresses_entry_id'),
    created_by: text(row, 'created_by'),
    updated_by: text(row, 'updated_by'),
    created_at: timeOf(row, 'created_at'),
    updated_at: timeOf(row, 'updated_at'),
  };
}

function entriesOf(rows: Row[]): TerminologyAdminEntry[] {
  return rows.map(entryOf).filter((entry): entry is TerminologyAdminEntry => entry !== null);
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), PAGE);
}

function clampOffset(offset: number | undefined): number {
  return Math.max(Math.trunc(offset ?? 0), 0);
}

const listArgs = (actor: string, layerKey: string, limit: number, offset: number, search: string | null) => ({
  p_actor: actor,
  p_layer_key: layerKey,
  p_limit: limit,
  p_offset: offset,
  p_search: search,
});

/** The version row of a layer (version 0 and no hash before the first write). Call only after the SQL checked the actor for the layer. */
async function layerState(layerKey: string, signal: AbortSignal): Promise<{ ok: true; state: TerminologyLayerVersion } | TerminologyAdminFailed> {
  const db = client();
  if (!db) return UNAVAILABLE;
  try {
    const { data, error } = await db
      .from('rag_term_layers')
      .select('layer_key,version,entries_sha256')
      .eq('layer_key', layerKey)
      .limit(1)
      .abortSignal(signal);
    if (error) {
      console.error('[RAG Admin] terminology call failed', { table: 'rag_term_layers', code: error.code ?? null });
      return UNAVAILABLE;
    }
    const row = (Array.isArray(data) ? data[0] : undefined) as Row | undefined;
    return { ok: true, state: { layer_key: layerKey, version: count(row, 'version'), entries_sha256: row ? text(row, 'entries_sha256') : null } };
  } catch (error) {
    console.error('[RAG Admin] terminology call failed', { table: 'rag_term_layers', error: error instanceof Error ? error.name : 'unknown' });
    return UNAVAILABLE;
  }
}

export interface LoadedLayer {
  version: number;
  entries: TerminologyAdminEntry[];
}

/**
 * Every entry of one layer, page by page through rag_term_list_entries (which checks the actor), for the validator. All pages must carry
 * the version the layer row holds; a write in between answers version_conflict so the caller retries on a consistent snapshot.
 */
export async function loadLayer(actor: string, layerKey: string, signal: AbortSignal): Promise<{ ok: true; layer: LoadedLayer } | TerminologyAdminFailed> {
  const first = await callTerminologyRpc('rag_term_list_entries', listArgs(actor, layerKey, PAGE, 0, null), signal);
  if (!first.ok) return first;
  const state = await layerState(layerKey, signal);
  if (!state.ok) return state;
  const version = state.state.version;
  const total = count(first.rows[0], 'total_count');
  const pages: Row[][] = [first.rows];
  const offsets: number[] = [];
  for (let offset = PAGE; offset < total; offset += PAGE) offsets.push(offset);
  for (let index = 0; index < offsets.length; index += PARALLEL_PAGES) {
    const batch = await Promise.all(
      offsets.slice(index, index + PARALLEL_PAGES).map((offset) => callTerminologyRpc('rag_term_list_entries', listArgs(actor, layerKey, PAGE, offset, null), signal)),
    );
    for (const page of batch) {
      if (!page.ok) return page;
      pages.push(page.rows);
    }
  }
  const rows = pages.flat();
  const seen = rows.map((row) => count(row, 'layer_version'));
  if (rows.length !== total || seen.some((value) => value !== version)) {
    return { ok: false, reason: 'version_conflict', currentVersion: Math.max(version, ...seen) };
  }
  return { ok: true, layer: { version, entries: entriesOf(rows) } };
}

export function layerOf(layerKey: string): TerminologyEntry['layer'] {
  return layerKey === SHARED ? 'shared' : 'workspace';
}

function candidateOf(input: TerminologyEntryInput, layer: TerminologyEntry['layer'], id: string | null): TerminologyEntry {
  return {
    id,
    layer,
    canonical: input.canonical,
    variants: [...input.variants],
    language: input.language as TerminologyEntry['language'],
    kind: input.kind,
    mode: input.mode ?? 'one_way',
    enabled: input.enabled ?? true,
    note: input.note ?? null,
    source_language: (input.source_language ?? null) as TerminologyEntry['source_language'],
    target_language: (input.target_language ?? null) as TerminologyEntry['target_language'],
    suppresses_entry_id: null,
  };
}

export function storedCandidate(entry: TerminologyAdminEntry): TerminologyEntry {
  return {
    ...candidateOf(inputOf(entry), layerOf(entry.layer_key), entry.id),
    suppresses_entry_id: entry.suppresses_entry_id,
  };
}

function inputOf(entry: TerminologyAdminEntry): TerminologyEntryInput {
  return {
    canonical: entry.canonical,
    variants: entry.variants,
    language: entry.language,
    kind: entry.kind,
    mode: entry.mode,
    enabled: entry.enabled,
    note: entry.note,
    source_language: entry.source_language,
    target_language: entry.target_language,
  };
}

/** D-24 rule 4: the validator warns about a variant equal to the canonical or listed twice; the writer drops it. */
export function withoutDuplicates(candidate: TerminologyEntry): TerminologyEntry {
  const identifier = candidate.kind === 'identifier';
  const canonicalKey = termKey(candidate.canonical, identifier);
  const seen = new Set<string>();
  const variants = (candidate.variants ?? []).filter((variant) => {
    const key = termKey(variant, identifier);
    if (key === '') return true;
    if (key === canonicalKey || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...candidate, variants };
}

export const errorsOf = (issues: TerminologyValidationIssue[]) => issues.filter((issue) => issue.severity === 'error');

function definedOnly(patch: Partial<TerminologyEntryInput>): Partial<TerminologyEntryInput> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<TerminologyEntryInput>;
}

export function invalidateLayer(layerKey: string): void {
  // D-22: a shared write reaches every tenant's effective dictionary, a workspace write only its own.
  invalidateTerminologyCache(layerKey === SHARED ? 'all' : layerKey);
}

async function writeEntry(
  input: LayerInput & { expectedVersion: number },
  entryId: string | null,
  build: (existing: TerminologyAdminEntry | null) => TerminologyEntryInput,
): Promise<WriteTerminologyEntryResult> {
  const layer = layerOf(input.layerKey);
  const current = await loadLayer(input.actorUserId, input.layerKey, input.signal);
  if (!current.ok) return current;
  if (current.layer.version !== input.expectedVersion) return { ok: false, reason: 'version_conflict', currentVersion: current.layer.version };

  let existing: TerminologyAdminEntry | null = null;
  if (entryId !== null) {
    const id = entryId.toLowerCase();
    existing = current.layer.entries.find((entry) => entry.id.toLowerCase() === id && entry.suppresses_entry_id === null) ?? null;
    if (!existing) return { ok: false, reason: 'not_found' };
  }

  let shared: TerminologyEntry[] | undefined;
  if (layer === 'workspace') {
    // The shared layer is context only: a shared write between its pages is read again once, never reported as this layer's conflict.
    let loaded = await loadLayer(input.actorUserId, SHARED, input.signal);
    if (!loaded.ok && loaded.reason === 'version_conflict') loaded = await loadLayer(input.actorUserId, SHARED, input.signal);
    if (!loaded.ok) return loaded.reason === 'version_conflict' ? UNAVAILABLE : loaded;
    shared = loaded.layer.entries.map(storedCandidate);
  }

  const context = {
    layer,
    current: current.layer.entries.map(storedCandidate),
    shared,
    enabledLanguages: terminologyEnabledLanguages(),
    minHanChars: terminologyParams().min_han_chars,
  };
  const candidate = candidateOf(build(existing), layer, existing?.id ?? null);
  const issues = validateEntries([candidate], context);
  if (errorsOf(issues).length > 0) return { ok: false, reason: 'invalid', issues };

  const cleaned = withoutDuplicates(candidate);
  if ((cleaned.variants ?? []).length !== (candidate.variants ?? []).length) {
    const recheck = errorsOf(validateEntries([cleaned], context));
    if (recheck.length > 0) return { ok: false, reason: 'invalid', issues: [...issues, ...recheck] };
  }

  const variants = cleaned.variants ?? [];
  const entry: Record<string, unknown> = {
    ...(existing ? { id: existing.id } : {}),
    canonical: cleaned.canonical,
    variants,
    normalized_variants: variants.map((variant) => normalizeLexical(variant)),
    language: cleaned.language,
    kind: cleaned.kind,
    mode: cleaned.mode,
    enabled: cleaned.enabled,
    note: cleaned.note,
    source_language: cleaned.source_language,
    target_language: cleaned.target_language,
  };
  const written = await callTerminologyRpc(
    'rag_term_upsert_entry',
    { p_actor: input.actorUserId, p_layer_key: input.layerKey, p_entry: entry, p_expected_version: input.expectedVersion },
    input.signal,
  );
  if (!written.ok) return written;
  const row = written.rows[0];
  const writtenId = row ? text(row, 'entry_id') : null;
  if (!row || !writtenId) {
    console.error('[RAG Admin] terminology call failed', { rpc: 'rag_term_upsert_entry', code: 'empty_result' });
    return UNAVAILABLE;
  }
  invalidateLayer(input.layerKey);
  return {
    ok: true,
    entryId: writtenId,
    layerVersion: count(row, 'layer_version'),
    entriesSha256: text(row, 'entries_sha256'),
    action: row.action === 'update' ? 'update' : 'create',
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

/** One page of a layer (suppression rows included), with the layer version and the enabled languages for the Config UI (D-35). */
export async function listEntries(
  input: LayerInput & { limit?: number; offset?: number; search?: string | null },
): Promise<ListTerminologyEntriesResult> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const search = typeof input.search === 'string' && input.search.trim() !== '' ? input.search.trim() : null;
  const page = await callTerminologyRpc('rag_term_list_entries', listArgs(input.actorUserId, input.layerKey, limit, offset, search), input.signal);
  if (!page.ok) return page;
  const state = await layerState(input.layerKey, input.signal);
  if (!state.ok) return state;
  return {
    ok: true,
    items: entriesOf(page.rows),
    total: count(page.rows[0], 'total_count'),
    limit,
    offset,
    layerVersion: state.state.version,
    entriesSha256: state.state.entries_sha256,
    enabledLanguages: terminologyEnabledLanguages(),
  };
}

/** Creates an entry of any kind, translation pairs included, after validateEntries against the layer (and the shared layer). */
export async function createEntry(
  input: LayerInput & { entry: TerminologyEntryInput; expectedVersion: number },
): Promise<WriteTerminologyEntryResult> {
  return writeEntry(input, null, () => input.entry);
}

/** Merges the patch into the stored entry (the writer replaces the whole entry), validates and writes it. */
export async function updateEntry(
  input: LayerInput & { entryId: string; patch: Partial<TerminologyEntryInput>; expectedVersion: number },
): Promise<WriteTerminologyEntryResult> {
  if (!UUID.test(input.entryId)) return { ok: false, reason: 'not_found' };
  return writeEntry(input, input.entryId, (existing) => ({ ...inputOf(existing!), ...definedOnly(input.patch) }));
}

export async function deleteEntry(
  input: LayerInput & { entryId: string; expectedVersion: number },
): Promise<DeleteTerminologyEntryResult> {
  if (!UUID.test(input.entryId)) return { ok: false, reason: 'not_found' };
  const result = await callTerminologyRpc(
    'rag_term_delete_entry',
    { p_actor: input.actorUserId, p_layer_key: input.layerKey, p_entry_id: input.entryId, p_expected_version: input.expectedVersion },
    input.signal,
  );
  if (!result.ok) return result;
  invalidateLayer(input.layerKey);
  const row = result.rows[0];
  return { ok: true, layerVersion: count(row, 'layer_version'), entriesSha256: row ? text(row, 'entries_sha256') : null };
}

/** Suppresses (or releases) one shared entry for the workspace layer (D-02). */
export async function setSuppression(
  input: LayerInput & { sharedEntryId: string; suppressed: boolean; expectedVersion: number },
): Promise<SetTerminologySuppressionResult> {
  if (!UUID.test(input.sharedEntryId)) return { ok: false, reason: 'not_found' };
  const result = await callTerminologyRpc(
    'rag_term_set_suppression',
    {
      p_actor: input.actorUserId,
      p_layer_key: input.layerKey,
      p_shared_entry_id: input.sharedEntryId,
      p_suppressed: input.suppressed,
      p_expected_version: input.expectedVersion,
    },
    input.signal,
  );
  if (!result.ok) return result;
  invalidateLayer(input.layerKey);
  const row = result.rows[0];
  return {
    ok: true,
    layerVersion: count(row, 'layer_version'),
    entriesSha256: row ? text(row, 'entries_sha256') : null,
    suppressed: row?.suppressed === undefined ? input.suppressed : row.suppressed === true,
  };
}

/** The shared version and, for a workspace, its version, each read only after the SQL check of the actor for that layer (D-05). */
export async function getVersions(input: {
  actorUserId: string;
  workspaceLayerKey: string | null;
  signal: AbortSignal;
}): Promise<TerminologyVersionsResult> {
  const versionOf = async (layerKey: string) => {
    const check = await callTerminologyRpc('rag_term_list_entries', listArgs(input.actorUserId, layerKey, 1, 0, null), input.signal);
    if (!check.ok) return check;
    return layerState(layerKey, input.signal);
  };
  const shared = await versionOf(SHARED);
  if (!shared.ok) return shared;
  if (input.workspaceLayerKey === null) return { ok: true, shared: shared.state, workspace: null };
  const workspace = await versionOf(input.workspaceLayerKey);
  if (!workspace.ok) return workspace;
  return { ok: true, shared: shared.state, workspace: workspace.state };
}

/** One page of a layer's audit, newest first (D-06). */
export async function listAudit(input: LayerInput & { limit?: number; offset?: number }): Promise<ListTerminologyAuditResult> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const result = await callTerminologyRpc(
    'rag_term_list_audit',
    { p_actor: input.actorUserId, p_layer_key: input.layerKey, p_limit: limit, p_offset: offset },
    input.signal,
  );
  if (!result.ok) return result;
  const items = result.rows
    .map((row): TerminologyAuditItem | null => {
      const id = text(row, 'id');
      const action = text(row, 'action');
      if (!id || !action) return null;
      return {
        id,
        layer_key: text(row, 'layer_key') ?? input.layerKey,
        entry_id: text(row, 'entry_id'),
        action,
        actor: text(row, 'actor'),
        before: row.before ?? null,
        after: row.after ?? null,
        layer_version: count(row, 'layer_version'),
        created_at: timeOf(row, 'created_at'),
      };
    })
    .filter((item): item is TerminologyAuditItem => item !== null);
  return { ok: true, items, total: count(result.rows[0], 'total_count'), limit, offset };
}
