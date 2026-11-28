import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION_0352 = 'supabase/migrations/0352_ingestion_claim.sql';

const TENANT_SINGLE = 's:default';
const TENANT_USER = `u:${TWO_TENANT_IDS.userA}`;

type Role = 'anon' | 'authenticated' | 'service_role';

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? TENANT_SINGLE : TENANT_USER;
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

interface EnqueueArgs {
  tenant: string;
  sourceKey: string;
  priority?: number;
  batchId?: string | null;
  status?: string;
  runAfter?: Date | null;
  documentId?: string | null;
}

async function enqueue(
  db: PGlite,
  { tenant, sourceKey, priority = 100, batchId = null, status = 'queued', runAfter = null, documentId = null }: EnqueueArgs,
): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `SELECT id FROM rag_enqueue_ingestion_job(
        $1, 'ingest', 'config_upload', $2, NULL, NULL, NULL, NULL, '{}'::jsonb, $3, $4, $5, $6
      )`,
      [tenant, sourceKey, priority, documentId, batchId, status],
    )
  ).rows[0];
  const id = row?.id;
  assert.ok(id);
  if (runAfter) {
    await db.query('UPDATE ingestion_jobs SET run_after = $2 WHERE id = $1', [id, runAfter]);
  }
  return id;
}

async function insertBatch(db: PGlite, mode: DeploymentMode, concurrency = 2): Promise<string> {
  const tenant = tenantFor(mode);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ingestion_batches (id, tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, status)
     VALUES ($1, $2, 'folder', '/tmp/backfill', 100, $3, 'worker', 'pending')`,
    [id, tenant, concurrency],
  );
  return id;
}

async function claimRows(
  db: PGlite,
  worker: string,
  limit: number,
  allowBatch: boolean,
  runner = 'worker',
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM rag_claim_ingestion_jobs($1, $2, $3, $4)`,
    [worker, limit, allowBatch, runner],
  );
  return result.rows.map((r) => r.id);
}

const CLAIM_RPCS = [
  'rag_enqueue_ingestion_job',
  'rag_claim_ingestion_jobs',
  'rag_claim_ingestion_job',
  'rag_heartbeat_ingestion_job',
  'rag_release_ingestion_job',
  'rag_batch_has_room',
] as const;

for (const mode of MODES) {
  describe(`ingestion ledger claim (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, supabaseGrants: true, migrations: true });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('migration 0352 is present on disk', () => {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATION_0352)));
    });

    test('enqueue validates tenant, document and batch', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const badDoc = crypto.randomUUID();
      expectSqlState(
        await tryQuery(db, `SELECT rag_enqueue_ingestion_job($1, 'ingest', 'config_upload', 'x', NULL, NULL, NULL, NULL, '{}'::jsonb, 100, $2::uuid, NULL, 'queued')`, [
          tenant,
          badDoc,
        ]),
        '22023',
      );
      const batchId = await insertBatch(db, mode);
      const otherTenant = mode === 'single-tenant' ? TENANT_USER : TENANT_SINGLE;
      expectSqlState(
        await tryQuery(db, `SELECT rag_enqueue_ingestion_job($1, 'ingest', 'config_upload', 'x', NULL, NULL, NULL, NULL, '{}'::jsonb, 100, NULL, $2::uuid, 'queued')`, [
          otherTenant,
          batchId,
        ]),
        '22023',
      );
      await enqueue(db, { tenant, sourceKey: `ok/${crypto.randomUUID()}` });
    });

    test('skipped_duplicate rows are never claimed', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const id = await enqueue(db, { tenant, sourceKey: `dup/${crypto.randomUUID()}`, status: 'skipped_duplicate' });
      const claimed = await claimRows(db, 'w1', 10, true);
      assert.ok(!claimed.includes(id));
    });

    test('priority and created_at order for queued jobs', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const ids: string[] = [];
      for (const [prio, delay] of [
        [10, 50],
        [100, 10],
        [100, 20],
        [10, 40],
        [100, 30],
      ] as const) {
        const id = await enqueue(db, { tenant, sourceKey: `prio/${crypto.randomUUID()}`, priority: prio });
        ids.push(id);
        await db.query(`UPDATE ingestion_jobs SET created_at = '2020-01-01'::timestamptz + ($2::double precision * interval '1 millisecond') WHERE id = $1`, [
          id,
          delay,
        ]);
      }
      const high = ids.filter((_, i) => [10, 100, 100, 10, 100][i] === 100);
      const order = await claimRows(db, 'prio-worker', 3, true);
      assert.deepEqual(order, [high[0], high[1], high[2]]);
    });

    test('interleaved claims return distinct ids for 60 jobs', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobIds: string[] = [];
      for (let i = 0; i < 60; i++) {
        jobIds.push(await enqueue(db, { tenant, sourceKey: `bulk/${i}` }));
      }
      const seen = new Set<string>();
      const limits = [1, 2, 3, 1, 2, 3];
      let calls = 0;
      while (seen.size < 60 && calls < 80) {
        const worker = `worker-${calls % 10}`;
        const limit = limits[calls % limits.length] ?? 1;
        for (const id of await claimRows(db, worker, limit, true)) {
          assert.ok(!seen.has(id), `duplicate claim ${id}`);
          seen.add(id);
          await db.query(`UPDATE ingestion_jobs SET status = 'ready', locked_by = NULL, lease_until = NULL WHERE id = $1`, [id]);
        }
        calls += 1;
      }
      assert.equal(seen.size, 60);
    });

    test('run_after defers claim until due', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const future = new Date(Date.now() + 60_000);
      const id = await enqueue(db, { tenant, sourceKey: `later/${crypto.randomUUID()}`, runAfter: future });
      const beforeDue = await claimRows(db, 'later-worker', 5, true);
      assert.ok(!beforeDue.includes(id));
      await db.query("UPDATE ingestion_jobs SET run_after = now() - interval '1 second' WHERE id = $1", [id]);
      const afterDue = await claimRows(db, 'later-worker', 5, true);
      assert.ok(afterDue.includes(id));
    });

    test('expired lease reclaims with retry and reservations released; fails after max_retries', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await enqueue(db, { tenant, sourceKey: `lease/${crypto.randomUUID()}` });
      await claimRows(db, 'owner', 1, true);
      await db.query(
        `INSERT INTO rag_parse_budget_reservations (job_id, attempt_no, tenant_key, month, pages, kind, state)
         VALUES ($1, 1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 5, 'parse', 'open')`,
        [jobId, tenant],
      );
      await db.query(
        `INSERT INTO rag_parse_budget_usage (tenant_key, month, pages_reserved) VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 5)
         ON CONFLICT (tenant_key, month) DO UPDATE SET pages_reserved = rag_parse_budget_usage.pages_reserved + 5`,
        [tenant],
      );
      await db.query(
        `UPDATE ingestion_jobs SET status = 'parsing', stage = 'parsing', lease_until = now() - interval '1 second', retries = 0 WHERE id = $1`,
        [jobId],
      );
      const reclaimed = await claimRows(db, 'reclaimer', 1, true);
      assert.deepEqual(reclaimed, [jobId]);
      const mid = (await db.query<{ retries: number; status: string }>('SELECT retries, status FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
      assert.equal(mid?.retries, 1);
      assert.equal(mid?.status, 'parsing');
      const open = (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM rag_parse_budget_reservations WHERE job_id = $1 AND state = 'open'`,
          [jobId],
        )
      ).rows[0]?.n;
      assert.equal(open, 0);
      await db.query(
        `UPDATE ingestion_jobs SET lease_until = now() - interval '1 second', locked_by = 'x', retries = 3 WHERE id = $1`,
        [jobId],
      );
      assert.deepEqual(await claimRows(db, 'fail', 1, true), []);
      const terminal = (
        await db.query<{ status: string; error_class: string; error: string; dead_letter_at: string | null }>(
          'SELECT status, error_class, error, dead_letter_at::text FROM ingestion_jobs WHERE id = $1',
          [jobId],
        )
      ).rows[0];
      assert.equal(terminal?.status, 'failed');
      assert.equal(terminal?.error_class, 'lease_expired');
      assert.equal(terminal?.error, 'lease expired');
      assert.ok(terminal?.dead_letter_at);
    });

    test('release resumes at stored stage', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await enqueue(db, { tenant, sourceKey: `resume/${crypto.randomUUID()}` });
      await claimRows(db, 'w', 1, true);
      await db.query(`UPDATE ingestion_jobs SET status = 'chunking', stage = 'chunk', stage_state = '{"cursor":1}'::jsonb WHERE id = $1`, [jobId]);
      const released = (
        await db.query<{ rag_release_ingestion_job: boolean }>('SELECT rag_release_ingestion_job($1, $2)', [jobId, 'w'])
      ).rows[0]?.rag_release_ingestion_job;
      assert.equal(released, true);
      const [claimed] = await claimRows(db, 'w2', 1, true);
      assert.equal(claimed, jobId);
      const row = (await db.query<{ status: string; stage: string }>('SELECT status, stage FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
      assert.deepEqual(row, { status: 'chunking', stage: 'chunk' });
    });

    test('batch concurrency, allow_batch slot rule, named claim, heartbeat and release', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const batchId = await insertBatch(db, mode, 2);
      const batchJobIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        batchJobIds.push(await enqueue(db, { tenant, sourceKey: `batch/${i}`, batchId, priority: 10 }));
      }
      let maxLive = 0;
      for (let round = 0; round < 20; round++) {
        const claimed = await claimRows(db, `b-${round}`, 5, true);
        const live = (
          await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND lease_until > now() AND status <> 'queued'`,
            [batchId],
          )
        ).rows[0]?.n;
        maxLive = Math.max(maxLive, live ?? 0);
        assert.ok((live ?? 0) <= 2);
        for (const id of claimed) {
          await db.query(`UPDATE ingestion_jobs SET status = 'ready', locked_by = NULL, lease_until = NULL WHERE id = $1`, [id]);
        }
      }
      assert.ok(maxLive >= 1);

      const inc = await enqueue(db, { tenant, sourceKey: `inc/${crypto.randomUUID()}`, priority: 100 });
      await enqueue(db, { tenant, sourceKey: `inc-batch/${crypto.randomUUID()}`, batchId, priority: 200 });
      const noBatch = await claimRows(db, 'inc-only', 1, false);
      assert.ok(noBatch.includes(inc));

      const queuedId = await enqueue(db, { tenant, sourceKey: `named/${crypto.randomUUID()}` });
      const one = (await db.query<{ id: string; runner: string }>(`SELECT id, runner FROM rag_claim_ingestion_job($1, 'ray-a', 'ray')`, [queuedId])).rows[0];
      assert.equal(one?.id, queuedId);
      assert.equal(one?.runner, 'ray');
      const second = (await db.query<{ id: string | null }>(`SELECT id FROM rag_claim_ingestion_job($1, 'ray-b', 'ray')`, [queuedId])).rows[0]?.id;
      assert.equal(second, null);

      const hbJob = await enqueue(db, { tenant, sourceKey: `hb/${crypto.randomUUID()}` });
      await db.query(`SELECT id FROM rag_claim_ingestion_job($1, 'hb-owner', 'worker')`, [hbJob]);
      const before = (
        await db.query<{ lease_until: string }>('SELECT lease_until::text FROM ingestion_jobs WHERE id = $1', [hbJob])
      ).rows[0]?.lease_until;
      await db.query(`SELECT pg_sleep(0.01)`);
      assert.equal(
        (await db.query<{ ok: boolean }>('SELECT rag_heartbeat_ingestion_job($1, $2) AS ok', [hbJob, 'hb-owner'])).rows[0]?.ok,
        true,
      );
      assert.equal(
        (await db.query<{ ok: boolean }>('SELECT rag_heartbeat_ingestion_job($1, $2) AS ok', [hbJob, 'other'])).rows[0]?.ok,
        false,
      );
      const after = (
        await db.query<{ lease_until: string }>('SELECT lease_until::text FROM ingestion_jobs WHERE id = $1', [hbJob])
      ).rows[0]?.lease_until;
      assert.notEqual(before, after);

      const relJob = await enqueue(db, { tenant, sourceKey: `rel/${crypto.randomUUID()}` });
      await db.query(`SELECT id FROM rag_claim_ingestion_job($1, 'rel-owner', 'worker')`, [relJob]);
      await db.query(`UPDATE ingestion_jobs SET stage = 'parsing', stage_state = '{"x":1}'::jsonb WHERE id = $1`, [relJob]);
      const retriesBefore = (await db.query<{ retries: number }>('SELECT retries FROM ingestion_jobs WHERE id = $1', [relJob])).rows[0]?.retries;
      assert.equal(
        (await db.query<{ ok: boolean }>('SELECT rag_release_ingestion_job($1, $2) AS ok', [relJob, 'rel-owner'])).rows[0]?.ok,
        true,
      );
      assert.equal(
        (await db.query<{ ok: boolean }>('SELECT rag_release_ingestion_job($1, $2) AS ok', [relJob, 'wrong'])).rows[0]?.ok,
        false,
      );
      const relRow = (
        await db.query<{ status: string; retries: number; stage: string | null }>(
          'SELECT status, retries, stage FROM ingestion_jobs WHERE id = $1',
          [relJob],
        )
      ).rows[0];
      assert.equal(relRow?.status, 'queued');
      assert.equal(relRow?.retries, retriesBefore);
      assert.equal(relRow?.stage, 'parsing');
    });

    test('anon and authenticated get 42501 on ledger RPCs; fake edge can claim with service key', async () => {
      const { db } = fixture;
      for (const fn of CLAIM_RPCS) {
        await asRole(db, 'anon', async () => {
          const sql =
            fn === 'rag_enqueue_ingestion_job'
              ? `${fn}('s:default', 'ingest', 'config_upload', 'deny')`
              : fn === 'rag_claim_ingestion_jobs'
                ? `${fn}('w', 1, true)`
                : fn === 'rag_batch_has_room'
                  ? `${fn}(NULL)`
                  : fn === 'rag_claim_ingestion_job'
                    ? `${fn}(gen_random_uuid(), 'w')`
                    : `${fn}(gen_random_uuid(), 'w')`;
          const err = await tryQuery(db, `SELECT ${sql}`);
          expectSqlState(err, '42501');
        });
        await asRole(db, 'authenticated', async () => {
          const sql =
            fn === 'rag_enqueue_ingestion_job'
              ? `${fn}('${tenantFor(mode)}', 'ingest', 'config_upload', 'deny')`
              : fn === 'rag_claim_ingestion_jobs'
                ? `${fn}('w', 1, true)`
                : fn === 'rag_batch_has_room'
                  ? `${fn}(NULL)`
                  : `${fn}(gen_random_uuid(), 'w')`;
          const err = await tryQuery(db, `SELECT ${sql}`);
          expectSqlState(err, '42501');
        });
      }
      await enqueue(db, { tenant: tenantFor(mode), sourceKey: `edge/${crypto.randomUUID()}` });
      let edge: FakeEdge | undefined;
      try {
        edge = await startFakeEdge({ db });
        const env = fixtureProcessEnv(edge.url);
        const res = await fetch(`${edge.url}/rest/v1/rpc/rag_claim_ingestion_jobs`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_worker: 'edge', p_limit: 1, p_allow_batch: true, p_runner: 'worker' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body));
        assert.equal(body.length, 1);
      } finally {
        await edge?.close();
      }
    });
  });
}