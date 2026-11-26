import { rpcRows, type RpcClient, type RpcRequest } from '../../backend/supabase-rpc';
import { getRagDeps } from '../../deps';
import { lexicalRegistryRules, lexicalTokens, normalizeLexical, queryLexicalTokens } from '../../lexical/tokenize';
import { backfillScope } from '../../tenant/backfill-scope';
import { parseTenantKey } from '../../tenant/embed';
import type { TenantScope } from '../../tenant/scope';
import { loadEffectiveDictionary, type EffectiveDictionary } from '../load';
import { termKey } from '../matcher';

/** D-26 defaults; PO-4: misses older than 30 days are purged before mining (a fixed constant, no env var). */
export const MINE_DEFAULT_WINDOW_DAYS = 14;
export const MINE_MAX_WINDOW_DAYS = 30;
export const MINE_DEFAULT_MIN_SUPPORT = 3;
export const MISS_RETENTION_DAYS = 30;
export const MINE_MAX_CORPUS_DF = 2;
export const MINE_MAX_EXAMPLES = 3;
export const MINE_MAX_CANDIDATES_PER_TENANT = 1000;
const TERM_MAX_CHARS = 64;
const DF_BATCH = 200;
const UPSERT_BATCH = 500;
const HAN_MIN_GRAM = 2;
const HAN_MAX_GRAM = 4;
const ANY_LANGUAGE = 'any';
const TAG = '[RAG Terminology]';

/** The tokens maskPII writes (src/lib/rag/trace/mask.ts); they are removed before tokenizing so they never become terms. */
const MASK_PLACEHOLDER = /\[(?:EMAIL|IBAN|ID|CARD|PHONE|TRUNCATED)\]/g;
const HAN_RUN = /\p{Script=Han}+/gu;
const HAN_ONLY = /^\p{Script=Han}+$/u;
const DIGITS_ONLY = /^[\p{N}\s._,-]+$/u;
const TOKEN_SAFE = /^[^'\\\s]+$/u;

interface ChainResponse {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

/** The PostgREST select chain readMisses uses to list the tenants with misses in the window. */
export interface MinerSelect extends PromiseLike<ChainResponse> {
  select(columns: string): MinerSelect;
  gte(column: string, value: string): MinerSelect;
  gt(column: string, value: string): MinerSelect;
  order(column: string, options?: { ascending?: boolean }): MinerSelect;
  limit(count: number): MinerSelect;
  abortSignal(signal: AbortSignal): MinerSelect;
}

/** The service-role client: the 0473 functions, rag_term_effective, and one table read in readMisses. */
export interface MinerDb extends RpcClient {
  from(table: string): MinerSelect;
}

export interface MissRow {
  id: string | null;
  source: string;
  query_masked: string;
  language: string | null;
  created_at: string | null;
}

export interface TenantMisses {
  tenantKey: string;
  misses: MissRow[];
}

export class MineError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`${TAG} ${code}`);
    this.name = 'MineError';
    this.code = code;
  }
}

async function call(request: RpcRequest, signal: AbortSignal | undefined, code: string): Promise<unknown[]> {
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw new MineError(`${code} (${error.code ?? 'rpc_error'})`);
  return rpcRows(data);
}

/** The integer a scalar function returns: PostgREST sends the bare value; a one-column row carries it as its only field. */
function scalarCount(rows: unknown[]): number {
  let value = rows[0];
  if (value && typeof value === 'object') {
    const fields = Object.values(value as Record<string, unknown>);
    value = fields.length === 1 ? fields[0] : undefined;
  }
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function missOf(row: unknown): MissRow | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const query = textOf(record.query_masked);
  if (!query) return null;
  return {
    id: textOf(record.id),
    source: textOf(record.source) ?? 'miss_log',
    query_masked: query,
    language: textOf(record.language),
    created_at: textOf(record.created_at),
  };
}

/**
 * D-25a: the one reader of the miss source. Phase 5.1.1 points this function at rag_retrieval_log; nothing else reads misses.
 * With a tenant key it reads that tenant only; without one it lists the tenants with misses in the window, one key at a time.
 */
export async function readMisses(
  db: MinerDb,
  input: { tenantKey?: string | null; windowDays: number; signal?: AbortSignal },
): Promise<TenantMisses[]> {
  const windowDays = Math.min(Math.max(Math.trunc(input.windowDays), 1), MINE_MAX_WINDOW_DAYS);
  let tenants: string[];
  if (input.tenantKey) {
    tenants = [input.tenantKey];
  } else {
    tenants = [];
    const since = new Date(getRagDeps().now() - windowDays * 86_400_000).toISOString();
    let last: string | null = null;
    for (;;) {
      let query = db.from('rag_term_misses').select('tenant_key').gte('created_at', since);
      if (last !== null) query = query.gt('tenant_key', last);
      query = query.order('tenant_key', { ascending: true }).limit(1);
      if (input.signal) query = query.abortSignal(input.signal);
      const { data, error } = await query;
      if (error) throw new MineError(`miss tenants read failed (${error.code ?? 'error'})`);
      const key = textOf((rpcRows(data)[0] as Record<string, unknown> | undefined)?.tenant_key);
      if (!key || (last !== null && key <= last)) break;
      tenants.push(key);
      last = key;
    }
  }
  const out: TenantMisses[] = [];
  for (const tenantKey of tenants) {
    const rows = await call(db.rpc('rag_term_read_misses', { p_tenant_key: tenantKey, p_window_days: windowDays }), input.signal, 'miss read failed');
    out.push({ tenantKey, misses: rows.map(missOf).filter((miss): miss is MissRow => miss !== null) });
  }
  return out;
}

const RULES = lexicalRegistryRules();

function keepTerm(term: string): boolean {
  if (term === '' || Array.from(term).length > TERM_MAX_CHARS) return false;
  if (DIGITS_ONLY.test(term)) return false;
  if (HAN_ONLY.test(term)) return Array.from(term).length >= HAN_MIN_GRAM && !RULES.hanStopwords.has(term);
  return !RULES.stopwords.has(term);
}

/** D-26: the lexical query tokens plus Han 2-4-grams of a masked query, without mask placeholders, digit-only terms or stopwords. */
export function extractTerms(query: string): string[] {
  const text = query.replace(MASK_PLACEHOLDER, ' ');
  const terms = new Set<string>();
  for (const token of queryLexicalTokens(text)) if (keepTerm(token)) terms.add(token);
  for (const run of normalizeLexical(text).match(HAN_RUN) ?? []) {
    const chars = Array.from(run);
    for (let size = HAN_MIN_GRAM; size <= HAN_MAX_GRAM; size += 1) {
      for (let start = 0; start + size <= chars.length; start += 1) {
        const gram = chars.slice(start, start + size).join('');
        if (keepTerm(gram)) terms.add(gram);
      }
    }
  }
  return [...terms];
}

interface Known {
  keys: Set<string>;
  hanSurfaces: string[];
}

/** Every surface of the effective dictionary (canonicals, variants, normalized variants, translation pairs included). */
function knownTerms(dictionary: EffectiveDictionary): Known {
  const keys = new Set<string>();
  const hanSurfaces: string[] = [];
  for (const entry of dictionary.entries) {
    for (const surface of [entry.canonical, ...entry.variants, ...entry.normalizedVariants]) {
      const key = termKey(surface);
      if (key) keys.add(key);
      const tokens = queryLexicalTokens(surface);
      if (tokens.length === 1) keys.add(tokens[0]!);
      const normalized = normalizeLexical(surface).replace(/\s+/gu, '');
      if (HAN_ONLY.test(normalized)) hanSurfaces.push(normalized);
    }
  }
  return { keys, hanSurfaces };
}

function isKnown(term: string, known: Known): boolean {
  if (known.keys.has(termKey(term)) || known.keys.has(term)) return true;
  return HAN_ONLY.test(term) && known.hanSurfaces.some((surface) => surface.includes(term));
}

interface Group {
  language: string;
  term: string;
  queries: string[];
  source: string;
}

export interface MinedCandidate {
  term: string;
  language: string;
  support: number;
  examples: string[];
  corpus_df: number;
  source: string;
}

function groupTerms(misses: readonly MissRow[], minSupport: number): { groups: Group[]; distinctQueries: number } {
  const seen = new Set<string>();
  const groups = new Map<string, Group>();
  for (const miss of misses) {
    if (seen.has(miss.query_masked)) continue;
    seen.add(miss.query_masked);
    const language = miss.language ?? ANY_LANGUAGE;
    for (const term of extractTerms(miss.query_masked)) {
      const key = `${language}\u0000${term}`;
      const group = groups.get(key);
      if (group) group.queries.push(miss.query_masked);
      else groups.set(key, { language, term, queries: [miss.query_masked], source: miss.source });
    }
  }
  const kept = [...groups.values()].filter((group) => group.queries.length >= minSupport);
  // A Han gram inside a longer kept gram of the same queries is the same term cut short: keep the longest one only.
  const closed = kept.filter(
    (group) =>
      !HAN_ONLY.test(group.term) ||
      !kept.some(
        (other) =>
          other !== group &&
          other.language === group.language &&
          HAN_ONLY.test(other.term) &&
          other.term.length > group.term.length &&
          other.term.includes(group.term) &&
          other.queries.length === group.queries.length,
      ),
  );
  return { groups: closed, distinctQueries: seen.size };
}

function dfTokens(term: string): string[] {
  return [...new Set(lexicalTokens(term))].filter((token) => token !== '' && TOKEN_SAFE.test(token));
}

/**
 * D-26: per-tenant corpus document frequency through rag_term_corpus_df. A term with several lexical tokens takes the smallest token
 * count, an upper bound of the documents holding all of them, so a candidate is never kept on an undercount.
 */
async function corpusDf(db: MinerDb, tenantKey: string, terms: readonly string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const byTerm = new Map(terms.map((term) => [term, dfTokens(term)] as const));
  const tokens = [...new Set([...byTerm.values()].flat())];
  const counts = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += DF_BATCH) {
    const rows = await call(
      db.rpc('rag_term_corpus_df', { p_tenant_key: tenantKey, p_tokens: tokens.slice(index, index + DF_BATCH) }),
      signal,
      'corpus df failed',
    );
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const token = textOf(record.token);
      const value = typeof record.df === 'string' ? Number(record.df) : record.df;
      if (token && typeof value === 'number' && Number.isFinite(value)) counts.set(token, value);
    }
  }
  const out = new Map<string, number>();
  for (const [term, termTokens] of byTerm) {
    out.set(term, termTokens.length === 0 ? 0 : Math.min(...termTokens.map((token) => counts.get(token) ?? 0)));
  }
  return out;
}

export interface TenantMineReport {
  tenantKey: string;
  misses: number;
  distinctQueries: number;
  candidates: number;
  upserted: number;
  error?: string;
}

export interface MineReport {
  dryRun: boolean;
  purged: number | null;
  tenants: TenantMineReport[];
}

export interface MineInput {
  tenantKey?: string | null;
  windowDays?: number;
  minSupport?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** The service-role client; the RAG admin client when omitted. */
  db?: MinerDb;
  /** The minted scope of a tenant key for the dictionary load; backfillScope when omitted. Null skips the tenant. */
  resolveScope?: (tenantKey: string) => Promise<TenantScope | null>;
}

async function defaultScope(tenantKey: string, signal?: AbortSignal): Promise<TenantScope | null> {
  const resolved = await backfillScope(tenantKey, signal ? { signal } : undefined);
  return resolved.ok ? resolved.scope : null;
}

/** The candidates of one tenant's misses, before any write. */
export async function mineTenant(
  db: MinerDb,
  tenantKey: string,
  misses: readonly MissRow[],
  dictionary: EffectiveDictionary,
  options: { minSupport: number; signal?: AbortSignal },
): Promise<{ candidates: MinedCandidate[]; distinctQueries: number }> {
  const { groups, distinctQueries } = groupTerms(misses, options.minSupport);
  const known = knownTerms(dictionary);
  const unknown = groups.filter((group) => !isKnown(group.term, known));
  if (unknown.length === 0) return { candidates: [], distinctQueries };
  const df = await corpusDf(db, tenantKey, [...new Set(unknown.map((group) => group.term))], options.signal);
  const candidates = unknown
    .map((group): MinedCandidate => ({
      term: group.term,
      language: group.language,
      support: group.queries.length,
      examples: group.queries.slice(0, MINE_MAX_EXAMPLES),
      corpus_df: df.get(group.term) ?? 0,
      source: group.source,
    }))
    .filter((candidate) => candidate.corpus_df <= MINE_MAX_CORPUS_DF)
    .sort((a, b) => b.support - a.support || (a.term < b.term ? -1 : a.term > b.term ? 1 : a.language < b.language ? -1 : 1))
    .slice(0, MINE_MAX_CANDIDATES_PER_TENANT);
  return { candidates, distinctQueries };
}

/**
 * D-26: mines candidate terms per tenant from the miss source and upserts them into rag_term_candidates (never into rag_term_entries;
 * a dismissed or accepted candidate keeps its status, enforced by rag_term_upsert_candidates). A run that writes purges misses older
 * than 30 days first (PO-4); a dry run reads only. Logs carry counts only.
 */
export async function mineCandidates(input: MineInput = {}): Promise<MineReport> {
  const db = input.db ?? (getRagDeps().adminClient() as unknown as MinerDb | null);
  if (!db) throw new MineError('admin client unavailable');
  if (input.tenantKey !== undefined && input.tenantKey !== null && !parseTenantKey(input.tenantKey)) throw new MineError('invalid tenant key');
  const windowDays = input.windowDays ?? MINE_DEFAULT_WINDOW_DAYS;
  const minSupport = Math.max(Math.trunc(input.minSupport ?? MINE_DEFAULT_MIN_SUPPORT), 1);
  const dryRun = input.dryRun === true;
  const resolveScope = input.resolveScope ?? ((tenantKey: string) => defaultScope(tenantKey, input.signal));

  let purged: number | null = null;
  if (!dryRun) {
    purged = scalarCount(await call(db.rpc('rag_term_purge_misses', { p_older_than_days: MISS_RETENTION_DAYS }), input.signal, 'purge failed'));
  }

  const tenants = await readMisses(db, { tenantKey: input.tenantKey ?? null, windowDays, ...(input.signal ? { signal: input.signal } : {}) });
  const reports: TenantMineReport[] = [];
  for (const { tenantKey, misses } of tenants) {
    const report: TenantMineReport = { tenantKey, misses: misses.length, distinctQueries: 0, candidates: 0, upserted: 0 };
    reports.push(report);
    if (misses.length === 0) continue;
    try {
      const scope = await resolveScope(tenantKey);
      if (!scope) {
        report.error = 'scope_unavailable';
        continue;
      }
      let dictionary: EffectiveDictionary;
      try {
        dictionary = await loadEffectiveDictionary(scope, { bypassCache: true, client: db, ...(input.signal ? { signal: input.signal } : {}) });
      } catch {
        report.error = 'dictionary_unavailable';
        continue;
      }
      if (dictionary.tenantKey !== tenantKey) {
        report.error = 'scope_mismatch';
        continue;
      }
      const mined = await mineTenant(db, tenantKey, misses, dictionary, { minSupport, ...(input.signal ? { signal: input.signal } : {}) });
      report.distinctQueries = mined.distinctQueries;
      report.candidates = mined.candidates.length;
      if (dryRun) continue;
      for (let index = 0; index < mined.candidates.length; index += UPSERT_BATCH) {
        const rows = await call(
          db.rpc('rag_term_upsert_candidates', { p_tenant_key: tenantKey, p_rows: mined.candidates.slice(index, index + UPSERT_BATCH) }),
          input.signal,
          'candidate upsert failed',
        );
        report.upserted += scalarCount(rows);
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      report.error = error instanceof MineError ? 'database_error' : 'failed';
    }
  }
  const failed = reports.filter((report) => report.error !== undefined).length;
  console.log(`${TAG} mining finished`, {
    dryRun,
    tenants: reports.length,
    failed,
    candidates: reports.reduce((sum, report) => sum + report.candidates, 0),
    upserted: reports.reduce((sum, report) => sum + report.upserted, 0),
    purged,
  });
  return { dryRun, purged, tenants: reports };
}
