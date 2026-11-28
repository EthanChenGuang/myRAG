import type { PGlite } from '@electric-sql/pglite';
import { bm25CandidateLimit } from '../../src/lib/rag/backend/pgvector';
import type { LexicalOptions } from '../../src/lib/rag/lexical/options';
import { queryLexicalTokens } from '../../src/lib/rag/lexical/tokenize';
import { lexicalOnlyHybridArgs } from './lexical-leg-run.mts';

/**
 * D-36: lexical statistics on a fixture database. seedFixtureLexicalStats enables and rebuilds each tenant through the 0902 functions
 * (the same calls npm run rag:lexstats makes); fixtureOverlapAtK measures how far the BM25 candidate cap changes the lexical top k:
 * for each question, the share of the uncapped top k (p_candidate_limit 0, every match) that the capped call keeps in its top k.
 */

export const OVERLAP_FILE = 'lexical-bm25-overlap.json';
export const OVERLAP_K = 10;

const LEGACY_PROFILE_ID = 'openai-3-small-1536';

export interface TenantLexicalStats {
  tenant_key: string;
  state: string;
  chunk_count: number;
  clean: boolean;
  /** Plan 04.4-18, cluster DF mode only: units counted in corpus chunks_cluster and rows of the unit ledger (numbers only). */
  cluster_units?: number;
  cluster_ledger_rows?: number;
}

function statusOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

async function serviceRole<T>(db: PGlite, run: (tx: { query: PGlite['query'] }) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return run(tx as unknown as { query: PGlite['query'] });
  });
}

/** The tenant keys that own at least one chunk, in key order. */
export async function fixtureTenantKeys(db: PGlite): Promise<string[]> {
  const rows = await db.query<{ tenant_key: string }>(
    'SELECT DISTINCT tenant_key FROM public.document_chunks WHERE tenant_key IS NOT NULL ORDER BY tenant_key',
  );
  return rows.rows.map((row) => row.tenant_key);
}

/**
 * Enable, rebuild and check every tenant; throws when a tenant does not end ready and clean. With `cluster` (plan 04.4-18, effective DF
 * mode cluster) the tenant is also cluster-enabled (0905) before the rebuild, which then builds corpus chunks_cluster and the unit
 * ledger; the check then covers both corpora and the cluster status must end ready.
 */
export async function seedFixtureLexicalStats(
  db: PGlite,
  tenantKeys: readonly string[],
  options: { cluster?: boolean } = {},
): Promise<TenantLexicalStats[]> {
  const out: TenantLexicalStats[] = [];
  for (const tenantKey of tenantKeys) {
    const report = await serviceRole(db, async (tx) => {
      await tx.query('SELECT public.rag_lexstats_enable($1)', [tenantKey]);
      if (options.cluster) await tx.query('SELECT public.rag_lexstats_cluster_enable($1)', [tenantKey]);
      await tx.query('SELECT public.rag_lexstats_rebuild($1)', [tenantKey]);
      const status = statusOf((await tx.query<{ s: unknown }>('SELECT public.rag_lexstats_status($1) AS s', [tenantKey])).rows[0]?.s);
      const check = statusOf((await tx.query<{ c: unknown }>('SELECT public.rag_lexstats_check($1) AS c', [tenantKey])).rows[0]?.c);
      if (!options.cluster) return { status, check, cluster: null };
      const units = await tx.query<{ n: number }>(
        "SELECT COALESCE(sum(chunk_count), 0)::int AS n FROM public.rag_lexical_corpus WHERE tenant_key = $1 AND corpus = 'chunks_cluster'",
        [tenantKey],
      );
      const ledger = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_lexical_cluster_units WHERE tenant_key = $1', [tenantKey]);
      return { status, check, cluster: { units: Number(units.rows[0]?.n ?? 0), ledger: Number(ledger.rows[0]?.n ?? 0) } };
    });
    const entry: TenantLexicalStats = {
      tenant_key: tenantKey,
      state: String(report.status.state ?? ''),
      chunk_count: Number(report.status.chunk_count ?? 0),
      clean: report.check.clean === true,
      ...(report.cluster ? { cluster_units: report.cluster.units, cluster_ledger_rows: report.cluster.ledger } : {}),
    };
    if (entry.state !== 'ready' || !entry.clean) throw new Error(`[Fixture DB] lexical statistics did not end ready and clean (${entry.state || 'none'})`);
    if (options.cluster && report.status.cluster_status !== 'ready') {
      throw new Error(`[Fixture DB] cluster lexical statistics did not end ready (${String(report.status.cluster_status ?? 'none')})`);
    }
    out.push(entry);
  }
  return out;
}

export interface OverlapQuestion {
  id: string;
  question: string;
}

export interface OverlapRow {
  item_id: string;
  /** null when the uncapped call has no hit (the question does not count toward the mean). */
  overlap: number | null;
  uncapped: number;
}

export interface OverlapReport {
  schema_version: 1;
  /** Plan 04.4-18: present only for a run whose effective DF mode is cluster (both calls then send p_df_mode cluster). */
  df_mode?: 'cluster';
  tenant_hash: string;
  k: number;
  capped_candidate_limit: number;
  questions: number;
  measured: number;
  mean_overlap_at_k: number | null;
  min_overlap_at_k: number | null;
  items: OverlapRow[];
}

async function bm25Top(db: PGlite, args: Record<string, unknown>, k: number): Promise<string[]> {
  const keys = Object.keys(args);
  const sql = `SELECT chunk_id, rank FROM public.rag_bm25_search_chunks(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')}) WHERE leg = 'lexical' ORDER BY rank`;
  const rows = await serviceRole(db, async (tx) => (await tx.query<{ chunk_id: string }>(sql, keys.map((key) => args[key]))).rows);
  return rows.slice(0, k).map((row) => String(row.chunk_id));
}

/**
 * Per question: |capped top k ∩ uncapped top k| / |uncapped top k|. The capped call uses the cap the app sends for a lexical limit
 * of k (bm25CandidateLimit); the uncapped call sends 0. Ids and counts only, never a token.
 */
export async function fixtureOverlapAtK(
  db: PGlite,
  tenantKey: string,
  questions: readonly OverlapQuestion[],
  k: number = OVERLAP_K,
  options: {
    lexicalOptionsFor?: (question: string) => Promise<LexicalOptions | undefined>;
    profileId?: string;
    tenantHash?: string;
    k1?: number;
    b?: number;
    /** Plan 04.4-18 (gate c): `cluster` scores both the capped and the uncapped call on corpus chunks_cluster. */
    dfMode?: 'raw' | 'cluster';
  } = {},
): Promise<OverlapReport> {
  const cap = bm25CandidateLimit(k);
  const cluster = options.dfMode === 'cluster';
  const items: OverlapRow[] = [];
  for (const question of questions) {
    const tokens = queryLexicalTokens(question.question, options.lexicalOptionsFor ? await options.lexicalOptionsFor(question.question) : undefined);
    if (tokens.length === 0) {
      items.push({ item_id: question.id, overlap: null, uncapped: 0 });
      continue;
    }
    const base = lexicalOnlyHybridArgs(tenantKey, options.profileId ?? LEGACY_PROFILE_ID, tokens, k);
    delete base.p_dense_limit;
    const common = { ...base, p_k1: options.k1 ?? 1.2, p_b: options.b ?? 0.75, ...(cluster ? { p_df_mode: 'cluster' } : {}) };
    const capped = await bm25Top(db, { ...common, p_candidate_limit: cap }, k);
    const uncapped = await bm25Top(db, { ...common, p_candidate_limit: 0 }, k);
    const kept = new Set(capped);
    items.push({
      item_id: question.id,
      overlap: uncapped.length === 0 ? null : uncapped.filter((id) => kept.has(id)).length / uncapped.length,
      uncapped: uncapped.length,
    });
  }
  const measured = items.map((row) => row.overlap).filter((value): value is number => value !== null);
  return {
    schema_version: 1,
    ...(cluster ? { df_mode: 'cluster' as const } : {}),
    tenant_hash: options.tenantHash ?? '',
    k,
    capped_candidate_limit: cap,
    questions: items.length,
    measured: measured.length,
    mean_overlap_at_k: measured.length === 0 ? null : measured.reduce((sum, value) => sum + value, 0) / measured.length,
    min_overlap_at_k: measured.length === 0 ? null : Math.min(...measured),
    items,
  };
}

export const TIES_FILE = 'lexical-ties.json';
export const TIES_K = 10;
const TIE_EPSILON = 1e-6;
const NEAR_DUP_JACCARD = 0.8;

export interface TieQuestion {
  id: string;
  question: string;
  category: string | null;
}

export interface TieHit {
  document_id: string;
  score: number;
  shingles: Set<string>;
}

export interface ArmTieStats {
  hits: number;
  distinct_documents: number;
  /** Groups of two or more adjacent top-k hits whose scores are equal within a relative 1e-6. */
  tie_groups: number;
  tied_hits: number;
  /** Tie groups whose members are all near duplicates of each other (word-trigram Jaccard at least 0.8). */
  duplicate_tie_groups: number;
  /** Top-k hit pairs that are near duplicates, whatever their scores. */
  duplicate_pairs: number;
  /** A tie group crosses the rank-5 or rank-10 cut, so the order inside it decides what the cut keeps. */
  tie_at_cut_5: boolean;
  tie_at_cut_10: boolean;
  /** Mean relative score gap between adjacent near-duplicate hits; null when no two adjacent hits are near duplicates. */
  mean_duplicate_gap: number | null;
}

export interface TieRow {
  item_id: string;
  category: string | null;
  token_count: number;
  arms: { bm25: ArmTieStats; ts_rank_cd: ArmTieStats };
}

export interface TieReport {
  schema_version: 1;
  tenant_hash: string;
  k: number;
  near_duplicate_jaccard: number;
  categories: string[];
  items: TieRow[];
}

export function shinglesOf(content: string): Set<string> {
  const words = content.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
  const out = new Set<string>();
  if (words.length < 3) {
    out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + 2 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const value of a) if (b.has(value)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function sameScore(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIE_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Ties and near duplicates of one ranked lexical list (already in rank order, at most k hits). */
export function armTieStats(hits: readonly TieHit[]): ArmTieStats {
  const groups: number[][] = [];
  let current: number[] = [];
  hits.forEach((hit, index) => {
    if (current.length > 0 && sameScore(hits[current[current.length - 1]].score, hit.score)) current.push(index);
    else {
      if (current.length > 1) groups.push(current);
      current = [index];
    }
  });
  if (current.length > 1) groups.push(current);
  const dup = (i: number, j: number) => jaccard(hits[i].shingles, hits[j].shingles) >= NEAR_DUP_JACCARD;
  let duplicatePairs = 0;
  for (let i = 0; i < hits.length; i += 1) for (let j = i + 1; j < hits.length; j += 1) if (dup(i, j)) duplicatePairs += 1;
  const gaps: number[] = [];
  for (let i = 0; i + 1 < hits.length; i += 1) {
    if (!dup(i, i + 1)) continue;
    gaps.push(Math.abs(hits[i].score - hits[i + 1].score) / Math.max(Math.abs(hits[i].score), 1e-12));
  }
  const crosses = (cut: number) => groups.some((group) => group[0] < cut && group[group.length - 1] >= cut);
  return {
    hits: hits.length,
    distinct_documents: new Set(hits.map((hit) => hit.document_id)).size,
    tie_groups: groups.length,
    tied_hits: groups.reduce((sum, group) => sum + group.length, 0),
    duplicate_tie_groups: groups.filter((group) => group.every((i) => group.every((j) => i === j || dup(i, j)))).length,
    duplicate_pairs: duplicatePairs,
    tie_at_cut_5: crosses(5),
    tie_at_cut_10: crosses(10),
    mean_duplicate_gap: gaps.length === 0 ? null : gaps.reduce((sum, value) => sum + value, 0) / gaps.length,
  };
}

async function scoredLexical(db: PGlite, fn: 'hybrid_search_chunks' | 'rag_bm25_search_chunks', args: Record<string, unknown>, k: number): Promise<TieHit[]> {
  const keys = Object.keys(args);
  const sql = `SELECT document_id, content, lexical_score FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')}) WHERE leg = 'lexical' ORDER BY rank`;
  const rows = await serviceRole(db, async (tx) =>
    (await tx.query<{ document_id: string; content: string | null; lexical_score: number | null }>(sql, keys.map((key) => args[key]))).rows,
  );
  return rows.slice(0, k).map((row) => ({ document_id: String(row.document_id), score: Number(row.lexical_score ?? 0), shingles: shinglesOf(row.content ?? '') }));
}

/**
 * Report-only diagnostic (quick-44, Phase 4.4 gap G1): for the questions of the named categories, the lexical top k of the BM25 leg
 * (the cap the app sends) and of the ts_rank_cd leg with their scores, summarised as score ties and near-duplicate counts. Ids and
 * numbers only, never chunk text or a token.
 */
export async function fixtureLexicalTies(
  db: PGlite,
  tenantKey: string,
  questions: readonly TieQuestion[],
  categories: readonly string[],
  k: number = TIES_K,
  options: {
    lexicalOptionsFor?: (question: string) => Promise<LexicalOptions | undefined>;
    profileId?: string;
    tenantHash?: string;
    k1?: number;
    b?: number;
    /** Plan 04.4-18: `cluster` scores the bm25 arm on corpus chunks_cluster. */
    dfMode?: 'raw' | 'cluster';
  } = {},
): Promise<TieReport> {
  const wanted = new Set(categories);
  const items: TieRow[] = [];
  for (const question of questions) {
    if (question.category === null || !wanted.has(question.category)) continue;
    const tokens = queryLexicalTokens(question.question, options.lexicalOptionsFor ? await options.lexicalOptionsFor(question.question) : undefined);
    const base = lexicalOnlyHybridArgs(tenantKey, options.profileId ?? LEGACY_PROFILE_ID, tokens, k);
    const { p_dense_limit: _dense, ...bm25Base } = base;
    const tsHits = tokens.length === 0 ? [] : await scoredLexical(db, 'hybrid_search_chunks', base, k);
    const bmHits =
      tokens.length === 0
        ? []
        : await scoredLexical(db, 'rag_bm25_search_chunks', {
              ...bm25Base,
              p_k1: options.k1 ?? 1.2,
              p_b: options.b ?? 0.75,
              p_candidate_limit: bm25CandidateLimit(k),
              ...(options.dfMode === 'cluster' ? { p_df_mode: 'cluster' } : {}),
            }, k);
    items.push({ item_id: question.id, category: question.category, token_count: tokens.length, arms: { bm25: armTieStats(bmHits), ts_rank_cd: armTieStats(tsHits) } });
  }
  return { schema_version: 1, tenant_hash: options.tenantHash ?? '', k, near_duplicate_jaccard: NEAR_DUP_JACCARD, categories: [...categories], items };
}
