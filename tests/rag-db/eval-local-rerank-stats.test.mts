import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareInProcessEval } from '../../eval/harness/run-eval.mts';
import { loadRunConfig } from '../../eval/harness/run-config.mts';
import { classifyRun, discoverRuns, rerankInversions } from '../../eval/harness/local-rerank-impact.mts';

/**
 * Plan 04.4-22 (D-58), harness support only: a run whose effective RAG_RERANK_LOCAL_STATS is tenant gets lexical statistics enabled and
 * rebuilt for its fixture tenants and a manifest input, a pool run builds nothing; the impact tool classifies every run. No golden item
 * is run in tenant mode here (D-57: no tenant-mode metric before the pre-registration).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/config/runs');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const STATS_TABLES = ['rag_lexical_stats_state', 'rag_lexical_df', 'rag_lexical_corpus'];

describe('run configs with RAG_RERANK_LOCAL_STATS=tenant (04.4-22)', () => {
  for (const [name, base] of [
    ['v2-default-local-stats-tenant', 'v2-default'],
    ['v2-lexical-bm25-on-local-stats-tenant', 'v2-lexical-bm25-on'],
  ] as const) {
    test(`${name} is ${base} plus RAG_RERANK_LOCAL_STATS=tenant`, () => {
      const on = loadRunConfig(path.join(RUNS_DIR, `${name}.json`));
      const ref = loadRunConfig(path.join(RUNS_DIR, `${base}.json`));
      assert.equal(on.name, name);
      assert.deepEqual(on.env, { ...ref.env, RAG_RERANK_LOCAL_STATS: 'tenant' });
      assert.deepEqual(on.overrides, ref.overrides);
    });
  }
});

describe('fixture statistics seeding for tenant rerank statistics (04.4-22)', () => {
  test('a tenant-mode run under ts_rank_cd ends with every fixture tenant ready and clean and records the input; it writes no bm25 key', async () => {
    const env = loadRunConfig(path.join(RUNS_DIR, 'v2-default-local-stats-tenant.json')).env;
    const session = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant', fixtureMode: 'prechunked', envOverrides: env });
    try {
      assert.ok(session.lexicalStats, 'statistics were seeded');
      assert.equal(session.lexicalStats.scoring, 'ts_rank_cd');
      assert.equal(session.lexicalStats.rerankLocalStats, 'tenant');
      const tenants = await session.fixtureDb.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM public.document_chunks ORDER BY 1');
      assert.deepEqual(
        session.lexicalStats.tenants.map((entry) => entry.tenant_key),
        tenants.rows.map((row) => row.tenant_key),
      );
      for (const entry of session.lexicalStats.tenants) {
        assert.equal(entry.state, 'ready');
        assert.equal(entry.clean, true);
      }
      assert.ok(session.sqlSha256['lexical_stats:rerank_tenant']);
      assert.equal(session.sqlSha256['lexical_stats:bm25'], undefined);
    } finally {
      await session.close();
    }
  });

  test('a pool run builds no statistics and adds no manifest input', async () => {
    const env = loadRunConfig(path.join(RUNS_DIR, 'v2-default.json')).env;
    const session = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant', fixtureMode: 'prechunked', envOverrides: env });
    try {
      assert.equal(session.lexicalStats, undefined);
      for (const table of STATS_TABLES) {
        const { rows } = await session.fixtureDb.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
        assert.equal(rows[0]?.n, 0, table);
      }
      assert.equal(Object.keys(session.sqlSha256).filter((key) => key.startsWith('lexical_stats:')).length, 0);
    } finally {
      await session.close();
    }
  });
});

describe('local-rerank-impact --list (04.4-22, D-58)', () => {
  test('every run config and every phase spec run is classified, by the app resolver', async () => {
    const runs = discoverRuns();
    const files = fs.readdirSync(RUNS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) assert.ok(runs.some((run) => run.source === `eval/config/runs/${file}`), `${file} is discovered`);
    const byName = new Map<string, Awaited<ReturnType<typeof classifyRun>>>();
    for (const run of runs) {
      const classified = await classifyRun(run);
      assert.ok(['local_bm25', 'not_affected'].includes(classified.classification), run.source);
      assert.ok(classified.reasons.length > 0, `${run.source} has a reason`);
      byName.set(run.source, classified);
    }
    assert.equal(byName.get('eval/config/runs/v2-default.json')?.classification, 'local_bm25');
    assert.match(byName.get('eval/config/runs/v2-default.json')?.reasons[0] ?? '', /^auto_without_key/);
    assert.equal(byName.get('eval/config/runs/v2-default.json')?.providers.eval, 'local_bm25');
    assert.equal(byName.get('eval/config/runs/v2-default-hosted-fake.json')?.providers.eval, 'cohere');
    assert.equal(byName.get('eval/config/runs/v2-default-hosted-fake.json')?.providers.voice, 'local_bm25');
  });

  test('rerank inversions count strict order flips among common candidates and ignore ties', () => {
    const row = (id: string, scores: Record<string, number>) => [id, { item_id: id, candidates: Object.entries(scores).map(([chunk_id, rerank_score]) => ({ chunk_id, rerank_score })) }] as const;
    const a = new Map([row('i1', { x: 0.9, y: 0.5, z: 0.5, w: 0.1 })]);
    const same = new Map([row('i1', { x: 0.8, y: 0.4, z: 0.2, v: 1 })]);
    assert.deepEqual(rerankInversions(a, same), { items: 1, pairs: 2, inversions: 0 });
    const flipped = new Map([row('i1', { x: 0.1, y: 0.4, z: 0.2 })]);
    assert.deepEqual(rerankInversions(a, flipped), { items: 1, pairs: 2, inversions: 2 });
  });
});
