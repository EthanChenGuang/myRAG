import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { createTwoTenantDatabase, TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const M0354 = 'supabase/migrations/0354_parse_budget.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const TENANT_SINGLE = 's:default';
const TENANT_USER = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_ORG = `o:${TWO_TENANT_IDS.orgO}`;

const BUDGET_FUNCTIONS = [
  'rag_reserve_parse_budget',
  'rag_settle_parse_budget',
  'rag_release_parse_budget',
  'rag_reserve_batch_budget',
  'rag_parse_budget_month',
] as const;

type Role = 'anon' | 'authenticated' | 'service_role';

async function applyBudgetMigration(db: PGlite): Promise<void> {
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, M0354), 'utf8'));
}

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : null;
    return { message, code };
  }
}

function expectSqlState(err: { message: string; code: string | null } | null, state: string): void {
  assert.ok(err, `expected SQLSTATE ${state}`);
  assert.ok(err.code === state || err.message.includes(state), `expected ${state}, got code=${err.code} message=${err.message}`);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function insertJob(db: PGlite, tenant: string, batchId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ingestion_jobs (id, tenant_key, kind, status, source, source_key, settings, batch_id)
     VALUES ($1, $2, 'ingest', 'queued', 'config_upload', $3, '{}'::jsonb, $4)`,
    [id, tenant, `fixture/${id}`, batchId],
  );
  return id;
}

async function insertBatch(db: PGlite, tenant: string, budgetUsd: number, spentUsd = 0): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ingestion_batches (id, tenant_key, source_kind, source_ref, budget_usd, spent_usd, concurrency, runner, status)
     VALUES ($1, $2, 'folder', '/tmp/backfill', $3, $4, 2, 'worker', 'pending')`,
    [id, tenant, budgetUsd, spentUsd],
  );
  return id;
}

async function reserve(
  db: PGlite,
  jobId: string,
  attempt: number,
  pages: number,
  kind: 'parse' | 'vlm',
  limit: number,
): Promise<boolean> {
  const row = (
    await db.query<{ rag_reserve_parse_budget: boolean }>(
      'SELECT rag_reserve_parse_budget($1::uuid, $2::int, $3::int, $4::text, $5::int)',
      [jobId, attempt, pages, kind, limit],
    )
  ).rows[0];
  return row?.rag_reserve_parse_budget === true;
}

async function currentUsage(db: PGlite, tenant: string): Promise<{
  pages_reserved: number;
  pages_used: number;
  vlm_pages_used: number;
}> {
  const row = (
    await db.query<{ pages_reserved: number; pages_used: number; vlm_pages_used: number }>(
      `SELECT pages_reserved, pages_used, vlm_pages_used
       FROM rag_parse_budget_usage
       WHERE tenant_key = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
      [tenant],
    )
  ).rows[0];
  return row ?? { pages_reserved: 0, pages_used: 0, vlm_pages_used: 0 };
}

for (const mode of MODES) {
  describe(`parse budget (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let tenant: string;

    before(async () => {
      fixture =
        mode === 'multi-tenant'
          ? await createTwoTenantDatabase()
          : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
      tenant = mode === 'single-tenant' ? TENANT_SINGLE : TENANT_USER;
      await applyBudgetMigration(db);
    });

    after(async () => {
      await fixture.db.close();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM rag_parse_budget_reservations');
      await db.query('DELETE FROM rag_parse_budget_usage');
    });

    test('budget RPCs are executable by service_role only', async () => {
      const exposure = await db.query<{ proname: string; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT p.proname,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)
         ORDER BY p.proname`,
        [BUDGET_FUNCTIONS],
      );
      assert.equal(exposure.rows.length, BUDGET_FUNCTIONS.length);
      for (const row of exposure.rows) {
        assert.deepEqual(
          { anon: row.anon, authenticated: row.authenticated, service: row.service },
          { anon: false, authenticated: false, service: true },
          row.proname,
        );
      }
    });

    test('anon and authenticated cannot call budget RPCs', async () => {
      const jobId = await insertJob(db, tenant);
      for (const role of ['anon', 'authenticated'] as const) {
        await asRole(db, role, async () => {
          const err = await tryQuery(db, 'SELECT rag_reserve_parse_budget($1::uuid, 1, 1, $2, 10)', [jobId, 'parse']);
          expectSqlState(err, '42501');
        });
      }
    });

    test('limit 0 rejects reservation without creating a usage row', async () => {
      const jobId = await insertJob(db, tenant);
      const ok = await reserve(db, jobId, 1, 1, 'parse', 0);
      assert.equal(ok, false);
      const usage = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM rag_parse_budget_usage WHERE tenant_key = $1',
        [tenant],
      );
      assert.equal(usage.rows[0]?.n, 0);
    });

    test('limit 10 rejects 11 pages; 6+5 reserves; settle records actual use', async () => {
      const job6 = await insertJob(db, tenant);
      const job5 = await insertJob(db, tenant);
      assert.equal(await reserve(db, job6, 1, 11, 'parse', 10), false);
      assert.equal(await reserve(db, job6, 1, 6, 'parse', 10), true);
      assert.equal(await reserve(db, job5, 1, 5, 'parse', 10), false);
      await db.query('SELECT rag_settle_parse_budget($1::uuid, 1, $2, 4)', [job6, 'parse']);
      assert.equal(await reserve(db, job5, 2, 5, 'parse', 10), true);
      const usage = await currentUsage(db, tenant);
      assert.deepEqual(usage, { pages_reserved: 5, pages_used: 4, vlm_pages_used: 0 });
    });

    test('vlm kind settles into vlm_pages_used against the same limit', async () => {
      const job = await insertJob(db, tenant);
      assert.equal(await reserve(db, job, 1, 3, 'vlm', 5), true);
      await db.query('SELECT rag_settle_parse_budget($1::uuid, 1, $2, 2)', [job, 'vlm']);
      const usage = await currentUsage(db, tenant);
      assert.equal(usage.pages_reserved, 0);
      assert.equal(usage.pages_used, 0);
      assert.equal(usage.vlm_pages_used, 2);
      const job2 = await insertJob(db, tenant);
      assert.equal(await reserve(db, job2, 1, 4, 'parse', 5), false);
    });

    test('two tenants reserve independently in multi-tenant mode', async () => {
      if (mode !== 'multi-tenant') return;
      const jobA = await insertJob(db, TENANT_USER);
      const jobB = await insertJob(db, TENANT_ORG);
      for (let i = 0; i < 5; i++) {
        assert.equal(await reserve(db, jobA, i + 1, 1, 'parse', 5), true);
        assert.equal(await reserve(db, jobB, i + 1, 1, 'parse', 5), true);
      }
      const usageA = await currentUsage(db, TENANT_USER);
      const usageB = await currentUsage(db, TENANT_ORG);
      assert.equal(usageA.pages_reserved, 5);
      assert.equal(usageB.pages_reserved, 5);
    });

    test('interleaved reserves cap at the limit under concurrency', async () => {
      const jobs = await Promise.all(Array.from({ length: 20 }, () => insertJob(db, tenant)));
      const results = await Promise.all(jobs.map((jobId, index) => reserve(db, jobId, 1, 1, 'parse', 10)));
      assert.equal(results.filter(Boolean).length, 10);
    });

    test('usage month stays UTC when session timezone is Pacific/Kiritimati', async () => {
      await db.exec("SET TIME ZONE 'Pacific/Kiritimati'");
      try {
        const jobId = await insertJob(db, tenant);
        assert.equal(await reserve(db, jobId, 1, 1, 'parse', 100), true);
        const row = await db.query<{ month: string }>(
          'SELECT month::text FROM rag_parse_budget_usage WHERE tenant_key = $1',
          [tenant],
        );
        const utcMonth = (
          await db.query<{ month: string }>(
            "SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS month",
          )
        ).rows[0]?.month;
        assert.equal(row.rows[0]?.month, utcMonth);
      } finally {
        await db.exec('RESET TIME ZONE');
      }
    });

    test('batch USD budget enforces spent_usd; jobs without a batch always succeed', async () => {
      const batchId = await insertBatch(db, tenant, 1.0, 0);
      const jobBatch = await insertJob(db, tenant, batchId);
      const jobLoose = await insertJob(db, tenant, null);
      const first = (
        await db.query<{ ok: boolean }>('SELECT rag_reserve_batch_budget($1::uuid, 0.6::numeric) AS ok', [jobBatch])
      ).rows[0]?.ok;
      assert.equal(first, true);
      const second = (
        await db.query<{ ok: boolean }>('SELECT rag_reserve_batch_budget($1::uuid, 0.5::numeric) AS ok', [jobBatch])
      ).rows[0]?.ok;
      assert.equal(second, false);
      const third = (
        await db.query<{ ok: boolean }>('SELECT rag_reserve_batch_budget($1::uuid, 0.4::numeric) AS ok', [jobBatch])
      ).rows[0]?.ok;
      assert.equal(third, true);
      const loose = (
        await db.query<{ ok: boolean }>('SELECT rag_reserve_batch_budget($1::uuid, 999::numeric) AS ok', [jobLoose])
      ).rows[0]?.ok;
      assert.equal(loose, true);
    });

    test('rag_parse_budget_month returns usage for one tenant or all', async () => {
      const job = await insertJob(db, tenant);
      assert.equal(await reserve(db, job, 1, 2, 'parse', 100), true);
      await db.query('SELECT rag_settle_parse_budget($1::uuid, 1, $2, 2)', [job, 'parse']);
      const one = await db.query<{ tenant_key: string; pages_used: number }>(
        'SELECT tenant_key, pages_used FROM rag_parse_budget_month($1)',
        [tenant],
      );
      assert.ok(one.rows.some((row) => row.tenant_key === tenant && row.pages_used === 2));
      const all = await db.query('SELECT tenant_key FROM rag_parse_budget_month(NULL)');
      assert.ok(all.rows.some((row) => (row as { tenant_key: string }).tenant_key === tenant));
    });

    test('release returns reserved pages and is idempotent', async () => {
      const job = await insertJob(db, tenant);
      assert.equal(await reserve(db, job, 1, 3, 'parse', 10), true);
      await db.query('SELECT rag_release_parse_budget($1::uuid, 1, $2)', [job, 'parse']);
      await db.query('SELECT rag_release_parse_budget($1::uuid, 1, $2)', [job, 'parse']);
      const usage = await currentUsage(db, tenant);
      assert.equal(usage.pages_reserved, 0);
    });
  });
}