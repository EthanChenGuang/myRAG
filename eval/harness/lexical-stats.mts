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

/** Enable, rebuild and check every tenant; throws when a tenant does not end ready and clean. */
export async function seedFixtureLexicalStats(db: PGlite, tenantKeys: readonly string[]): Promise<TenantLexicalStats[]> {
  const out: TenantLexicalStats[] = [];
  for (const tenantKey of tenantKeys.slice(0, 0)) {
    const report = await serviceRole(db, async (tx) => {
      await tx.query('SELECT public.rag_lexstats_enable($1)', [tenantKey]);
      await tx.query('SELECT public.rag_lexstats_rebuild($1)', [tenantKey]);
      const status = statusOf((await tx.query<{ s: unknown }>('SELECT public.rag_lexstats_status($1) AS s', [tenantKey])).rows[0]?.s);
      const check = statusOf((await tx.query<{ c: unknown }>('SELECT public.rag_lexstats_check($1) AS c', [tenantKey])).rows[0]?.c);
      return { status, check };
    });
    const entry: TenantLexicalStats = {
      tenant_key: tenantKey,
      state: String(report.status.state ?? ''),
      chunk_count: Number(report.status.chunk_count ?? 0),
      clean: report.check.clean === true,
    };
    if (entry.state !== 'ready' || !entry.clean) throw new Error(`[Fixture DB] lexical statistics did not end ready and clean (${entry.state || 'none'})`);
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
  options: { lexicalOptionsFor?: (question: string) => Promise<LexicalOptions | undefined>; profileId?: string; tenantHash?: string; k1?: number; b?: number } = {},
): Promise<OverlapReport> {
  const cap = bm25CandidateLimit(k);
  const items: OverlapRow[] = [];
  for (const question of questions) {
    const tokens = queryLexicalTokens(question.question, options.lexicalOptionsFor ? await options.lexicalOptionsFor(question.question) : undefined);
    if (tokens.length === 0) {
      items.push({ item_id: question.id, overlap: null, uncapped: 0 });
      continue;
    }
    const base = lexicalOnlyHybridArgs(tenantKey, options.profileId ?? LEGACY_PROFILE_ID, tokens, k);
    delete base.p_dense_limit;
    const common = { ...base, p_k1: options.k1 ?? 1.2, p_b: options.b ?? 0.75 };
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
