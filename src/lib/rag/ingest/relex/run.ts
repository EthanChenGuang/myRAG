import type { RpcClient } from '../../backend/supabase-rpc';
import type { RagConfig } from '../../config';
import { detectLanguage } from '../../lang/detect';
import { getLanguageSettings } from '../../lang/settings';
import { LEXICAL_VERSION, chunkLexicalText } from '../../lexical/chunk-text';
import { lexicalOptionsOn, type LexicalOptions } from '../../lexical/options';
import type { LexicalStamp } from '../../lexical/resolve-options';
import type { BackfillScopeResult } from '../../tenant/backfill-scope';
import { tableRowLanguage, tableRowSeparator } from '../text/table-rows';
import { isTenantKey } from '../writer';

/** Bad arguments or limits; nothing was written. */
export class RelexInputError extends Error {
  readonly code: string;
  /** The failing RPC's error code (SQLSTATE or PostgREST code), when there is one. */
  readonly rpcCode: string | null;

  constructor(code: string, rpcCode: string | null = null) {
    super(`[RAG Relex] ${code}${rpcCode ? ` (${rpcCode})` : ''}`);
    this.name = 'RelexInputError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

export interface RelexBatchInfo {
  /** 1-based batch index within this call. */
  batch: number;
  /** Rows the batch RPC reported as updated. */
  updated: number;
  /** Last chunk id processed in this batch (the keyset cursor). */
  cursor: string;
}

export interface RunRelexInput {
  db: RpcClient;
  batchSize?: number;
  tenantKey?: string | null;
  resumeAfter?: string | null;
  onBatch?: (info: RelexBatchInfo) => void | Promise<void>;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /**
   * RAG_TABLE_ROW_SERIALIZATION as the run applies it (D-21). Given, the stale pass serializes table rows when true and a table pass
   * afterwards rewrites every current table chunk whose stored lexical_text does not match it. Absent, the run is the version-only relex.
   */
  tableRowSerialization?: boolean;
  /**
   * The typed configuration (plan 04.2-19). With RAG_LEXICAL_DICTIONARY, RAG_LEXICAL_STEM_IT or RAG_IDENTIFIER_INDEX on, the run targets
   * the effective lexical version, builds text with each tenant's options and stamps what it used; for one tenant it also rewrites chunks
   * whose stored dictionary or patterns stamp differs. Absent, or every lexical switch off: the version-only relex of today.
   */
  config?: Pick<RagConfig, 'v2'>;
  /** `--stale-dictionary`: only the tenant's chunks whose stored dictionary version differs (needs tenantKey and the dictionary on). */
  staleDictionary?: boolean;
  /** Operator scope for a candidate tenant key; default backfillScope (plan 04.2-13 pattern). */
  resolveScope?: (tenantKey: string) => Promise<BackfillScopeResult>;
  /**
   * RAG_ATTRIBUTE_HEADER as the run applies it (TPL-05, D-27): true reads the stored header of each candidate in step with its document
   * and puts it into the rebuilt text. Absent or false: no header read (the fixture harness and today's callers).
   */
  attributeHeader?: boolean;
}

export interface RelexReport {
  updated: number;
  batches: number;
  tenants: Record<string, number>;
  /** Table chunks the table pass rewrote; present only when the run was given tableRowSerialization. */
  tables?: number;
  /** Load failures of the stamped run (lexical_dictionary_unavailable, identifier_patterns_unavailable, tenant_scope_unavailable). */
  warnings?: string[];
}

export interface DryRunRelexInput {
  db: RpcClient;
  tenantKey?: string | null;
  batchSize?: number;
  resumeAfter?: string | null;
  signal?: AbortSignal;
  tableRowSerialization?: boolean;
  config?: Pick<RagConfig, 'v2'>;
  staleDictionary?: boolean;
  resolveScope?: (tenantKey: string) => Promise<BackfillScopeResult>;
  attributeHeader?: boolean;
  /** Notice lines (the D-33 recalibration reminder); counts and versions only. */
  onProgress?: (line: string) => void;
}

export interface DryRunRelexReport {
  tenants: Record<string, number>;
  total: number;
  /** Table chunks a run would rewrite in its table pass; present only when given tableRowSerialization. */
  tables?: number;
}

export const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;

type Row = Record<string, unknown>;

interface RelexCandidate {
  id: string;
  tenant_key: string;
  content: string;
  section_path: string[];
  chunk_kind: string | null;
  metadata: Record<string, unknown> | null;
  language: string | null;
  document_filename: string;
}

interface TableCandidate extends RelexCandidate {
  document_language: string | null;
  lexical_text: string | null;
}

type BatchRow = { id: string; lexical_text: string; language?: string; lexical_dict_version?: string | null; lexical_patterns?: string | null };

const MISSING_FUNCTION_CODES: ReadonlySet<string> = new Set(['PGRST202', '42883']);
const TABLE_CANDIDATES_RPC = 'rag_relex_table_candidates';

function checkBatchSize(batchSize: number | undefined): number {
  const size = batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new RelexInputError('invalid_batch_size');
  return size;
}

function checkTenantKey(tenantKey: string | null | undefined): string | null {
  const key = tenantKey ?? null;
  if (key !== null && !isTenantKey(key)) throw new RelexInputError('invalid_tenant_key');
  return key;
}

async function callRpc(db: RpcClient, signal: AbortSignal, rpc: string, args: Record<string, unknown>): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new RelexInputError(`rpc_failed:${rpc}`, response.error.code ?? null);
  return (response.data ?? []) as Row[];
}

function asCandidate(row: Row): RelexCandidate {
  const sectionPath = row.section_path;
  const metadata = row.metadata;
  return {
    id: String(row.id),
    tenant_key: String(row.tenant_key),
    content: typeof row.content === 'string' ? row.content : '',
    section_path: Array.isArray(sectionPath) ? sectionPath.map((entry) => String(entry)) : [],
    chunk_kind: typeof row.chunk_kind === 'string' ? row.chunk_kind : null,
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null,
    language: typeof row.language === 'string' ? row.language : null,
    document_filename: typeof row.document_filename === 'string' ? row.document_filename : '',
  };
}

/** The serialization the run applies; null means plain text (the switch off, or a run not given the switch). */
interface RowSerialization {
  enabled: boolean;
  primary: string | null;
}

function lexicalTextOf(
  candidate: RelexCandidate,
  rows: RowSerialization | null,
  documentLanguage: string | null = null,
  options?: LexicalOptions,
  attributeHeader?: string,
): string {
  const separator = rows
    ? tableRowSeparator(rows.enabled, candidate.chunk_kind, tableRowLanguage({ chunkLanguage: candidate.language, documentLanguage, primary: rows.primary }))
    : null;
  return chunkLexicalText({
    sectionPath: candidate.section_path,
    content: candidate.content,
    chunkKind: candidate.chunk_kind,
    metadata: candidate.metadata,
    documentFilename: candidate.document_filename,
    ...(separator !== null ? { tableRowSeparator: separator } : {}),
    ...(attributeHeader ? { attributeHeader } : {}),
  }, options);
}

/**
 * TPL-05 (D-27): the stored header of each candidate in step with its document, one read per tenant key of the page; a candidate that is
 * not in step keeps today's text. Empty without any call while RAG_ATTRIBUTE_HEADER is effectively off.
 */
async function pageHeaders(db: RpcClient, signal: AbortSignal, candidates: readonly RelexCandidate[], enabled: boolean | undefined): Promise<Map<string, string>> {
  if (enabled !== true || candidates.length === 0) return new Map();
  // Loaded here: the fixture harness imports this module before the app environment is set (env.ts validates at import).
  const { chunkHeadersFor } = await import('../attributes/header');
  try {
    return await chunkHeadersFor(
      candidates.map((candidate) => ({ chunkId: candidate.id, tenantKey: candidate.tenant_key })),
      { signal, db },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RelexInputError('rpc_failed:rag_attribute_headers', null);
  }
}

function batchRow(candidate: RelexCandidate, rows: RowSerialization | null, attributeHeader?: string): BatchRow {
  const lexical_text = lexicalTextOf(candidate, rows, null, undefined, attributeHeader);
  const row: BatchRow = { id: candidate.id, lexical_text };
  if (candidate.language === null) {
    const detected = detectLanguage(candidate.content);
    if (detected !== null) row.language = detected;
  }
  return row;
}

async function listCandidates(
  db: RpcClient,
  signal: AbortSignal,
  after: string | null,
  limit: number,
  tenantKey: string | null,
  version: number,
): Promise<RelexCandidate[]> {
  const rows = await callRpc(db, signal, 'rag_relex_candidates', {
    p_after: after,
    p_version: version,
    p_limit: limit,
    p_tenant_key: tenantKey,
  });
  return rows.map(asCandidate);
}

function asTableCandidate(row: Row): TableCandidate {
  return {
    ...asCandidate(row),
    document_language: typeof row.document_language === 'string' ? row.document_language : null,
    lexical_text: typeof row.lexical_text === 'string' ? row.lexical_text : null,
  };
}

/** A page of current table chunks with their stored text; null when the database predates the function (migration 0815). */
async function listTableCandidates(
  db: RpcClient,
  signal: AbortSignal,
  after: string | null,
  limit: number,
  tenantKey: string | null,
): Promise<TableCandidate[] | null> {
  signal.throwIfAborted();
  const response = await db.rpc(TABLE_CANDIDATES_RPC, { p_after: after, p_limit: limit, p_tenant_key: tenantKey }).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    if (response.error.code && MISSING_FUNCTION_CODES.has(response.error.code)) return null;
    throw new RelexInputError(`rpc_failed:${TABLE_CANDIDATES_RPC}`, response.error.code ?? null);
  }
  return ((response.data ?? []) as Row[]).map(asTableCandidate);
}

/** The table chunks of one page whose stored lexical_text differs from the text the switch state gives, with that text. */
function staleTableRows(candidates: TableCandidate[], rows: RowSerialization, headers: Map<string, string>): BatchRow[] {
  const out: BatchRow[] = [];
  for (const candidate of candidates) {
    const lexical_text = lexicalTextOf(candidate, rows, candidate.document_language, undefined, headers.get(candidate.id));
    if (lexical_text !== candidate.lexical_text) out.push({ id: candidate.id, lexical_text });
  }
  return out;
}

function rowSerializationOf(enabled: boolean | undefined): RowSerialization | null {
  if (enabled === undefined) return null;
  return { enabled, primary: enabled ? getLanguageSettings().primary : null };
}

/**
 * D-21 and research Pitfall 12: RAG_TABLE_ROW_SERIALIZATION changes the lexical_text of table chunks without a new LEXICAL_VERSION (it is
 * an embedding-text template change, not a tokenizer change), so two table chunks under one lexical_version may hold different text. The
 * version pass cannot see that; this pass compares each current table chunk's stored text with the switch state and rewrites the ones that
 * differ, keeping the version. With the switch off on a database without the function nothing can have been serialized, so it is skipped.
 */
async function tablePass(
  input: {
    db: RpcClient;
    signal: AbortSignal;
    batchSize: number;
    tenantKey: string | null;
    rows: RowSerialization;
    write: boolean;
    version: number;
    attributeHeader?: boolean;
  },
  onPage: (written: number, candidates: TableCandidate[], stale: BatchRow[]) => Promise<void>,
): Promise<number | null> {
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const candidates = await listTableCandidates(input.db, input.signal, after, input.batchSize, input.tenantKey);
    if (candidates === null) {
      if (input.rows.enabled) throw new RelexInputError(`rpc_failed:${TABLE_CANDIDATES_RPC}`, 'PGRST202');
      return null;
    }
    if (candidates.length === 0) break;
    const stale = staleTableRows(candidates, input.rows, await pageHeaders(input.db, input.signal, candidates, input.attributeHeader));
    const written = input.write ? await writeBatch(input.db, input.signal, stale, input.version) : stale.length;
    total += written;
    await onPage(written, candidates, stale);
    after = candidates[candidates.length - 1]?.id ?? after;
    if (candidates.length < input.batchSize) break;
  }
  return total;
}

async function writeBatch(db: RpcClient, signal: AbortSignal, rows: BatchRow[], version: number): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await callRpc(db, signal, 'rag_relex_batch', { p_rows: rows, p_version: version });
  const count = result[0]?.rag_relex_batch;
  return typeof count === 'number' ? count : Number(count ?? 0);
}

/** The version-only relex runs while every lexical switch is off, so its target is the effective version with no bit: LEXICAL_VERSION. */
function versionOnlyTarget(config: Pick<RagConfig, 'v2'> | undefined): number {
  return config?.v2.lexicalVersion ?? LEXICAL_VERSION;
}

/** D-33: refusal cells are keyed by the tokenizer version; a target with the quantity bit (+4) needs a new calibration. */
export const RECALIBRATE_REFUSAL_LINE = 'refusal thresholds are keyed by the tokenizer version: re-run `python -m rag_eval.calibrate refusal` from eval/';

export function hasQuantityBit(version: number): boolean {
  return version >= LEXICAL_VERSION && ((version - LEXICAL_VERSION) & 4) !== 0;
}

function recalibrationLine(version: number, candidates: number): string | null {
  return candidates > 0 && hasQuantityBit(version) ? `target version ${version}: ${RECALIBRATE_REFUSAL_LINE}` : null;
}

/**
 * Rebuilds lexical_text for every ready current chunk whose lexical_version differs from LEXICAL_VERSION, in
 * keyset batches, without parser, sidecar, object-store or embedding calls.
 */
export async function runRelex(input: RunRelexInput): Promise<RelexReport> {
  if (stampedRun(input)) return runStampedRelex(input);
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  let after = input.resumeAfter ?? null;
  const tenants: Record<string, number> = {};
  let updated = 0;
  let batches = 0;
  const rowSerialization = rowSerializationOf(input.tableRowSerialization);
  const version = versionOnlyTarget(input.config);

  input.onProgress?.(
    `started: version ${version}, batch size ${batchSize}${tenantKey ? `, tenant ${tenantKey}` : ', all tenants'}${after ? `, resume after ${after}` : ''}`,
  );

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listCandidates(input.db, signal, after, batchSize, tenantKey, version);
    if (candidates.length === 0) break;

    const headers = await pageHeaders(input.db, signal, candidates, input.attributeHeader);
    const rows = candidates.map((candidate) => batchRow(candidate, rowSerialization, headers.get(candidate.id)));
    const written = await writeBatch(input.db, signal, rows, version);
    batches += 1;
    updated += written;
    for (const candidate of candidates) {
      tenants[candidate.tenant_key] = (tenants[candidate.tenant_key] ?? 0) + 1;
    }
    const cursor = candidates[candidates.length - 1]?.id ?? after ?? '';
    await input.onBatch?.({ batch: batches, updated: written, cursor });
    input.onProgress?.(`batch ${batches}: updated ${written} (total ${updated})`);
    after = cursor;
    if (candidates.length < batchSize) break;
  }

  if (rowSerialization === null) {
    input.onProgress?.(`done: ${updated} rows in ${batches} batches`);
    return { updated, batches, tenants };
  }

  const tables = await tablePass(
    { db: input.db, signal, batchSize, tenantKey, rows: rowSerialization, write: true, version, attributeHeader: input.attributeHeader },
    async (written, candidates, stale) => {
      if (stale.length === 0) return;
      batches += 1;
      updated += written;
      for (const row of stale) {
        const tenant = candidates.find((candidate) => candidate.id === row.id)?.tenant_key;
        if (tenant) tenants[tenant] = (tenants[tenant] ?? 0) + 1;
      }
      input.onProgress?.(`table batch: rewrote ${written} table chunks (total ${updated})`);
    },
  );
  if (tables === null) input.onProgress?.('table pass skipped: rag_relex_table_candidates is not installed (migration 0815)');
  input.onProgress?.(`done: ${updated} rows in ${batches} batches`);
  return { updated, batches, tenants, tables: tables ?? 0 };
}

/** Counts stale chunks per tenant without writing. */
export async function dryRunRelex(input: DryRunRelexInput): Promise<DryRunRelexReport> {
  if (stampedRun(input)) return dryRunStampedRelex(input);
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  let after = input.resumeAfter ?? null;
  const tenants: Record<string, number> = {};
  const counted = new Set<string>();
  let total = 0;
  const version = versionOnlyTarget(input.config);

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listCandidates(input.db, signal, after, batchSize, tenantKey, version);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      tenants[candidate.tenant_key] = (tenants[candidate.tenant_key] ?? 0) + 1;
      counted.add(candidate.id);
      total += 1;
    }
    after = candidates[candidates.length - 1]?.id ?? after;
    if (candidates.length < batchSize) break;
  }

  const rowSerialization = rowSerializationOf(input.tableRowSerialization);
  if (rowSerialization === null) return { tenants, total };
  // A chunk the version pass already counts is rewritten there with the switch applied, so the table pass would not touch it again.
  let tables = 0;
  const installed = await tablePass({ db: input.db, signal, batchSize, tenantKey, rows: rowSerialization, write: false, version, attributeHeader: input.attributeHeader }, async (_count, candidates, stale) => {
    for (const row of stale) {
      if (counted.has(row.id)) continue;
      const tenant = candidates.find((candidate) => candidate.id === row.id)?.tenant_key;
      if (tenant) tenants[tenant] = (tenants[tenant] ?? 0) + 1;
      tables += 1;
    }
  });
  return { tenants, total: total + (installed === null ? 0 : tables), tables: installed === null ? 0 : tables };
}
// --- Stamped relex (plan 04.2-19: LANG-07 D-09, D-42; RET-15 D-30) ---------------------------------------------------------------------

const STAMPED_CANDIDATES_RPC = 'rag_relex_candidates_stamped';
const STAMPED_BATCH_RPC = 'rag_relex_batch_stamped';

interface StampedCandidate extends RelexCandidate {
  lexical_dict_version: string | null;
  lexical_patterns: string | null;
}

interface TenantLexical {
  options: LexicalOptions | undefined;
  stamp: LexicalStamp;
}

const NO_LEXICAL: TenantLexical = { options: undefined, stamp: { dictVersion: null, patterns: null } };

function lexicalSwitchesOn(config: Pick<RagConfig, 'v2'> | undefined): config is Pick<RagConfig, 'v2'> {
  return lexicalOptionsOn(config);
}

function stampedRun(input: { config?: Pick<RagConfig, 'v2'>; staleDictionary?: boolean; tenantKey?: string | null }): boolean {
  if (input.staleDictionary) {
    if (!input.tenantKey) throw new RelexInputError('stale_dictionary_needs_tenant');
    if (!input.config?.v2.lexicalDictionary) throw new RelexInputError('lexical_dictionary_off');
  }
  return lexicalSwitchesOn(input.config);
}

async function defaultResolveScope(tenantKey: string): Promise<BackfillScopeResult> {
  const { backfillScope } = await import('../../tenant/backfill-scope');
  return backfillScope(tenantKey);
}

/** Options and stamps per tenant key, resolved once per run with the operator scope; a failure means no options and no stamp. */
function tenantLexicalCache(
  config: Pick<RagConfig, 'v2'>,
  resolveScope: (tenantKey: string) => Promise<BackfillScopeResult>,
  signal: AbortSignal,
  warnings: Set<string>,
): (tenantKey: string) => Promise<TenantLexical> {
  const cache = new Map<string, Promise<TenantLexical>>();
  const load = async (tenantKey: string): Promise<TenantLexical> => {
    const scoped = await resolveScope(tenantKey);
    if (!scoped.ok) {
      warnings.add('tenant_scope_unavailable');
      return NO_LEXICAL;
    }
    const { resolveLexicalOptions } = await import('../../lexical/resolve-options');
    const resolved = await resolveLexicalOptions(scoped.scope, config, { language: null, signal });
    for (const warning of resolved.warnings) warnings.add(warning);
    return { options: resolved.options, stamp: resolved.stamp };
  };
  return (tenantKey) => {
    let entry = cache.get(tenantKey);
    if (!entry) {
      entry = load(tenantKey);
      cache.set(tenantKey, entry);
    }
    return entry;
  };
}

function asStampedCandidate(row: Row): StampedCandidate {
  return {
    ...asCandidate(row),
    lexical_dict_version: typeof row.lexical_dict_version === 'string' ? row.lexical_dict_version : null,
    lexical_patterns: typeof row.lexical_patterns === 'string' ? row.lexical_patterns : null,
  };
}

/** Stemming follows the chunk's language (detected when the chunk has none), as ingestion follows the document's. */
function chunkOptions(lexical: TenantLexical, language: string | null): LexicalOptions | undefined {
  if (!lexical.options) return undefined;
  return lexical.options.stemIt ? { ...lexical.options, language } : lexical.options;
}

function stampedRow(
  candidate: RelexCandidate,
  rows: RowSerialization | null,
  lexical: TenantLexical,
  documentLanguage: string | null = null,
  attributeHeader?: string,
): BatchRow {
  const detected = candidate.language === null ? detectLanguage(candidate.content) : null;
  const lexical_text = lexicalTextOf(candidate, rows, documentLanguage, chunkOptions(lexical, candidate.language ?? detected), attributeHeader);
  const row: BatchRow = { id: candidate.id, lexical_text, lexical_dict_version: lexical.stamp.dictVersion, lexical_patterns: lexical.stamp.patterns };
  if (detected !== null) row.language = detected;
  return row;
}

async function writeStamped(db: RpcClient, signal: AbortSignal, version: number, byTenant: Map<string, BatchRow[]>): Promise<number> {
  let total = 0;
  for (const [tenantKey, rows] of byTenant) {
    if (rows.length === 0) continue;
    const result = await callRpc(db, signal, STAMPED_BATCH_RPC, { p_rows: rows, p_version: version, p_tenant_key: tenantKey });
    const count = result[0]?.rag_relex_batch_stamped;
    total += typeof count === 'number' ? count : Number(count ?? 0);
  }
  return total;
}

function groupByTenant(entries: Array<{ tenantKey: string; row: BatchRow }>): Map<string, BatchRow[]> {
  const out = new Map<string, BatchRow[]>();
  for (const { tenantKey, row } of entries) {
    const list = out.get(tenantKey);
    if (list) list.push(row);
    else out.set(tenantKey, [row]);
  }
  return out;
}

interface StampedPlan {
  version: number;
  tenantKey: string | null;
  staleDictionary: boolean;
  /** The stamps the candidate function compares for one tenant; null for an all-tenant run or a part that failed to load. */
  stamp: LexicalStamp;
  lexicalFor: (tenantKey: string) => Promise<TenantLexical>;
  warnings: Set<string>;
}

async function stampedPlan(input: RunRelexInput | DryRunRelexInput, signal: AbortSignal): Promise<StampedPlan> {
  const config = input.config as Pick<RagConfig, 'v2'>;
  // Loaded here: the fixture harness imports this module before the app environment is set (env.ts validates at import).
  const { effectiveLexicalVersion } = await import('../../config');
  const tenantKey = checkTenantKey(input.tenantKey);
  const warnings = new Set<string>();
  const lexicalFor = tenantLexicalCache(config, input.resolveScope ?? defaultResolveScope, signal, warnings);
  const stamp = tenantKey ? (await lexicalFor(tenantKey)).stamp : NO_LEXICAL.stamp;
  return { version: effectiveLexicalVersion(config), tenantKey, staleDictionary: input.staleDictionary === true, stamp, lexicalFor, warnings };
}

async function listStampedCandidates(db: RpcClient, signal: AbortSignal, plan: StampedPlan, after: string | null, limit: number): Promise<StampedCandidate[]> {
  const rows = await callRpc(db, signal, STAMPED_CANDIDATES_RPC, {
    p_after: after,
    p_version: plan.version,
    p_limit: limit,
    p_tenant_key: plan.tenantKey,
    p_dict_version: plan.tenantKey ? plan.stamp.dictVersion : null,
    p_patterns: plan.tenantKey ? plan.stamp.patterns : null,
    p_stale_dictionary: plan.staleDictionary,
  });
  return rows.map(asStampedCandidate);
}

/** A stale-dictionary run whose dictionary did not load has nothing to compare with: it writes nothing and reports the warning. */
function staleDictionaryBlocked(plan: StampedPlan): boolean {
  return plan.staleDictionary && plan.stamp.dictVersion === null;
}

function startedLine(plan: StampedPlan, batchSize: number, after: string | null): string {
  return (
    `started: version ${plan.version}, dict=${plan.stamp.dictVersion ?? 'none'}${plan.staleDictionary ? ', stale dictionary only' : ''}, batch size ${batchSize}` +
    `${plan.tenantKey ? `, tenant ${plan.tenantKey}` : ', all tenants'}${after ? `, resume after ${after}` : ''}`
  );
}

async function stampedTablePass(
  input: { db: RpcClient; signal: AbortSignal; batchSize: number; plan: StampedPlan; rows: RowSerialization; write: boolean; attributeHeader?: boolean },
  onPage: (written: number, stale: Array<{ tenantKey: string; row: BatchRow }>) => Promise<void>,
): Promise<number | null> {
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const candidates = await listTableCandidates(input.db, input.signal, after, input.batchSize, input.plan.tenantKey);
    if (candidates === null) {
      if (input.rows.enabled) throw new RelexInputError(`rpc_failed:${TABLE_CANDIDATES_RPC}`, 'PGRST202');
      return null;
    }
    if (candidates.length === 0) break;
    const headers = await pageHeaders(input.db, input.signal, candidates, input.attributeHeader);
    const stale: Array<{ tenantKey: string; row: BatchRow }> = [];
    for (const candidate of candidates) {
      const lexical = await input.plan.lexicalFor(candidate.tenant_key);
      const lexical_text = lexicalTextOf(candidate, input.rows, candidate.document_language, chunkOptions(lexical, candidate.language), headers.get(candidate.id));
      if (lexical_text === candidate.lexical_text) continue;
      stale.push({
        tenantKey: candidate.tenant_key,
        row: { id: candidate.id, lexical_text, lexical_dict_version: lexical.stamp.dictVersion, lexical_patterns: lexical.stamp.patterns },
      });
    }
    const written = input.write ? await writeStamped(input.db, input.signal, input.plan.version, groupByTenant(stale)) : stale.length;
    total += written;
    await onPage(written, stale);
    after = candidates[candidates.length - 1]?.id ?? after;
    if (candidates.length < input.batchSize) break;
  }
  return total;
}

function withWarnings<T extends object>(report: T, warnings: Set<string>): T & { warnings?: string[] } {
  return warnings.size > 0 ? { ...report, warnings: [...warnings].sort() } : report;
}

async function runStampedRelex(input: RunRelexInput): Promise<RelexReport> {
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const plan = await stampedPlan(input, signal);
  let after = input.resumeAfter ?? null;
  const tenants: Record<string, number> = {};
  let updated = 0;
  let batches = 0;
  const rowSerialization = rowSerializationOf(input.tableRowSerialization);

  input.onProgress?.(startedLine(plan, batchSize, after));
  if (staleDictionaryBlocked(plan)) {
    input.onProgress?.('stopped: the dictionary did not load (lexical_dictionary_unavailable); nothing written');
    return withWarnings({ updated, batches, tenants }, plan.warnings);
  }

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listStampedCandidates(input.db, signal, plan, after, batchSize);
    if (candidates.length === 0) break;
    const headers = await pageHeaders(input.db, signal, candidates, input.attributeHeader);
    const entries: Array<{ tenantKey: string; row: BatchRow }> = [];
    for (const candidate of candidates) {
      entries.push({
        tenantKey: candidate.tenant_key,
        row: stampedRow(candidate, rowSerialization, await plan.lexicalFor(candidate.tenant_key), null, headers.get(candidate.id)),
      });
    }
    const written = await writeStamped(input.db, signal, plan.version, groupByTenant(entries));
    batches += 1;
    updated += written;
    for (const candidate of candidates) tenants[candidate.tenant_key] = (tenants[candidate.tenant_key] ?? 0) + 1;
    const cursor = candidates[candidates.length - 1]?.id ?? after ?? '';
    await input.onBatch?.({ batch: batches, updated: written, cursor });
    input.onProgress?.(`batch ${batches}: updated ${written} (total ${updated})`);
    after = cursor;
    if (candidates.length < batchSize) break;
  }

  let tables: number | null | undefined;
  if (rowSerialization !== null && !plan.staleDictionary) {
    tables = await stampedTablePass({ db: input.db, signal, batchSize, plan, rows: rowSerialization, write: true, attributeHeader: input.attributeHeader }, async (written, stale) => {
      if (stale.length === 0) return;
      batches += 1;
      updated += written;
      for (const { tenantKey } of stale) tenants[tenantKey] = (tenants[tenantKey] ?? 0) + 1;
      input.onProgress?.(`table batch: rewrote ${written} table chunks (total ${updated})`);
    });
    if (tables === null) input.onProgress?.('table pass skipped: rag_relex_table_candidates is not installed (migration 0815)');
  }
  if (plan.warnings.size > 0) input.onProgress?.(`warnings: ${[...plan.warnings].sort().join(', ')}`);
  const reminder = recalibrationLine(plan.version, Object.values(tenants).reduce((sum, count) => sum + count, 0));
  if (reminder) input.onProgress?.(reminder);
  input.onProgress?.(`done: ${updated} rows in ${batches} batches, dict=${plan.stamp.dictVersion ?? 'none'}`);
  const report: RelexReport = { updated, batches, tenants };
  if (tables !== undefined) report.tables = tables ?? 0;
  return withWarnings(report, plan.warnings);
}

async function dryRunStampedRelex(input: DryRunRelexInput): Promise<DryRunRelexReport> {
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const plan = await stampedPlan(input, signal);
  let after = input.resumeAfter ?? null;
  const tenants: Record<string, number> = {};
  const counted = new Set<string>();
  let total = 0;
  if (staleDictionaryBlocked(plan)) return { tenants, total };

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listStampedCandidates(input.db, signal, plan, after, batchSize);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      tenants[candidate.tenant_key] = (tenants[candidate.tenant_key] ?? 0) + 1;
      counted.add(candidate.id);
      total += 1;
    }
    after = candidates[candidates.length - 1]?.id ?? after;
    if (candidates.length < batchSize) break;
  }

  const rowSerialization = rowSerializationOf(input.tableRowSerialization);
  const remind = (report: DryRunRelexReport): DryRunRelexReport => {
    const reminder = recalibrationLine(plan.version, report.total);
    if (reminder) input.onProgress?.(reminder);
    return report;
  };
  if (rowSerialization === null || plan.staleDictionary) return remind({ tenants, total });
  let tables = 0;
  const installed = await stampedTablePass({ db: input.db, signal, batchSize, plan, rows: rowSerialization, write: false, attributeHeader: input.attributeHeader }, async (_count, stale) => {
    for (const { tenantKey, row } of stale) {
      if (counted.has(row.id)) continue;
      tenants[tenantKey] = (tenants[tenantKey] ?? 0) + 1;
      tables += 1;
    }
  });
  return remind({ tenants, total: total + (installed === null ? 0 : tables), tables: installed === null ? 0 : tables });
}
