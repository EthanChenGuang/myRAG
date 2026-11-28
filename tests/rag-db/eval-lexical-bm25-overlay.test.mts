import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareInProcessEval, runEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { loadRunConfig, parseRunConfig, RunConfigError } from '../../eval/harness/run-config.mts';
import { OVERLAP_FILE } from '../../eval/harness/lexical-stats.mts';

/**
 * D-36: the fixture harness rebuilds lexical statistics for every fixture tenant only when the run's effective scoring is bm25, and a
 * bm25 run's lexical leg is served by rag_bm25_search_chunks. The default run leaves the four statistics tables empty.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const STATS_TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus'];
const ITEM_IDS = ['en-general-001', 'en-exact-term-001'];

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-bm25-overlay-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function goldenSubset(dir: string): string {
  const lines = fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && ITEM_IDS.includes((JSON.parse(line) as { id: string }).id));
  assert.equal(lines.length, ITEM_IDS.length, 'the golden items exist');
  const file = path.join(dir, 'subset.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function rowCounts(session: InProcessEval): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of STATS_TABLES) {
    const result = await session.fixtureDb.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
    counts[table] = result.rows[0]!.n;
  }
  return counts;
}

describe('run config v2-lexical-bm25-on (D-36)', () => {
  test('is v2-default plus the three lexical scoring variables', () => {
    const base = loadRunConfig(path.join(RUNS_DIR, 'v2-default.json'));
    const on = loadRunConfig(path.join(RUNS_DIR, 'v2-lexical-bm25-on.json'));
    assert.equal(on.name, 'v2-lexical-bm25-on');
    assert.deepEqual(on.env, { ...base.env, RAG_LEXICAL_SCORING: 'bm25', RAG_LEXICAL_BM25_K1: '1.2', RAG_LEXICAL_BM25_B: '0.75' });
    assert.deepEqual(on.overrides, base.overrides);
  });

  test('a run config rejects a scoring mode or a k1 / b value the app would not accept', () => {
    assert.throws(() => parseRunConfig({ name: 'bad-mode', env: { RAG_LEXICAL_SCORING: 'bm42' } }, 'inline'), RunConfigError);
    assert.throws(() => parseRunConfig({ name: 'bad-k1', env: { RAG_LEXICAL_BM25_K1: '9' } }, 'inline'), RunConfigError);
    assert.throws(() => parseRunConfig({ name: 'bad-b', env: { RAG_LEXICAL_BM25_B: 'high' } }, 'inline'), RunConfigError);
    assert.deepEqual(parseRunConfig({ name: 'ok', env: { RAG_LEXICAL_SCORING: 'ts_rank_cd', RAG_LEXICAL_BM25_B: '0' } }, 'inline').env, {
      RAG_LEXICAL_BM25_B: '0',
      RAG_LEXICAL_SCORING: 'ts_rank_cd',
    });
  });
});

describe('fixture lexical statistics seeding (D-36)', () => {
  test('a bm25 run ends with every fixture tenant ready and clean, is served by rag_bm25_search_chunks and writes the overlap figures', async () => {
    const env = loadRunConfig(path.join(RUNS_DIR, 'v2-lexical-bm25-on.json')).env;
    const session = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant', fixtureMode: 'prechunked', envOverrides: env });
    try {
      assert.ok(session.lexicalStats, 'statistics were seeded');
      assert.deepEqual({ k1: session.lexicalStats.k1, b: session.lexicalStats.b }, { k1: 1.2, b: 0.75 });
      const tenants = await session.fixtureDb.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM public.document_chunks ORDER BY 1');
      assert.deepEqual(
        session.lexicalStats.tenants.map((entry) => entry.tenant_key),
        tenants.rows.map((row) => row.tenant_key),
      );
      for (const { tenant_key } of tenants.rows) {
        const check = await session.fixtureDb.query<{ c: { state: string; clean: boolean; pending: number } }>('SELECT public.rag_lexstats_check($1) AS c', [tenant_key]);
        assert.equal(check.rows[0]!.c.state, 'ready');
        assert.equal(check.rows[0]!.c.clean, true);
        assert.equal(Number(check.rows[0]!.c.pending), 0);
      }
      assert.ok((await rowCounts(session)).rag_lexical_df > 0);
      assert.ok(session.sqlSha256['lexical_stats:bm25']);

      const dir = makeTmpDir();
      const start = session.edge.calls.length;
      const result = await runEval({ goldenPath: goldenSubset(dir), corpusDir: CORPUS_DIR, outDir: path.join(dir, 'out'), deploymentMode: 'single-tenant', retainInProcess: session });
      assert.equal(result.edgeErrors, 0);
      const paths = session.edge.calls.slice(start).map((call) => call.path);
      assert.ok(paths.some((p) => p.endsWith('/rpc/rag_bm25_search_chunks')), 'the lexical leg was scored by rag_bm25_search_chunks');

      const overlap = JSON.parse(fs.readFileSync(path.join(dir, 'out', OVERLAP_FILE), 'utf8')) as {
        k: number;
        questions: number;
        measured: number;
        mean_overlap_at_k: number | null;
        items: Array<{ item_id: string; overlap: number | null }>;
      };
      assert.equal(overlap.k, 10);
      assert.equal(overlap.questions, ITEM_IDS.length);
      assert.ok(overlap.measured >= 1);
      assert.ok(overlap.mean_overlap_at_k !== null && overlap.mean_overlap_at_k >= 0 && overlap.mean_overlap_at_k <= 1);
      assert.deepEqual(overlap.items.map((row) => row.item_id).sort(), [...ITEM_IDS].sort());
      const text = fs.readFileSync(path.join(dir, 'out', OVERLAP_FILE), 'utf8');
      for (const line of fs.readFileSync(goldenSubset(makeTmpDir()), 'utf8').trim().split('\n')) {
        assert.equal(text.includes((JSON.parse(line) as { question: string }).question), false, 'no question text in the overlap file');
      }
    } finally {
      await session.close();
    }
  });
  test('a bm25 run also seeds the isolated q62 and dominant-language tenants (each its own database), ready and clean', async () => {
    const env = loadRunConfig(path.join(RUNS_DIR, 'v2-lexical-bm25-on.json')).env;
    const session = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      fixtureMode: 'prechunked',
      envOverrides: env,
      q62: true,
      dominantLanguage: true,
    });
    try {
      for (const [name, tenant] of [['q62', session.q62Tenant], ['dominant_language', session.dominantLanguageTenant]] as const) {
        assert.ok(tenant, `${name} tenant built`);
        const check = await tenant.db.query<{ c: { state: string | null; clean: boolean; pending: number } }>('SELECT public.rag_lexstats_check($1) AS c', [tenant.tenantKey]);
        assert.equal(check.rows[0]!.c.state, 'ready', `${name} statistics ready`);
        assert.equal(check.rows[0]!.c.clean, true, `${name} statistics clean`);
        assert.ok(session.lexicalStats?.tenants.some((entry) => entry.tenant_key === tenant.tenantKey), `${name} reported`);
      }
    } finally {
      await session.close();
    }
  });
  // The app modules keep the fake edge URL of the first session in this process, so only the bm25 session above sends requests; this
  // one checks the database a default build leaves (the no-call identity of ts_rank_cd is tests/rag-e2e/lexical-bm25-pipeline.test.mts).
  test('a run at the defaults leaves the four statistics tables empty and adds no inputs entry', async () => {
    const env = loadRunConfig(path.join(RUNS_DIR, 'v2-default.json')).env;
    const session = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant', fixtureMode: 'prechunked', envOverrides: env });
    try {
      assert.equal(session.lexicalStats, undefined);
      assert.deepEqual(await rowCounts(session), Object.fromEntries(STATS_TABLES.map((table) => [table, 0])));
      assert.equal(Object.keys(session.sqlSha256).some((key) => key.startsWith('lexical_stats:')), false);
    } finally {
      await session.close();
    }
  });
});
