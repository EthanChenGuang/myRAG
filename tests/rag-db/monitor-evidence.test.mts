import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { seedRetrievalLog, type SeedCell, type SeededRow } from '../helpers/retrieval-log-seed.ts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const EVIDENCE = 'public.rag_monitor_alert_evidence($1, $2, $3::timestamptz, $4::timestamptz, $5::jsonb, $6)';
const HASH_OLD = 'a'.repeat(64);
const HASH_NEW = 'b'.repeat(64);
const HASH_EARLY = 'c'.repeat(64);

interface Evidence {
  sample_trace_ids: string[];
  config_hash_firsts: Array<{ hash: string; first_at: string }>;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function tenantKeys(mode: DeploymentMode): { a: string; b: string | null; foreign: string } {
  if (mode === 'single-tenant') return { a: 's:default', b: null, foreign: `u:${crypto.randomUUID()}` };
  return { a: `o:${crypto.randomUUID()}`, b: `u:${crypto.randomUUID()}`, foreign: 's:default' };
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function evidence(
  db: PGlite,
  tenant: string,
  language: string,
  from: string,
  to: string,
  match: Record<string, unknown>,
  limit = 10,
): Promise<Evidence> {
  const result = await db.query<{ e: Evidence }>(`SELECT ${EVIDENCE} AS e`, [tenant, language, from, to, JSON.stringify(match), limit]);
  return result.rows[0]!.e;
}

function cell(tenantKey: string, day: string, extra: Partial<SeedCell> = {}): SeedCell {
  return { tenantKey, day, language: 'it', ragMode: 'strict', channel: 'chat', rows: 40, ...extra };
}

for (const mode of MODES) {
  describe(`Phase 5.3 monitor evidence helpers 0972 to 0975 (${mode})`, () => {
    let db: PGlite;
    let keys: ReturnType<typeof tenantKeys>;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      keys = tenantKeys(mode);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec(`
        DO $$ BEGIN IF to_regclass('public.rag_monitor_runs') IS NOT NULL THEN DELETE FROM public.rag_monitor_runs; END IF; END $$;
        DELETE FROM public.rag_review_item_strata;
        DELETE FROM public.rag_review_items;
        DELETE FROM public.rag_query_cluster_assignments;
        DELETE FROM public.rag_query_clusters;
        DELETE FROM public.rag_query_cluster_sets;
        DELETE FROM public.rag_online_judge_scores;
        DELETE FROM public.rag_answer_records;
        DELETE FROM public.rag_retrieval_log;
      `);
    });

    describe('rag_monitor_alert_evidence', () => {
      let rowsA: SeededRow[];
      let rowsB: SeededRow[];

      beforeEach(async () => {
        const cells: SeedCell[] = [
          cell(keys.a, '2026-03-05', { rows: 60, counts: { degraded: 30, refused: 5 }, retrievalConfigHash: HASH_NEW }),
          cell(keys.a, '2026-03-05', { language: 'en', rows: 20, counts: { degraded: 8 }, retrievalConfigHash: HASH_NEW }),
          cell(keys.a, '2026-03-01', { rows: 10, retrievalConfigHash: HASH_OLD }),
          cell(keys.a, '2026-03-04', { rows: 5, retrievalConfigHash: HASH_EARLY }),
        ];
        if (keys.b) cells.push(cell(keys.b, '2026-03-05', { rows: 50, counts: { degraded: 25 }, retrievalConfigHash: HASH_OLD }));
        const seeded = await seedRetrievalLog(db, { seed: `evidence-${mode}`, cells });
        rowsA = seeded.rows.filter((row) => row.tenantKey === keys.a);
        rowsB = seeded.rows.filter((row) => row.tenantKey === keys.b);
      });

      test('returns at most 10 sample trace ids, all degraded rows of tenant A and the language', async () => {
        const result = await evidence(db, keys.a, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', { status: ['degraded'] });
        assert.equal(result.sample_trace_ids.length, 10);
        const degradedIt = new Set(rowsA.filter((row) => row.kind === 'degraded' && row.cellIndex === 0).map((row) => row.traceId));
        for (const id of result.sample_trace_ids) assert.ok(degradedIt.has(id), `${id} is not a degraded it row of A`);
        assert.equal(new Set(result.sample_trace_ids).size, 10);
      });

      test('the sample is deterministic and the limit is capped at 10', async () => {
        const first = await evidence(db, keys.a, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', { status: ['degraded'] }, 50);
        const second = await evidence(db, keys.a, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', { status: ['degraded'] }, 50);
        assert.equal(first.sample_trace_ids.length, 10);
        assert.deepEqual(first.sample_trace_ids, second.sample_trace_ids);
        const three = await evidence(db, keys.a, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', { status: ['degraded'] }, 3);
        assert.equal(three.sample_trace_ids.length, 3);
      });

      test('language all drops the language filter; an outcome list filters on it', async () => {
        const all = await evidence(db, keys.a, 'all', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', { status: ['degraded'] }, 10);
        const degradedAll = new Set(rowsA.filter((row) => row.kind === 'degraded').map((row) => row.traceId));
        for (const id of all.sample_trace_ids) assert.ok(degradedAll.has(id));
        const refused = await evidence(db, keys.a, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', {
          outcome: ['refused_no_context'],
        });
        const refusedIds = new Set(rowsA.filter((row) => row.kind === 'refused').map((row) => row.traceId));
        assert.equal(refused.sample_trace_ids.length, 5);
        for (const id of refused.sample_trace_ids) assert.ok(refusedIds.has(id));
      });

      test('a hash first seen inside the window or the two days before is listed; an older one is not', async () => {
        const result = await evidence(db, keys.a, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', { status: ['degraded'] });
        const hashes = result.config_hash_firsts.map((entry) => entry.hash).sort();
        assert.deepEqual(hashes, [HASH_NEW, HASH_EARLY].sort());
        const firstNew = result.config_hash_firsts.find((entry) => entry.hash === HASH_NEW)!;
        assert.equal(new Date(firstNew.first_at).toISOString().slice(0, 10), '2026-03-05');
      });

      test('never returns another tenant`s trace ids or hashes', { skip: mode === 'single-tenant' }, async () => {
        const result = await evidence(db, keys.b!, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', { status: ['degraded'] });
        const idsA = new Set(rowsA.map((row) => row.traceId));
        const idsB = new Set(rowsB.map((row) => row.traceId));
        assert.equal(result.sample_trace_ids.length, 10);
        for (const id of result.sample_trace_ids) {
          assert.ok(!idsA.has(id), 'tenant A trace returned for tenant B');
          assert.ok(idsB.has(id));
        }
        assert.deepEqual(result.config_hash_firsts.map((entry) => entry.hash), [HASH_OLD]);
      });

      test('returns ids and hashes only, no text', async () => {
        const result = await evidence(db, keys.a, 'all', '2026-03-01T00:00:00Z', '2026-03-06T00:00:00Z', {});
        assert.deepEqual(Object.keys(result).sort(), ['config_hash_firsts', 'sample_trace_ids']);
        assert.ok(!JSON.stringify(result).includes('q-'), 'masked query text leaked');
      });

      test('a key of the other deployment mode raises 22023', async () => {
        await assert.rejects(
          () => evidence(db, keys.foreign, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', {}),
          (error: unknown) => codeOf(error) === '22023',
        );
      });
    });

    describe('rag_monitor_cluster_shares', () => {
      async function writeSet(tenant: string, clusters: string[]): Promise<string> {
        const result = await db.query<{ id: string }>('SELECT public.rag_query_clusters_write($1, $2::jsonb, $3::jsonb) AS id', [
          tenant,
          JSON.stringify({ embedder: 'test-embedder', dimension: 2, k: clusters.length, query_count: 10, distance_threshold: 0.5 }),
          JSON.stringify(clusters.map((id) => ({ cluster_id: id, centroid: [0.1, 0.2], member_count: 5 }))),
        ]);
        return result.rows[0]!.id;
      }

      async function logIds(tenant: string): Promise<Array<{ id: string; created_at: string }>> {
        return (
          await db.query<{ id: string; created_at: string }>(
            'SELECT id, created_at::text AS created_at FROM public.rag_retrieval_log WHERE tenant_key = $1 ORDER BY trace_id',
            [tenant],
          )
        ).rows;
      }

      async function assign(tenant: string, setId: string, rows: Array<{ log_id: string; cluster_id: string }>): Promise<void> {
        await db.query('SELECT * FROM public.rag_query_cluster_assign($1, $2::uuid, $3::jsonb)', [tenant, setId, JSON.stringify(rows)]);
      }

      test('counts per cluster, language and channel of the current set since a date', async () => {
        const cells: SeedCell[] = [
          cell(keys.a, '2026-03-02', { rows: 4 }),
          cell(keys.a, '2026-03-05', { rows: 6 }),
          cell(keys.a, '2026-03-05', { rows: 3, language: 'en', channel: 'voice' }),
        ];
        if (keys.b) cells.push(cell(keys.b, '2026-03-05', { rows: 5 }));
        await seedRetrievalLog(db, { seed: `clusters-${mode}`, cells });

        const old = await writeSet(keys.a, ['c-01', 'c-02']);
        const rows = await logIds(keys.a);
        await assign(keys.a, old, rows.map((row) => ({ log_id: row.id, cluster_id: 'c-01' })));
        const current = await writeSet(keys.a, ['c-01', 'c-02']);
        const recent = rows.filter((row) => row.created_at >= '2026-03-05');
        await assign(
          keys.a,
          current,
          recent.map((row, i) => ({ log_id: row.id, cluster_id: i % 3 === 0 ? 'c-02' : 'c-01' })),
        );
        if (keys.b) {
          const setB = await writeSet(keys.b, ['c-01']);
          await assign(keys.b, setB, (await logIds(keys.b)).map((row) => ({ log_id: row.id, cluster_id: 'c-01' })));
        }

        const shares = await db.query<{ cluster_id: string; language: string; channel: string; n: number }>(
          'SELECT cluster_id, language, channel, n::int AS n FROM public.rag_monitor_cluster_shares($1, $2::timestamptz) ORDER BY 1, 2, 3',
          [keys.a, '2026-03-04T00:00:00Z'],
        );
        const total = shares.rows.reduce((sum, row) => sum + row.n, 0);
        assert.equal(total, 9, 'only the nine rows since the date that are assigned in the current set');
        const expected = new Map<string, number>();
        const recentSorted = recent;
        const byId = new Map(
          (
            await db.query<{ id: string; language: string; channel: string }>(
              'SELECT id, query_language AS language, channel FROM public.rag_retrieval_log WHERE tenant_key = $1',
              [keys.a],
            )
          ).rows.map((row) => [row.id, row]),
        );
        recentSorted.forEach((row, i) => {
          const meta = byId.get(row.id)!;
          const key = `${i % 3 === 0 ? 'c-02' : 'c-01'}|${meta.language}|${meta.channel}`;
          expected.set(key, (expected.get(key) ?? 0) + 1);
        });
        assert.deepEqual(
          Object.fromEntries(shares.rows.map((row) => [`${row.cluster_id}|${row.language}|${row.channel}`, row.n])),
          Object.fromEntries([...expected.entries()].sort()),
        );
      });

      test('a key of the other deployment mode raises 22023', async () => {
        await assert.rejects(
          () => db.query('SELECT * FROM public.rag_monitor_cluster_shares($1, now())', [keys.foreign]),
          (error: unknown) => codeOf(error) === '22023',
        );
      });
    });

    describe('rag_review_items_enqueue_re_review', () => {
      const fp = (n: number) => crypto.createHash('sha256').update(`fp-${n}`).digest('hex');
      const rows = [
        { query_masked: 'q-masked-1', query_fingerprint: fp(1), language: 'it', mining_window: '2026-03-01T00:00:00Z' },
        { query_masked: 'q-masked-2', query_fingerprint: fp(2), language: 'en', mining_window: '2026-03-01T00:00:00Z' },
      ];

      async function enqueue(tenant: string, payload: unknown): Promise<number> {
        return (
          await db.query<{ n: number }>('SELECT public.rag_review_items_enqueue_re_review($1, $2::jsonb) AS n', [tenant, JSON.stringify(payload)])
        ).rows[0]!.n;
      }

      test('inserts items with reason re_review and no strata row, idempotently', async () => {
        assert.equal(await enqueue(keys.a, rows), 2);
        assert.equal(await enqueue(keys.a, rows), 0);
        const items = await db.query<{ tenant_key: string; reasons: string[]; status: string; query_language: string }>(
          'SELECT tenant_key, reasons, status, query_language FROM public.rag_review_items ORDER BY query_fingerprint',
        );
        assert.equal(items.rows.length, 2);
        for (const item of items.rows) {
          assert.equal(item.tenant_key, keys.a);
          assert.deepEqual(item.reasons, ['re_review']);
          assert.equal(item.status, 'open');
        }
        const strata = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_review_item_strata');
        assert.equal(strata.rows[0]!.n, 0);
      });

      test('leaves another tenant`s items untouched', { skip: mode === 'single-tenant' }, async () => {
        assert.equal(await enqueue(keys.b!, rows), 2);
        assert.equal(await enqueue(keys.a, rows), 2);
        const counts = await db.query<{ tenant_key: string; n: number }>(
          'SELECT tenant_key, count(*)::int AS n FROM public.rag_review_items GROUP BY tenant_key ORDER BY tenant_key',
        );
        assert.deepEqual(
          Object.fromEntries(counts.rows.map((row) => [row.tenant_key, row.n])),
          { [keys.a]: 2, [keys.b!]: 2 },
        );
      });

      test('a malformed row or the other mode`s key raises 22023 and writes nothing', async () => {
        await assert.rejects(() => enqueue(keys.a, [{ query_masked: 'x' }]), (error: unknown) => codeOf(error) === '22023');
        await assert.rejects(() => enqueue(keys.a, { not: 'array' }), (error: unknown) => codeOf(error) === '22023');
        await assert.rejects(() => enqueue(keys.foreign, rows), (error: unknown) => codeOf(error) === '22023');
        const n = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_review_items');
        assert.equal(n.rows[0]!.n, 0);
      });
    });

    describe('rag_monitor_runs and grants', () => {
      test('service_role can insert a run row with counts only', async () => {
        await db.exec('SET ROLE service_role');
        try {
          await db.query(
            `INSERT INTO public.rag_monitor_runs (day, source, days_aggregated, groups_checked, groups_insufficient,
               alerts_opened, alerts_updated, deliveries) VALUES ('2026-03-05', 'cli', 7, 12, 3, 1, 0, 0)`,
          );
        } finally {
          await db.exec('RESET ROLE');
        }
        const row = await db.query<Record<string, unknown>>('SELECT * FROM public.rag_monitor_runs');
        assert.equal(row.rows.length, 1);
        assert.deepEqual(
          Object.keys(row.rows[0]!).sort(),
          ['alerts_opened', 'alerts_updated', 'day', 'days_aggregated', 'deliveries', 'groups_checked', 'groups_insufficient', 'id', 'ran_at', 'source'],
        );
        await assert.rejects(
          () => db.query("INSERT INTO public.rag_monitor_runs (day, source) VALUES ('2026-03-05', 'browser')"),
          (error: unknown) => codeOf(error) === '23514',
        );
        await assert.rejects(
          () => db.query("INSERT INTO public.rag_monitor_runs (day, source, alerts_opened) VALUES ('2026-03-05', 'cli', -1)"),
          (error: unknown) => codeOf(error) === '23514',
        );
        const rls = await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.rag_monitor_runs'::regclass");
        assert.equal(rls.rows[0]!.on, true);
      });

      for (const role of ['anon', 'authenticated'] as const) {
        test(`${role} gets 42501 on rag_monitor_runs and the three functions`, async () => {
          const attempts: Array<[string, unknown[]]> = [
            ['SELECT 1 FROM public.rag_monitor_runs LIMIT 1', []],
            ["INSERT INTO public.rag_monitor_runs (day, source) VALUES ('2026-03-05', 'cli')", []],
            [`SELECT ${EVIDENCE}`, [keys.a, 'it', '2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', '{}', 10]],
            ['SELECT * FROM public.rag_monitor_cluster_shares($1, now())', [keys.a]],
            ["SELECT public.rag_review_items_enqueue_re_review($1, '[]'::jsonb)", [keys.a]],
          ];
          for (const [sql, params] of attempts) {
            await assert.rejects(
              () => asRole(db, role, () => db.query(sql, params)),
              (error: unknown) => codeOf(error) === '42501',
              `${role}: ${sql}`,
            );
          }
        });
      }
    });
  });

  describe(`0972 to 0975 without the Phase 5.1.1 tables (${mode})`, () => {
    test('each file applies twice and the functions return empty results', async () => {
      const files = migrationFiles(mode);
      const start = files.findIndex((file) => /\/09[67]\d_/.test(file));
      const { db } = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        await applyMigrationFiles(db, files.slice(0, start));
        await db.exec('DROP TABLE IF EXISTS public.rag_retrieval_log CASCADE; DROP TABLE IF EXISTS public.rag_review_items CASCADE;');
        const ours = files.filter((file) => /\/097[2-5]_/.test(file));
        assert.equal(ours.length, 4);
        await applyMigrationFiles(db, ours);
        await applyMigrationFiles(db, ours);
        const key = mode === 'single-tenant' ? 's:default' : `u:${crypto.randomUUID()}`;
        const ev = await db.query<{ e: Evidence }>(`SELECT ${EVIDENCE} AS e`, [key, 'all', '2026-03-01T00:00:00Z', '2026-03-06T00:00:00Z', '{}', 10]);
        assert.deepEqual(ev.rows[0]!.e, { sample_trace_ids: [], config_hash_firsts: [] });
        const shares = await db.query('SELECT * FROM public.rag_monitor_cluster_shares($1, now())', [key]);
        assert.equal(shares.rows.length, 0);
        const n = await db.query<{ n: number }>(
          "SELECT public.rag_review_items_enqueue_re_review($1, '[{\"query_masked\":\"x\",\"query_fingerprint\":\"" + 'd'.repeat(64) + "\",\"mining_window\":\"2026-03-01\"}]'::jsonb) AS n",
          [key],
        );
        assert.equal(n.rows[0]!.n, 0);
        const runs = await db.query<{ t: string | null }>("SELECT to_regclass('public.rag_monitor_runs')::text AS t");
        assert.equal(runs.rows[0]!.t, 'rag_monitor_runs');
      } finally {
        await db.close();
      }
    });
  });
}
