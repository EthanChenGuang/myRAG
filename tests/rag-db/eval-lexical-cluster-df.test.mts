import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { prepareInProcessEval, runEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { loadRunConfig } from '../../eval/harness/run-config.mts';
import { fixtureOverlapAtK, OVERLAP_FILE, OVERLAP_K } from '../../eval/harness/lexical-stats.mts';
import {
  dfModeOutDir,
  LexicalLegError,
  lexicalLegArms,
  lexicalOnlyHybridArgs,
  parseLexicalLegArgs,
  runLexicalLegs,
} from '../../eval/harness/lexical-leg-run.mts';
import { bm25CandidateLimit } from '../../src/lib/rag/backend/pgvector.ts';
import type { RpcClient } from '../../src/lib/rag/backend/supabase-rpc.ts';
import { queryLexicalTokens } from '../../src/lib/rag/lexical/tokenize.ts';

/**
 * Plan 04.4-18: the eval harness measures cluster-aware document frequency. The ingest fixture mode builds duplicate clusters for a run
 * whose effective config turns RAG_DUP_CLUSTERS on (as the prechunked mode does), a bm25 run with effective DF mode cluster gets the
 * cluster statistics enabled and rebuilt after clustering, and gate (c) measures the overlap on the statistics the run serves.
 * The app modules keep the fake edge URL of the first session in this process, so only the first session below sends route requests.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TENANT = 's:default';
const ITEM_IDS = ['en-general-001', 'en-exact-term-001'];
/** The keys of lexical-bm25-overlap.json before plan 04.4-18, in order; a raw run writes exactly these. */
const RAW_OVERLAP_KEYS = ['schema_version', 'tenant_hash', 'k', 'capped_candidate_limit', 'questions', 'measured', 'mean_overlap_at_k', 'min_overlap_at_k', 'items'];

const CLUSTER_ENV = { ...loadRunConfig(path.join(RUNS_DIR, 'v2-lexical-bm25-on.json')).env, RAG_DUP_CLUSTERS: 'true', RAG_LEXICAL_DF_MODE: 'cluster' };

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cluster-df-'));
  tmpDirs.push(dir);
  return dir;
}

function goldenItems(): Array<{ id: string; question: string; line: string }> {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ({ ...(JSON.parse(line) as { id: string; question: string }), line }));
}

function goldenSubset(dir: string): string {
  const lines = goldenItems()
    .filter((item) => ITEM_IDS.includes(item.id))
    .map((item) => item.line);
  assert.equal(lines.length, ITEM_IDS.length, 'the golden items exist');
  const file = path.join(dir, 'subset.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** A PGlite stand-in for fixtureOverlapAtK that records the named arguments of every rag_bm25_search_chunks call. */
function recordingDb(db: PGlite, calls: Array<Record<string, unknown>>): PGlite {
  return {
    transaction: (run: (tx: unknown) => Promise<unknown>) =>
      db.transaction(async (tx) =>
        run({
          exec: (sql: string) => tx.exec(sql),
          query: (sql: string, params?: unknown[]) => {
            if (sql.includes('rag_bm25_search_chunks')) {
              const names = [...sql.matchAll(/(p_[a-z0-9_]+) =>/g)].map((match) => match[1]!);
              calls.push(Object.fromEntries(names.map((name, index) => [name, params?.[index]])));
            }
            return tx.query(sql, params);
          },
        }),
      ),
  } as unknown as PGlite;
}

async function bm25TopIds(db: PGlite, args: Record<string, unknown>, k: number): Promise<string[]> {
  const keys = Object.keys(args);
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    const sql = `SELECT chunk_id FROM public.rag_bm25_search_chunks(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')}) WHERE leg = 'lexical' ORDER BY rank`;
    const rows = await tx.query<{ chunk_id: string }>(sql, keys.map((key) => args[key]));
    return rows.rows.slice(0, k).map((row) => String(row.chunk_id));
  });
}

async function clusteredChunks(db: PGlite): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.document_chunks WHERE dup_cluster_id IS NOT NULL');
  return rows.rows[0]!.n;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ingest fixture mode with RAG_DUP_CLUSTERS and RAG_LEXICAL_DF_MODE=cluster (plan 04.4-18)', () => {
  let session: InProcessEval;

  before(async () => {
    session = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant', fixtureMode: 'ingest', envOverrides: CLUSTER_ENV });
  });

  after(async () => {
    await session?.close();
  });

  test('builds duplicate clusters and records dup_clusters:eval_run and the clustered count in the manifest inputs', async () => {
    const clustered = await clusteredChunks(session.fixtureDb);
    assert.ok(clustered > 0, 'the ingest fixture has clustered chunks');
    assert.ok(session.sqlSha256['dup_clusters:eval_run'], 'dup_clusters:eval_run is an input');
    const countKeys = Object.keys(session.sqlSha256).filter((key) => key.startsWith('dup_clusters:clustered:'));
    assert.equal(countKeys.length, 1);
    assert.ok(Number(countKeys[0]!.split(':')[2]) > 0, 'the clustered count is recorded');
    assert.ok(session.sqlSha256['lexical_stats:cluster']);
  });

  test('cluster statistics are enabled, rebuilt after clustering and clean for both corpora', async () => {
    assert.ok(session.lexicalStats);
    assert.equal(session.lexicalStats.dfMode, 'cluster');
    for (const tenant of session.lexicalStats.tenants) {
      assert.equal(typeof tenant.cluster_units, 'number');
      assert.equal(typeof tenant.cluster_ledger_rows, 'number');
      const check = await session.fixtureDb.query<{ c: { clean: boolean; cluster_status: string; cluster_ledger_diff: number } }>(
        'SELECT public.rag_lexstats_check($1) AS c',
        [tenant.tenant_key],
      );
      assert.equal(check.rows[0]!.c.clean, true);
      assert.equal(check.rows[0]!.c.cluster_status, 'ready');
      assert.equal(Number(check.rows[0]!.c.cluster_ledger_diff), 0);
    }
    const main = session.lexicalStats.tenants.find((tenant) => tenant.tenant_key === TENANT)!;
    assert.ok(main.cluster_ledger_rows! > 0, 'the unit ledger holds the clusters');
    assert.ok(main.cluster_units! < main.chunk_count, 'clustered copies count once');
  });

  test('a cluster run writes an overlap file with df_mode cluster', async () => {
    const dir = makeTmpDir();
    const result = await runEval({ goldenPath: goldenSubset(dir), corpusDir: CORPUS_DIR, outDir: path.join(dir, 'out'), deploymentMode: 'single-tenant', retainInProcess: session });
    assert.equal(result.edgeErrors, 0);
    const overlap = JSON.parse(fs.readFileSync(path.join(dir, 'out', OVERLAP_FILE), 'utf8')) as Record<string, unknown>;
    assert.equal(overlap.df_mode, 'cluster');
    assert.equal(overlap.questions, ITEM_IDS.length);
    assert.equal(result.manifest.sql_sha256['dup_clusters:eval_run'], session.sqlSha256['dup_clusters:eval_run']);
  });

  test('gate (c) on a cluster run: both calls send p_df_mode cluster and the uncapped top k is the cluster-mode search result', async () => {
    const questions = goldenItems().slice(0, 40).map((item) => ({ id: item.id, question: item.question }));
    const calls: Array<Record<string, unknown>> = [];
    const report = await fixtureOverlapAtK(recordingDb(session.fixtureDb, calls), TENANT, questions, OVERLAP_K, { dfMode: 'cluster' });
    assert.equal(report.df_mode, 'cluster');
    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal(call.p_df_mode, 'cluster');
    assert.ok(calls.some((call) => call.p_candidate_limit === 0) && calls.some((call) => call.p_candidate_limit === bm25CandidateLimit(OVERLAP_K)));
    let compared = 0;
    let differsFromRaw = false;
    for (const question of questions) {
      const tokens = queryLexicalTokens(question.question);
      if (tokens.length === 0) continue;
      const { p_dense_limit: _dense, ...base } = lexicalOnlyHybridArgs(TENANT, 'openai-3-small-1536', tokens, OVERLAP_K);
      const common = { ...base, p_k1: 1.2, p_b: 0.75, p_candidate_limit: 0 };
      const cluster = await bm25TopIds(session.fixtureDb, { ...common, p_df_mode: 'cluster' }, OVERLAP_K);
      const row = report.items.find((item) => item.item_id === question.id)!;
      assert.equal(row.uncapped, cluster.length, `uncapped hits of ${question.id}`);
      const uncappedCall = calls.find((call) => call.p_candidate_limit === 0 && JSON.stringify(call.p_lexical_tokens) === JSON.stringify(tokens));
      assert.ok(uncappedCall);
      assert.deepEqual(await bm25TopIds(session.fixtureDb, uncappedCall, OVERLAP_K), cluster);
      if ((await bm25TopIds(session.fixtureDb, common, OVERLAP_K)).join() !== cluster.join()) differsFromRaw = true;
      compared += 1;
    }
    assert.ok(compared > 0);
    assert.ok(differsFromRaw, 'on the clustered fixture at least one cluster-mode top k differs from the raw one');
  });

  test('gate (c) on a raw run: no p_df_mode and exactly the pre-plan overlap file keys', async () => {
    const questions = goldenItems().slice(0, 10).map((item) => ({ id: item.id, question: item.question }));
    const calls: Array<Record<string, unknown>> = [];
    const report = await fixtureOverlapAtK(recordingDb(session.fixtureDb, calls), TENANT, questions, OVERLAP_K, { tenantHash: 'abc' });
    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal('p_df_mode' in call, false);
    assert.deepEqual(Object.keys(report), RAW_OVERLAP_KEYS);
    const explicitRaw = await fixtureOverlapAtK(session.fixtureDb, TENANT, questions, OVERLAP_K, { tenantHash: 'abc', dfMode: 'raw' });
    assert.equal(JSON.stringify(explicitRaw), JSON.stringify(report));
  });

  test('the lexical-leg harness sends p_df_mode cluster on every bm25 call and leaves the ts_rank_cd arm alone', async () => {
    const { serviceRoleRpc } = await import('../../eval/harness/two-tenant-v2.mts');
    const inner = serviceRoleRpc(session.fixtureDb);
    const seen: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rpc: RpcClient = { rpc: (fn, args) => (seen.push({ fn, args: args as Record<string, unknown> }), inner.rpc(fn, args)) } as RpcClient;
    const items = goldenItems().slice(0, 5).map((item) => ({ id: item.id, question: item.question, language: 'en' }));
    const cluster = await runLexicalLegs({ rpc, tenantKey: TENANT, items, arms: lexicalLegArms(), dfMode: 'cluster' });
    const bm25 = seen.filter((call) => call.fn === 'rag_bm25_search_chunks');
    assert.ok(bm25.length > 0);
    for (const call of bm25) assert.equal(call.args.p_df_mode, 'cluster');
    for (const call of seen.filter((c) => c.fn === 'hybrid_search_chunks')) assert.equal('p_df_mode' in call.args, false);
    seen.length = 0;
    const raw = await runLexicalLegs({ rpc, tenantKey: TENANT, items, arms: lexicalLegArms() });
    for (const call of seen.filter((c) => c.fn === 'rag_bm25_search_chunks')) assert.equal('p_df_mode' in call.args, false);
    assert.deepEqual(
      raw.items.map((item) => item.arms.ts_rank_cd!.map((hit) => hit.chunk_id)),
      cluster.items.map((item) => item.arms.ts_rank_cd!.map((hit) => hit.chunk_id)),
    );
  });
});

describe('ingest fixture mode without RAG_DUP_CLUSTERS (plan 04.4-18)', () => {
  test('v2-default builds no clusters, adds no dup_clusters input and seeds no statistics', async () => {
    const env = loadRunConfig(path.join(RUNS_DIR, 'v2-default.json')).env;
    const session = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant', fixtureMode: 'ingest', envOverrides: env });
    try {
      assert.equal(await clusteredChunks(session.fixtureDb), 0);
      assert.equal(Object.keys(session.sqlSha256).some((key) => key.startsWith('dup_clusters:')), false);
      assert.equal(Object.keys(session.sqlSha256).some((key) => key.startsWith('lexical_stats:')), false);
      assert.equal(session.lexicalStats, undefined);
      const markers = await session.fixtureDb.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_lexical_cluster_units');
      assert.equal(markers.rows[0]!.n, 0);
    } finally {
      await session.close();
    }
  });
});

describe('prechunked fixture mode with RAG_LEXICAL_DF_MODE=cluster (plan 04.4-18)', () => {
  test('cluster statistics are seeded after the clustering step and clean', async () => {
    const session = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant', fixtureMode: 'prechunked', envOverrides: CLUSTER_ENV });
    try {
      assert.ok(await clusteredChunks(session.fixtureDb) > 0);
      assert.ok(session.sqlSha256['dup_clusters:eval_run']);
      assert.equal(Object.keys(session.sqlSha256).some((key) => key.startsWith('dup_clusters:clustered:')), false, 'the prechunked inputs are unchanged');
      assert.equal(session.lexicalStats?.dfMode, 'cluster');
      for (const tenant of session.lexicalStats!.tenants) {
        const check = await session.fixtureDb.query<{ c: { clean: boolean; cluster_status: string } }>('SELECT public.rag_lexstats_check($1) AS c', [tenant.tenant_key]);
        assert.equal(check.rows[0]!.c.clean, true);
        assert.equal(check.rows[0]!.c.cluster_status, 'ready');
      }
    } finally {
      await session.close();
    }
  });
});

describe('lexical-leg command DF modes (plan 04.4-18)', () => {
  test('--df-mode parses raw, cluster and raw,cluster; the default raw-only run writes to --out itself', () => {
    const base = ['--golden', 'g.jsonl', '--tenant', TENANT, '--out', 'eval/out/x'];
    assert.deepEqual(parseLexicalLegArgs(base).dfModes, ['raw']);
    assert.deepEqual(parseLexicalLegArgs([...base, '--df-mode', 'cluster,raw']).dfModes, ['raw', 'cluster']);
    assert.throws(() => parseLexicalLegArgs([...base, '--df-mode', 'unit']), LexicalLegError);
    assert.equal(dfModeOutDir('eval/out/x', ['raw'], 'raw'), 'eval/out/x');
    assert.equal(dfModeOutDir('eval/out/x', ['raw', 'cluster'], 'raw'), path.join('eval/out/x', 'raw'));
    assert.equal(dfModeOutDir('eval/out/x', ['raw', 'cluster'], 'cluster'), path.join('eval/out/x', 'cluster'));
  });

  test('a cluster run on a tenant whose cluster statistics are not ready is refused before any search', async () => {
    const calls: string[] = [];
    const rpc = {
      rpc: async (fn: string) => {
        calls.push(fn);
        return { data: { state: 'ready', chunk_count: 3, cluster_status: null }, error: null };
      },
    } as unknown as RpcClient;
    const items = [{ id: 'x', question: 'neutral sample words', language: 'en' }];
    await assert.rejects(runLexicalLegs({ rpc, tenantKey: TENANT, items, arms: lexicalLegArms(), dfMode: 'cluster' }), (error: unknown) => {
      return error instanceof LexicalLegError && error.code === 'lexical_cluster_stats_not_ready';
    });
    assert.deepEqual(calls, ['rag_lexstats_status']);
  });
});
