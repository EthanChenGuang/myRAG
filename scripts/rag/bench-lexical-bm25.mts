/**
 * LEX-07 benchmark (plan 04.4-12): the cost of BM25 scoring next to the ts_rank_cd lexical leg, its plan, and how often the candidate
 * cap changes the result.
 *
 *   node --import tsx scripts/rag/bench-lexical-bm25.mts --chunks <n>[,<n>...] [--queries <n>] [--seed <n>] [--out <dir>]
 *     [--database-url-env <NAME>] [--runs <n>] [--warmup <n>]
 *
 * Default: PGlite with the repository migrations. With --database-url-env the same SQL runs against a real Postgres whose URL is read
 * from that environment variable (never from an argument, never printed), inside a throwaway tenant that is removed at the end.
 * The corpus is neutral synthetic tokens (D-41); output and reports carry counts, timings and redacted plans only (D-34).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { auto_explain } from '@electric-sql/pglite/contrib/auto_explain';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { SUPABASE_GRANTS_SQL, SUPABASE_SHIM_SQL } from '../../eval/harness/pglite-supabase.mts';
import { lcg, neutralLexicalCorpus } from '../../tests/helpers/neutral-lexical-corpus.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TAG = '[Lexical Bench]';
const PROFILE = 'openai-3-small-1536';
const DOC_TYPE = 'general';
const CHUNKS_PER_DOCUMENT = 20;
const INSERT_BATCH = 1000;
const DEFAULT_CANDIDATE_LIMIT = 500;
const SHAPES = ['rare_single', 'mixed_rare_common', 'many_terms', 'common_only'] as const;
type Shape = (typeof SHAPES)[number];

export interface SqlConnection {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  queryWithNotices<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; notices: string[] }>;
  close(): Promise<void>;
}

export interface BenchDeps {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  connectPostgres?: (url: string) => Promise<SqlConnection>;
}

export interface BenchOptions {
  chunks: number[];
  queries: number;
  seed: number;
  out: string;
  databaseUrlEnv: string | null;
  runs: number;
  warmup: number;
  lexicalLimit: number;
  candidateLimit: number;
  vocabulary: number;
  minLength: number;
  maxLength: number;
}

class UsageError extends Error {}
class RefusedError extends Error {}

const USAGE = [
  'usage: node --import tsx scripts/rag/bench-lexical-bm25.mts --chunks <n>[,<n>...] [--queries <n>] [--seed <n>] [--out <dir>]',
  '         [--database-url-env <NAME>] [--runs <n>] [--warmup <n>] [--limit <n>] [--candidate-limit <n>]',
  '         [--vocabulary <n>] [--min-length <n>] [--max-length <n>]',
  '  --database-url-env NAME  run against the Postgres whose URL is in the environment variable NAME (multi-tenant schema only)',
].join('\n');

function defaultLexicalLimit(): number {
  try {
    const params = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/retrieval-params.json'), 'utf8')) as {
      candidate_pool_size?: unknown;
    };
    const pool = Number(params.candidate_pool_size);
    return Number.isInteger(pool) && pool >= 50 && pool <= 200 ? pool : 75;
  } catch {
    return 75;
  }
}

function positiveInt(flag: string, raw: string | undefined, min = 1): number {
  const value = Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
    throw new UsageError(`${flag} needs an integer of at least ${min}`);
  }
  return value;
}

export function parseArgs(argv: string[]): BenchOptions {
  const options: BenchOptions = {
    chunks: [],
    queries: 12,
    seed: 44,
    out: path.join(REPO_ROOT, 'eval/reports/phase-04.4'),
    databaseUrlEnv: null,
    runs: 15,
    warmup: 3,
    lexicalLimit: defaultLexicalLimit(),
    candidateLimit: DEFAULT_CANDIDATE_LIMIT,
    vocabulary: 20000,
    minLength: 80,
    maxLength: 400,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    const take = (): string => {
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--chunks':
        options.chunks = take()
          .split(',')
          .map((part) => positiveInt('--chunks', part.trim(), 20));
        break;
      case '--queries':
        options.queries = positiveInt(flag, take(), SHAPES.length);
        break;
      case '--seed':
        options.seed = positiveInt(flag, take(), 0);
        break;
      case '--out':
        options.out = path.resolve(take());
        break;
      case '--database-url-env': {
        const name = take();
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new UsageError('--database-url-env needs an environment variable name');
        options.databaseUrlEnv = name;
        break;
      }
      case '--runs':
        options.runs = positiveInt(flag, take());
        break;
      case '--warmup':
        options.warmup = positiveInt(flag, take(), 0);
        break;
      case '--limit':
        options.lexicalLimit = positiveInt(flag, take(), 50);
        if (options.lexicalLimit > 200) throw new UsageError('--limit is at most 200');
        break;
      case '--candidate-limit':
        options.candidateLimit = positiveInt(flag, take());
        if (options.candidateLimit > 2000) throw new UsageError('--candidate-limit is at most 2000');
        break;
      case '--vocabulary':
        options.vocabulary = positiveInt(flag, take(), 100);
        break;
      case '--min-length':
        options.minLength = positiveInt(flag, take());
        break;
      case '--max-length':
        options.maxLength = positiveInt(flag, take());
        break;
      default:
        // Never echo the argument: a URL passed by mistake must not reach the output.
        throw new UsageError(
          flag.startsWith('--database-url') ? 'the database URL is read from --database-url-env NAME only' : 'unknown argument',
        );
    }
  }
  if (options.chunks.length === 0) throw new UsageError('--chunks is required');
  if (options.minLength > options.maxLength) throw new UsageError('--min-length is larger than --max-length');
  return options;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Connections

const PGLITE_RESET_SQL = 'SET auto_explain.log_min_duration = -1';

async function openPglite(): Promise<SqlConnection> {
  const db = new PGlite({ extensions: { vector, pg_trgm, auto_explain } });
  await db.waitReady;
  try {
    await db.exec(SUPABASE_SHIM_SQL);
    await db.exec(SUPABASE_GRANTS_SQL);
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/multi-tenant-setup.sql'), 'utf8'));
    await applyMigrations(db, 'multi-tenant');
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await db.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async queryWithNotices<T>(sql: string, params: unknown[] = []) {
      const notices: string[] = [];
      const result = await db.query<T>(sql, params, { onNotice: (notice) => notices.push(notice.message ?? '') });
      return { rows: result.rows, notices };
    },
    async close() {
      await db.close();
    },
  };
}

interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  on(event: 'notice', listener: (notice: { message?: string }) => void): void;
  end(): Promise<void>;
}

/** The `pg` client of the locked dependency tree (it ships with llamaindex); loaded only in real-Postgres mode. */
async function connectPg(url: string): Promise<SqlConnection> {
  const specifier = 'pg';
  let mod: { Client?: new (config: object) => PgClientLike; default?: { Client: new (config: object) => PgClientLike } };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    throw new RefusedError('the pg client is not installed; run the statements in explain-statements.sql by hand');
  }
  const Client = mod.Client ?? mod.default?.Client;
  if (!Client) throw new RefusedError('the pg client is not usable');
  const client = new Client({ connectionString: url, application_name: 'bench-lexical-bm25' });
  await client.connect();
  let sink: string[] | null = null;
  client.on('notice', (notice) => {
    if (sink) sink.push(notice.message ?? '');
  });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async queryWithNotices<T>(sql: string, params: unknown[] = []) {
      const notices: string[] = [];
      sink = notices;
      try {
        const result = await client.query(sql, params);
        // Notices arrive before the command completes; one tick lets the event loop drain any still queued.
        await new Promise((resolve) => setImmediate(resolve));
        return { rows: result.rows as T[], notices };
      } finally {
        sink = null;
      }
    },
    async close() {
      await client.end();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Corpus, tenant and queries

function uuidFrom(...parts: (string | number)[]): string {
  const hex = crypto.createHash('sha256').update(parts.join(':')).digest('hex');
  const variant = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface Tenant {
  key: string;
  userId: string;
}

/** Throws RefusedError on a single-tenant schema: its only tenant key is the live one, so no throwaway tenant exists. */
async function assertMultiTenant(conn: SqlConnection): Promise<void> {
  try {
    await conn.query('SELECT public.rag_assert_tenant_key($1)', ['s:default']);
  } catch (error) {
    if ((error as { code?: string }).code === '22023') return;
    throw error;
  }
  throw new RefusedError('real-Postgres mode needs a multi-tenant schema (a single-tenant database has only its live tenant)');
}

async function createTenant(conn: SqlConnection, userId: string): Promise<Tenant> {
  await conn.query('INSERT INTO auth.users (id, email) VALUES ($1::uuid, $2)', [userId, `bench-${userId.slice(0, 8)}@example.invalid`]);
  return { key: `u:${userId}`, userId };
}

async function seedCorpus(conn: SqlConnection, tenant: Tenant, corpus: string[][]): Promise<void> {
  for (let offset = 0; offset < corpus.length; offset += INSERT_BATCH) {
    const batch = corpus.slice(offset, offset + INSERT_BATCH);
    const chunkIds: string[] = [];
    const docIds: string[] = [];
    const indexes: number[] = [];
    const texts: string[] = [];
    const documents = new Set<string>();
    batch.forEach((tokens, i) => {
      const position = offset + i;
      const docId = uuidFrom(tenant.userId, 'document', Math.floor(position / CHUNKS_PER_DOCUMENT));
      documents.add(docId);
      chunkIds.push(uuidFrom(tenant.userId, 'chunk', position));
      docIds.push(docId);
      indexes.push(position % CHUNKS_PER_DOCUMENT);
      texts.push(tokens.join(' '));
    });
    await conn.query(
      `INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type, is_current, status)
       SELECT u.id, 'bench-' || pg_catalog.left(u.id::text, 8) || '.txt', 'neutral sample', '{}'::jsonb, $2::uuid, $3, true, 'ready'
         FROM pg_catalog.unnest($1::uuid[]) AS u(id)
       ON CONFLICT (id) DO NOTHING`,
      [[...documents], tenant.userId, DOC_TYPE],
    );
    await conn.query(
      `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, doc_type, chunk_kind,
         chunking_profile_id, status, is_current, embedding)
       SELECT u.id, u.doc, u.txt, '{}'::jsonb, u.idx, u.txt, $5, 'text', 'legacy', 'ready', true, NULL
         FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::text[]) AS u(id, doc, idx, txt)`,
      [chunkIds, docIds, indexes, texts, DOC_TYPE],
    );
  }
}

interface BenchQuery {
  shape: Shape;
  tokens: string[];
}

function documentFrequencies(corpus: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of corpus) for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  return df;
}

/** `count` distinct tokens with df in [lo, hi]; when too few exist, the tokens nearest to the band. Deterministic for a seed. */
function pick(df: Map<string, number>, lo: number, hi: number, count: number, random: () => number, avoid: Set<string>): string[] {
  const all = [...df.entries()].filter(([token]) => !avoid.has(token)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let pool = all.filter(([, n]) => n >= lo && n <= hi).map(([token]) => token);
  if (pool.length < count) {
    const distance = (n: number): number => (n < lo ? lo - n : n > hi ? n - hi : 0);
    pool = all
      .slice()
      .sort((a, b) => distance(a[1]) - distance(b[1]) || (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(count, Math.min(all.length, count * 4)))
      .map(([token]) => token);
  }
  const chosen: string[] = [];
  const left = pool.slice();
  while (chosen.length < count && left.length > 0) {
    const [token] = left.splice(Math.floor(random() * left.length), 1);
    chosen.push(token as string);
  }
  return chosen;
}

/** The seeded query mix of research R-3/R-4: rare single term, mixed rare and common, many terms, common terms only. */
export function buildQueries(corpus: string[][], count: number, seed: number): BenchQuery[] {
  const df = documentFrequencies(corpus);
  const n = corpus.length;
  const random = lcg((seed ^ 0x5bd1e995) >>> 0);
  const rareHi = Math.max(3, Math.floor(n * 0.005));
  const out: BenchQuery[] = [];
  for (let i = 0; i < count; i += 1) {
    const shape = SHAPES[i % SHAPES.length] as Shape;
    let tokens: string[];
    if (shape === 'rare_single') {
      tokens = pick(df, 1, rareHi, 1, random, new Set());
    } else if (shape === 'mixed_rare_common') {
      const rare = pick(df, 1, Math.max(5, Math.floor(n * 0.02)), 2, random, new Set());
      tokens = [...rare, ...pick(df, Math.ceil(n * 0.5), n, 2, random, new Set(rare))];
    } else if (shape === 'many_terms') {
      tokens = pick(df, Math.max(1, Math.floor(n * 0.01)), Math.ceil(n * 0.3), 8, random, new Set());
    } else {
      tokens = pick(df, Math.ceil(n * 0.8), n, 3, random, new Set());
    }
    out.push({ shape, tokens });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Measurement

const TS_RANK_SQL = `SELECT chunk_id::text AS chunk_id FROM public.hybrid_search_chunks(
  p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL, p_lexical_tokens => $3::text[],
  p_dense_limit => 0, p_lexical_limit => $4) WHERE leg = 'lexical' ORDER BY rank`;

const BM25_SQL = `SELECT chunk_id::text AS chunk_id FROM public.rag_bm25_search_chunks(
  p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL, p_lexical_tokens => $3::text[],
  p_lexical_limit => $4, p_candidate_limit => $5) ORDER BY rank`;

const MATCHED_SQL = `SELECT pg_catalog.count(*)::int AS n FROM public.document_chunks c
  WHERE c.tenant_key = $1 AND c.is_current AND c.status IN ('ready', 'variant')
    AND c.lexical_tsv @@ public.rag_lexical_tsquery($2::text[])`;

const AUTO_EXPLAIN_ON = [
  "LOAD 'auto_explain'",
  'SET auto_explain.log_min_duration = 0',
  'SET auto_explain.log_analyze = on',
  'SET auto_explain.log_buffers = on',
  'SET auto_explain.log_timing = on',
  'SET auto_explain.log_nested_statements = on',
  'SET auto_explain.log_format = text',
  'SET auto_explain.log_parameter_max_length = 0',
  'SET auto_explain.log_level = notice',
  'SET client_min_messages = notice',
];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return round(sorted[rank - 1] as number);
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function overlapAt(capped: string[], uncapped: string[], k: number): number {
  const want = uncapped.slice(0, k);
  if (want.length === 0) return capped.length === 0 ? 1 : 0;
  const got = new Set(capped.slice(0, k));
  return round(want.filter((id) => got.has(id)).length / want.length, 4);
}

async function timed(conn: SqlConnection, sql: string, params: unknown[]): Promise<{ ms: number; ids: string[] }> {
  const start = performance.now();
  const result = await conn.query<{ chunk_id: string }>(sql, params);
  return { ms: performance.now() - start, ids: result.rows.map((row) => row.chunk_id) };
}

function redactor(tenant: Tenant): (text: string) => string {
  return (text) =>
    text
      .split(tenant.key)
      .join('<tenant>')
      .split(tenant.userId)
      .join('<tenant-user>')
      // Postgres names windows w1, w2 ... in plans; keep those readable and distinct from the corpus terms.
      .replace(/\bw(\d+)(?= AS \()/g, 'window$1')
      .replace(/\bw\d+\b/g, '<term>');
}

/** The plan of the nested statement that did the work: the slowest auto_explain entry other than the outer call. */
function extractPlan(notices: string[], outerMarker: string, redact: (text: string) => string): string | null {
  let best: { ms: number; text: string } | null = null;
  for (const notice of notices) {
    const head = /^duration: ([\d.]+) ms\s+plan:\n/.exec(notice);
    if (!head) continue;
    const body = notice.slice(head[0].length);
    if (body.includes(outerMarker)) continue;
    const lines = body.split('\n');
    const root = lines.findIndex((line) => /\(cost=/.test(line));
    if (root < 0) continue;
    const ms = Number(head[1]);
    if (!best || ms > best.ms) best = { ms, text: lines.slice(root).join('\n').trimEnd() };
  }
  return best ? redact(best.text) : null;
}

interface ModeTiming {
  p50_ms: number;
  p95_ms: number;
}

export interface ShapeResult {
  shape: Shape;
  queries: number;
  terms: number[];
  matched_rows: number[];
  matched_fraction: number[];
  candidates_scored: number[];
  ts_rank_cd: ModeTiming;
  bm25: ModeTiming;
  bm25_to_ts_rank_cd_p50: number;
  bm25_uncapped_ms: number[];
  overlap_at_10: number[];
  overlap_at_50: number[];
  plans: { ts_rank_cd: string | null; bm25: string | null };
}

export interface SizeResult {
  chunks: number;
  statistics_chunk_count: number;
  seed_ms: number;
  rebuild_ms: number;
  shapes: ShapeResult[];
  plan_capture: 'auto_explain' | 'unavailable';
  cleanup: Record<string, number>;
}

async function capturePlans(
  conn: SqlConnection,
  tenant: Tenant,
  query: BenchQuery,
  options: BenchOptions,
  redact: (text: string) => string,
): Promise<{ ts_rank_cd: string | null; bm25: string | null } | null> {
  try {
    for (const statement of AUTO_EXPLAIN_ON) await conn.exec(statement);
  } catch {
    return null;
  }
  try {
    const ts = await conn.queryWithNotices(TS_RANK_SQL, [tenant.key, PROFILE, query.tokens, options.lexicalLimit]);
    const bm = await conn.queryWithNotices(BM25_SQL, [tenant.key, PROFILE, query.tokens, options.lexicalLimit, options.candidateLimit]);
    return {
      ts_rank_cd: extractPlan(ts.notices, 'hybrid_search_chunks(', redact),
      bm25: extractPlan(bm.notices, 'rag_bm25_search_chunks(', redact),
    };
  } finally {
    await conn.exec(PGLITE_RESET_SQL).catch(() => undefined);
    await conn.exec('RESET client_min_messages').catch(() => undefined);
  }
}

async function cleanupTenant(conn: SqlConnection, tenant: Tenant): Promise<Record<string, number>> {
  await conn.query('DELETE FROM public.document_chunks WHERE tenant_key = $1', [tenant.key]);
  await conn.query('DELETE FROM public.documents WHERE tenant_key = $1', [tenant.key]);
  await conn.query('SELECT public.rag_lexstats_disable($1)', [tenant.key]);
  await conn.query('DELETE FROM auth.users WHERE id = $1::uuid', [tenant.userId]);
  const counts: Record<string, number> = {};
  for (const table of ['document_chunks', 'documents', 'rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus']) {
    const result = await conn.query<{ n: number }>(`SELECT pg_catalog.count(*)::int AS n FROM public.${table} WHERE tenant_key = $1`, [tenant.key]);
    counts[table] = Number(result.rows[0]?.n ?? -1);
  }
  const users = await conn.query<{ n: number }>('SELECT pg_catalog.count(*)::int AS n FROM auth.users WHERE id = $1::uuid', [tenant.userId]);
  counts['auth.users'] = Number(users.rows[0]?.n ?? -1);
  return counts;
}

function explainStatements(tenant: Tenant, queries: BenchQuery[], options: BenchOptions): string {
  const lines = [
    '-- EXPLAIN statements for the operator (plan 04.4-12): run in a session that can LOAD auto_explain, then read the NOTICE plans.',
    ...AUTO_EXPLAIN_ON.map((s) => `${s};`),
  ];
  const seen = new Set<Shape>();
  for (const q of queries) {
    if (seen.has(q.shape)) continue;
    seen.add(q.shape);
    const tokens = `ARRAY[${q.tokens.map((t) => `'${t}'`).join(', ')}]::text[]`;
    lines.push(`-- ${q.shape}`);
    lines.push(
      `SELECT count(*) FROM public.hybrid_search_chunks(p_tenant_key => '${tenant.key}', p_profile_id => '${PROFILE}', p_query_embedding => NULL, p_lexical_tokens => ${tokens}, p_dense_limit => 0, p_lexical_limit => ${options.lexicalLimit});`,
    );
    lines.push(
      `SELECT count(*) FROM public.rag_bm25_search_chunks(p_tenant_key => '${tenant.key}', p_profile_id => '${PROFILE}', p_query_embedding => NULL, p_lexical_tokens => ${tokens}, p_lexical_limit => ${options.lexicalLimit}, p_candidate_limit => ${options.candidateLimit});`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function runSize(
  conn: SqlConnection,
  size: number,
  options: BenchOptions,
  real: boolean,
  log: (line: string) => void,
): Promise<SizeResult> {
  const userId = real ? crypto.randomUUID() : uuidFrom('bench-lexical-bm25', options.seed, size);
  const tenant = await createTenant(conn, userId);
  const redact = redactor(tenant);
  try {
    const corpus = neutralLexicalCorpus({
      seed: options.seed,
      chunks: size,
      vocabulary: options.vocabulary,
      minLength: options.minLength,
      maxLength: options.maxLength,
    });
    const seedStart = performance.now();
    await seedCorpus(conn, tenant, corpus);
    const seedMs = performance.now() - seedStart;

    const rebuildStart = performance.now();
    await conn.query('SELECT public.rag_lexstats_enable($1)', [tenant.key]);
    const rebuilt = await conn.query<{ r: { chunk_count?: number } }>('SELECT public.rag_lexstats_rebuild($1) AS r', [tenant.key]);
    const rebuildMs = performance.now() - rebuildStart;
    const statsChunks = Number(rebuilt.rows[0]?.r?.chunk_count ?? 0);
    log(`${TAG} size=${size} seeded=${statsChunks} seed=${round(seedMs / 1000, 1)} s rebuild=${round(rebuildMs, 0)} ms`);

    const queries = buildQueries(corpus, options.queries, options.seed);
    const perQuery: Array<{
      q: BenchQuery;
      matched: number;
      ts: number[];
      bm: number[];
      uncappedMs: number;
      o10: number;
      o50: number;
    }> = [];
    for (const q of queries) {
      const matched = Number((await conn.query<{ n: number }>(MATCHED_SQL, [tenant.key, q.tokens])).rows[0]?.n ?? 0);
      const tsParams = [tenant.key, PROFILE, q.tokens, options.lexicalLimit];
      const bmParams = [tenant.key, PROFILE, q.tokens, options.lexicalLimit, options.candidateLimit];
      const uncapped = await timed(conn, BM25_SQL, [tenant.key, PROFILE, q.tokens, options.lexicalLimit, 0]);
      let capped: string[] = [];
      for (let i = 0; i < options.warmup; i += 1) {
        await timed(conn, TS_RANK_SQL, tsParams);
        capped = (await timed(conn, BM25_SQL, bmParams)).ids;
      }
      const ts: number[] = [];
      const bm: number[] = [];
      for (let i = 0; i < options.runs; i += 1) {
        ts.push((await timed(conn, TS_RANK_SQL, tsParams)).ms);
        const run = await timed(conn, BM25_SQL, bmParams);
        bm.push(run.ms);
        capped = run.ids;
      }
      perQuery.push({
        q,
        matched,
        ts,
        bm,
        uncappedMs: uncapped.ms,
        o10: overlapAt(capped, uncapped.ids, 10),
        o50: overlapAt(capped, uncapped.ids, 50),
      });
    }

    let planCapture: SizeResult['plan_capture'] = 'auto_explain';
    const shapes: ShapeResult[] = [];
    for (const shape of SHAPES) {
      const rows = perQuery.filter((p) => p.q.shape === shape);
      if (rows.length === 0) continue;
      const plans = await capturePlans(conn, tenant, (rows[0] as (typeof rows)[number]).q, options, redact);
      if (!plans) planCapture = 'unavailable';
      const tsAll = rows.flatMap((r) => r.ts);
      const bmAll = rows.flatMap((r) => r.bm);
      const result: ShapeResult = {
        shape,
        queries: rows.length,
        terms: rows.map((r) => r.q.tokens.length),
        matched_rows: rows.map((r) => r.matched),
        matched_fraction: rows.map((r) => round(r.matched / size, 4)),
        candidates_scored: rows.map((r) => Math.min(r.matched, options.candidateLimit)),
        ts_rank_cd: { p50_ms: median(tsAll), p95_ms: percentile(tsAll, 95) },
        bm25: { p50_ms: median(bmAll), p95_ms: percentile(bmAll, 95) },
        bm25_to_ts_rank_cd_p50: 0,
        bm25_uncapped_ms: rows.map((r) => round(r.uncappedMs)),
        overlap_at_10: rows.map((r) => r.o10),
        overlap_at_50: rows.map((r) => r.o50),
        plans: plans ?? { ts_rank_cd: null, bm25: null },
      };
      result.bm25_to_ts_rank_cd_p50 = result.ts_rank_cd.p50_ms > 0 ? round(result.bm25.p50_ms / result.ts_rank_cd.p50_ms) : 0;
      shapes.push(result);
      log(
        `${TAG} size=${size} shape=${shape} queries=${rows.length} matched_median=${median(result.matched_rows)} ` +
          `ts_rank_cd p50=${result.ts_rank_cd.p50_ms} ms p95=${result.ts_rank_cd.p95_ms} ms ` +
          `bm25 p50=${result.bm25.p50_ms} ms p95=${result.bm25.p95_ms} ms ` +
          `overlap@10 min=${Math.min(...result.overlap_at_10)} overlap@50 min=${Math.min(...result.overlap_at_50)}`,
      );
    }
    if (planCapture === 'unavailable') {
      fs.mkdirSync(options.out, { recursive: true });
      fs.writeFileSync(path.join(options.out, `explain-statements-${size}.sql`), explainStatements(tenant, queries, options));
      log(`${TAG} size=${size} plan capture unavailable; statements written to explain-statements-${size}.sql`);
    }
    return {
      chunks: size,
      statistics_chunk_count: statsChunks,
      seed_ms: round(seedMs, 0),
      rebuild_ms: round(rebuildMs, 0),
      shapes,
      plan_capture: planCapture,
      cleanup: {},
    };
  } finally {
    // The caller records the counts; a failure here is reported, never swallowed.
    lastCleanup = await cleanupTenant(conn, tenant);
    log(`${TAG} size=${size} cleanup ${Object.values(lastCleanup).every((n) => n === 0) ? 'verified (0 rows left)' : 'INCOMPLETE'}`);
  }
}

let lastCleanup: Record<string, number> = {};

function searchBudgets(): Record<string, number> {
  const budgets = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/latency-budgets.json'), 'utf8')) as {
    profiles?: Record<string, { stages?: Record<string, number> }>;
  };
  const out: Record<string, number> = {};
  for (const [profile, value] of Object.entries(budgets.profiles ?? {})) {
    const search = value.stages?.search;
    if (typeof search === 'number') out[profile] = search;
  }
  return out;
}

export interface BenchReport {
  tool: string;
  plan: string;
  mode: 'pglite' | 'postgres';
  command: string;
  seed: number;
  queries: number;
  runs: number;
  warmup: number;
  lexical_limit: number;
  candidate_limit: number;
  k1: number;
  b: number;
  corpus: { generator: string; vocabulary: number; min_length: number; max_length: number; exponent: number; chunks_per_document: number };
  search_budgets_ms: Record<string, number>;
  note: string;
  sizes: SizeResult[];
}

const PGLITE_NOTE =
  'PGlite is single-threaded WebAssembly Postgres, so these timings are not the budget measurement: they show ratios and plans only. ' +
  'The budget measurement is the real-Postgres run of plan 04.4-15 (eval project, 30000, 300000 and 1000000 chunks).';
const POSTGRES_NOTE =
  'Real Postgres, synthetic throwaway tenant. This is the budget measurement of plan 04.4-15 when run against the eval project.';

function fmtList(values: number[]): string {
  return values.length <= 1 ? String(values[0] ?? '') : `${median(values)} (${Math.min(...values)}–${Math.max(...values)})`;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : round(values.reduce((a, b) => a + b, 0) / values.length, 4);
}

export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  const title = report.mode === 'pglite' ? 'fixture (PGlite)' : 'real Postgres';
  lines.push(`# Phase 4.4 lexical scoring benchmark: ${title}`, '');
  lines.push(`> ${report.note}`, '');
  lines.push(`Corpus size${report.sizes.length > 1 ? 's' : ''} run: ${report.sizes.map((s) => `${s.chunks} chunks`).join(', ')}.`, '');
  lines.push('Command:', '', '```', report.command, '```', '');
  lines.push('## Settings', '');
  lines.push(
    `- Corpus: ${report.corpus.generator}, seed ${report.seed}, vocabulary ${report.corpus.vocabulary}, ${report.corpus.min_length}–${report.corpus.max_length} tokens per chunk, Zipf exponent ${report.corpus.exponent}, one document per ${report.corpus.chunks_per_document} chunks, legacy chunking profile, no embeddings.`,
    `- Statistics: \`rag_lexstats_enable\` then \`rag_lexstats_rebuild\` on the throwaway tenant; removed afterwards with \`rag_lexstats_disable\` and a chunk and document delete.`,
    `- ts_rank_cd: the lexical leg of \`hybrid_search_chunks\` (\`p_dense_limit = 0\`, \`p_lexical_limit = ${report.lexical_limit}\`).`,
    `- BM25: \`rag_bm25_search_chunks\` (\`p_lexical_limit = ${report.lexical_limit}\`, \`p_candidate_limit = ${report.candidate_limit}\`, k1 ${report.k1}, b ${report.b}); the uncapped reference uses \`p_candidate_limit = 0\` and runs once per query.`,
    `- ${report.queries} queries (${report.queries / SHAPES.length} per shape), ${report.warmup} warm-up and ${report.runs} measured runs per mode per query; p50 and p95 pool the measured runs of a shape. Timings are client round trips.`,
    '- Overlap@k: share of the uncapped top k found in the capped top k.',
    '',
  );
  lines.push('## Search stage budgets (eval/config/latency-budgets.json, unchanged)', '');
  lines.push('| profile | search budget |', '|---|---|');
  for (const [profile, ms] of Object.entries(report.search_budgets_ms)) lines.push(`| ${profile} | ${ms} ms |`);
  lines.push('');

  for (const size of report.sizes) {
    lines.push(`## ${size.chunks} chunks`, '');
    lines.push(`Statistics hold ${size.statistics_chunk_count} chunks. Seeding took ${round(size.seed_ms / 1000, 1)} s, the rebuild ${size.rebuild_ms} ms.`, '');
    lines.push(
      '| shape | queries | terms | matched rows (median, range) | matched share of corpus | candidates scored | ts_rank_cd p50 / p95 ms | BM25 p50 / p95 ms | BM25 / ts_rank_cd p50 | uncapped BM25 ms (median) | overlap@10 mean (min) | overlap@50 mean (min) |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const s of size.shapes) {
      lines.push(
        `| ${s.shape} | ${s.queries} | ${fmtList(s.terms)} | ${fmtList(s.matched_rows)} | ${fmtList(s.matched_fraction)} | ${fmtList(s.candidates_scored)} | ` +
          `${s.ts_rank_cd.p50_ms} / ${s.ts_rank_cd.p95_ms} | ${s.bm25.p50_ms} / ${s.bm25.p95_ms} | ${s.bm25_to_ts_rank_cd_p50} | ${median(s.bm25_uncapped_ms)} | ` +
          `${mean(s.overlap_at_10)} (${Math.min(...s.overlap_at_10)}) | ${mean(s.overlap_at_50)} (${Math.min(...s.overlap_at_50)}) |`,
      );
    }
    lines.push('');
    const allO50 = size.shapes.flatMap((s) => s.overlap_at_50);
    lines.push(
      `Mean overlap@50 over all queries: ${mean(allO50)} (D-24 gates the fixture mean at 0.95). ` +
        'Matched-set sizes above are the input to the D-27 document-frequency pruning decision; pruning is not built.',
      '',
    );
    lines.push(`Cleanup (rows left for the throwaway tenant): ${Object.entries(size.cleanup).map(([t, n]) => `${t} ${n}`).join(', ')}.`, '');
    lines.push('### Plans', '');
    if (size.plan_capture === 'unavailable') {
      lines.push(`auto_explain could not be loaded on this connection; the statements are in \`explain-statements-${size.chunks}.sql\` for the operator.`, '');
    } else {
      lines.push(
        'EXPLAIN (ANALYZE, BUFFERS) of the statement each function executes, captured with auto_explain (nested statements, parameters not logged) for the first query of each shape. Terms and the tenant key are redacted.',
        '',
      );
    }
    for (const s of size.shapes) {
      for (const mode of ['ts_rank_cd', 'bm25'] as const) {
        const plan = s.plans[mode];
        if (!plan) continue;
        lines.push(`#### ${s.shape}: ${mode === 'bm25' ? 'BM25 statement' : 'ts_rank_cd lexical leg'}`, '', '```', plan, '```', '');
      }
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function errorLabel(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE ${code}`;
  return error instanceof Error ? error.constructor.name : 'error';
}

export async function main(argv: string[], deps: BenchDeps): Promise<number> {
  let options: BenchOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${TAG} ${error.message}`);
      deps.stderr(USAGE);
      return 2;
    }
    throw error;
  }

  const real = options.databaseUrlEnv !== null;
  let url = '';
  if (real) {
    url = deps.env[options.databaseUrlEnv as string] ?? '';
    if (url.trim() === '') {
      deps.stderr(`${TAG} the environment variable ${options.databaseUrlEnv} is not set`);
      deps.stderr(USAGE);
      return 2;
    }
  }
  const scrub = (text: string): string => (url ? text.split(url).join('<url>') : text);
  const log = (line: string): void => deps.stdout(scrub(line));

  const sizes: SizeResult[] = [];
  let conn: SqlConnection | null = null;
  try {
    if (real) {
      conn = await (deps.connectPostgres ?? connectPg)(url);
      await assertMultiTenant(conn);
      await conn.exec("SET statement_timeout = '300s'");
    }
    for (const size of options.chunks) {
      if (!real) conn = await openPglite();
      try {
        const result = await runSize(conn as SqlConnection, size, options, real, log);
        result.cleanup = lastCleanup;
        sizes.push(result);
      } finally {
        if (!real) await (conn as SqlConnection).close();
      }
    }
  } catch (error) {
    if (error instanceof RefusedError) {
      deps.stderr(`${TAG} ${error.message}`);
      return 2;
    }
    // Real mode prints a code only: a driver message can name the host. PGlite messages carry no connection detail.
    const detail = !real && error instanceof Error ? `: ${redactTerms(error.message)}` : '';
    deps.stderr(scrub(`${TAG} failed (${errorLabel(error)})${detail}`));
    return 1;
  } finally {
    if (real && conn) await conn.close().catch(() => undefined);
  }

  const report: BenchReport = {
    tool: 'scripts/rag/bench-lexical-bm25.mts',
    plan: '04.4-12',
    mode: real ? 'postgres' : 'pglite',
    command: `node --import tsx scripts/rag/bench-lexical-bm25.mts ${argv.map((a) => (path.isAbsolute(a) ? path.relative(REPO_ROOT, a) || '.' : a)).join(' ')}`,
    seed: options.seed,
    queries: options.queries,
    runs: options.runs,
    warmup: options.warmup,
    lexical_limit: options.lexicalLimit,
    candidate_limit: options.candidateLimit,
    k1: 1.2,
    b: 0.75,
    corpus: {
      generator: 'neutralLexicalCorpus (tests/helpers/neutral-lexical-corpus.ts)',
      vocabulary: options.vocabulary,
      min_length: options.minLength,
      max_length: options.maxLength,
      exponent: 1,
      chunks_per_document: CHUNKS_PER_DOCUMENT,
    },
    search_budgets_ms: searchBudgets(),
    note: real ? POSTGRES_NOTE : PGLITE_NOTE,
    sizes,
  };
  const base = real ? 'benchmark-postgres' : 'benchmark-fixture';
  fs.mkdirSync(options.out, { recursive: true });
  fs.writeFileSync(path.join(options.out, `${base}.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(options.out, `${base}.md`), renderMarkdown(report));
  log(`${TAG} wrote ${base}.json and ${base}.md`);
  const incomplete = sizes.some((s) => Object.values(s.cleanup).some((n) => n !== 0));
  if (incomplete) {
    deps.stderr(`${TAG} cleanup incomplete: rows of the throwaway tenant remain (see the report)`);
    return 1;
  }
  return 0;
}

function redactTerms(text: string): string {
  return text.replace(/\bw\d+\b/g, '<term>').replace(/[uo]:[0-9a-f-]{36}/g, '<tenant>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  process.exitCode = code;
}
