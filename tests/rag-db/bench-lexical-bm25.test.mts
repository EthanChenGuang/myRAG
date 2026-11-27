import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, type BenchDeps, type SqlConnection } from '../../scripts/rag/bench-lexical-bm25.mts';

/**
 * LEX-07 benchmark tool (plan 04.4-12): PGlite run with the repository migrations, the report fields, reproducibility, the cap
 * agreement when the matches fit, and the real-Postgres mode's handling of the URL (read from a named variable, never printed).
 * Text is generated neutral tokens only (D-41); the reports carry no token, lexeme or tenant key (D-34).
 */
const TOKEN = /\bw\d+\b/;
const SHAPES = ['rare_single', 'mixed_rare_common', 'many_terms', 'common_only'];

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], deps: Partial<BenchDeps> = {}): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    env: {},
    stdout: (line: string) => {
      stdout += `${line}\n`;
    },
    stderr: (line: string) => {
      stderr += `${line}\n`;
    },
    ...deps,
  });
  return { code, stdout, stderr };
}

type Json = Record<string, any>;

describe('bench-lexical-bm25 in PGlite', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-bm25-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-bm25-b-'));
  let first: Captured;
  let second: Captured;
  let report: Json;
  let markdown = '';

  before(async () => {
    const args = ['--chunks', '2000', '--queries', '8', '--seed', '3', '--runs', '2', '--warmup', '1'];
    first = await run([...args, '--out', dirA]);
    second = await run([...args, '--out', dirB]);
    const jsonPath = path.join(dirA, 'benchmark-fixture.json');
    report = fs.existsSync(jsonPath) ? (JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Json) : {};
    const mdPath = path.join(dirA, 'benchmark-fixture.md');
    markdown = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  });

  after(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  test('finishes and writes both files', () => {
    assert.equal(first.code, 0, first.stderr);
    assert.ok(markdown.length > 0, 'markdown report written');
    assert.equal(report.mode, 'pglite');
    assert.equal(report.sizes?.length, 1);
    assert.equal(report.sizes[0].chunks, 2000);
  });

  test('one entry per query shape with every field', () => {
    const shapes = report.sizes?.[0]?.shapes as Json[] | undefined;
    assert.ok(Array.isArray(shapes));
    assert.deepEqual(
      shapes.map((s) => s.shape),
      SHAPES,
    );
    for (const s of shapes) {
      assert.equal(s.queries, 2, `${s.shape}: queries`);
      for (const field of ['matched_rows', 'candidates_scored', 'overlap_at_10', 'overlap_at_50']) {
        assert.ok(Array.isArray(s[field]) && s[field].length === 2, `${s.shape}: ${field}`);
      }
      for (const m of ['ts_rank_cd', 'bm25']) {
        assert.equal(typeof s[m]?.p50_ms, 'number', `${s.shape}: ${m} p50`);
        assert.equal(typeof s[m]?.p95_ms, 'number', `${s.shape}: ${m} p95`);
        assert.ok(s[m].p95_ms >= s[m].p50_ms, `${s.shape}: ${m} p95 >= p50`);
      }
      assert.match(String(s.plans?.bm25 ?? ''), /Scan|Limit|Sort/, `${s.shape}: BM25 plan text`);
      assert.match(String(s.plans?.ts_rank_cd ?? ''), /Scan|Limit|Sort/, `${s.shape}: ts_rank_cd plan text`);
      s.matched_rows.forEach((matched: number, i: number) => {
        assert.ok(matched > 0, `${s.shape}: query ${i} matches rows`);
        assert.equal(s.candidates_scored[i], Math.min(matched, report.candidate_limit));
      });
    }
  });

  test('the capped result equals the uncapped one when the matches fit in the cap', () => {
    let fitting = 0;
    for (const s of report.sizes?.[0]?.shapes ?? []) {
      s.matched_rows.forEach((matched: number, i: number) => {
        if (matched > report.candidate_limit) return;
        fitting += 1;
        assert.equal(s.overlap_at_10[i], 1, `${s.shape}: overlap@10`);
        assert.equal(s.overlap_at_50[i], 1, `${s.shape}: overlap@50`);
      });
    }
    assert.ok(fitting > 0, 'at least one query fits in the cap');
  });

  test('the same seed gives the same matched counts and overlap figures', () => {
    assert.equal(second.code, 0, second.stderr);
    const other = JSON.parse(fs.readFileSync(path.join(dirB, 'benchmark-fixture.json'), 'utf8')) as Json;
    const pick = (r: Json) => r.sizes[0].shapes.map((s: Json) => [s.matched_rows, s.candidates_scored, s.overlap_at_10, s.overlap_at_50]);
    assert.deepEqual(pick(other), pick(report));
  });

  test('the throwaway tenant is removed', () => {
    const cleanup = report.sizes?.[0]?.cleanup as Json | undefined;
    assert.ok(cleanup, 'cleanup counts recorded');
    for (const [table, count] of Object.entries(cleanup)) assert.equal(count, 0, `${table} left rows`);
  });

  test('the markdown report has the table, plans, budgets and the PGlite caveat', () => {
    assert.match(markdown, /\| shape \|/);
    assert.match(markdown, /EXPLAIN \(ANALYZE, BUFFERS\)/);
    assert.match(markdown, /2000 chunks/);
    assert.match(markdown, /not the budget measurement/);
    assert.match(markdown, /04\.4-15/);
    assert.match(markdown, /chat[^\n]*400 ms/);
    assert.match(markdown, /voice[^\n]*300 ms/);
  });

  test('no token, lexeme or tenant key in the reports or the output', () => {
    const json = JSON.stringify(report);
    for (const [label, text] of [
      ['markdown', markdown],
      ['json', json],
      ['stdout', first.stdout + first.stderr],
    ] as const) {
      assert.doesNotMatch(text, TOKEN, `${label} holds a token`);
      assert.ok(!text.includes('s:default'), `${label} holds the tenant key`);
    }
    assert.match(first.stdout, /\d+(\.\d+)? ms/, 'stdout prints timings');
  });
});

describe('bench-lexical-bm25 real-Postgres mode', () => {
  const FAKE_URL = 'postgresql://bench-user:fake-password-0000@db.invalid:5432/postgres';

  test('a missing variable exits 2 with a usage message', async () => {
    const out = await run(['--chunks', '100', '--database-url-env', 'BENCH_DB_URL_UNSET'], { env: {} });
    assert.equal(out.code, 2);
    assert.match(out.stderr, /usage/i);
    assert.match(out.stderr, /BENCH_DB_URL_UNSET/);
  });

  test('a URL given as an argument is refused', async () => {
    const out = await run(['--chunks', '100', '--database-url', FAKE_URL]);
    assert.equal(out.code, 2);
    assert.ok(!(out.stdout + out.stderr).includes(FAKE_URL));
    assert.ok(!(out.stdout + out.stderr).includes('fake-password-0000'));
  });

  test('the URL reaches the connection and never the output, also when the connection fails', async () => {
    const seen: string[] = [];
    const failing = async (url: string): Promise<SqlConnection> => {
      seen.push(url);
      throw new Error(`could not connect to ${url}`);
    };
    const out = await run(['--chunks', '100', '--database-url-env', 'BENCH_DB_URL'], {
      env: { BENCH_DB_URL: FAKE_URL },
      connectPostgres: failing,
    });
    assert.deepEqual(seen, [FAKE_URL]);
    assert.notEqual(out.code, 0);
    const text = out.stdout + out.stderr;
    assert.ok(!text.includes(FAKE_URL), 'URL printed');
    assert.ok(!text.includes('fake-password-0000'), 'password printed');
    assert.ok(!text.includes('db.invalid'), 'host printed');
  });

  test('a single-tenant database is refused, since its only tenant is the live one', async () => {
    const calls: string[] = [];
    let closed = false;
    const stub: SqlConnection = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        calls.push(sql);
        if (sql.includes('rag_assert_tenant_key')) return { rows: [] as T[] };
        throw new Error(`unexpected statement after the mode check on ${FAKE_URL}`);
      },
      async exec(sql: string): Promise<void> {
        calls.push(sql);
      },
      async queryWithNotices<T>(sql: string): Promise<{ rows: T[]; notices: string[] }> {
        calls.push(sql);
        return { rows: [], notices: [] };
      },
      async close(): Promise<void> {
        closed = true;
      },
    };
    const out = await run(['--chunks', '100', '--database-url-env', 'BENCH_DB_URL'], {
      env: { BENCH_DB_URL: FAKE_URL },
      connectPostgres: async () => stub,
    });
    assert.equal(out.code, 2);
    assert.match(out.stderr, /multi-tenant/);
    assert.ok(closed, 'connection closed');
    assert.ok(!calls.some((sql) => /INSERT/i.test(sql)), 'nothing written');
    assert.ok(!(out.stdout + out.stderr).includes(FAKE_URL));
  });
});
