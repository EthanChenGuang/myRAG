import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';
import { createTwoTenantDatabase, TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

Object.assign(process.env, fixtureProcessEnv('http://127.0.0.1:0'));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const M0354 = 'supabase/migrations/0354_parse_budget.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

type Row = Record<string, unknown>;
type GuardModule = typeof import('@/lib/rag/ingest/guard/cloud-budget');

let guard: GuardModule;

function pgliteRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<Row>(sql, keys.map((key) => args[key]))
        .then((result): RpcResponse => ({ data: result.rows, error: null }))
        .catch((error: unknown): RpcResponse => {
          const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : 'P0001';
          return { data: null, error: { code, message: error instanceof Error ? error.message : String(error) } };
        });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
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

async function insertBatch(db: PGlite, tenant: string, budgetUsd: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ingestion_batches (id, tenant_key, source_kind, source_ref, budget_usd, spent_usd, concurrency, runner, status)
     VALUES ($1, $2, 'folder', '/tmp/backfill', $3, 0, 2, 'worker', 'pending')`,
    [id, tenant, budgetUsd],
  );
  return id;
}

async function usage(db: PGlite, tenant: string): Promise<{ pages_reserved: number; pages_used: number; vlm_pages_used: number }> {
  const row = (
    await db.query<{ pages_reserved: number; pages_used: number; vlm_pages_used: number }>(
      `SELECT pages_reserved, pages_used, vlm_pages_used FROM rag_parse_budget_usage
       WHERE tenant_key = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
      [tenant],
    )
  ).rows[0];
  return row ?? { pages_reserved: 0, pages_used: 0, vlm_pages_used: 0 };
}

function context(jobId: string, pages: number, attemptNo = 1, estUsd = 0.01) {
  return { jobId, attemptNo, pages, estUsd, routing: 'tiered' as const, queued: true };
}

for (const mode of MODES) {
  describe(`cloud guard against the budget functions (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let tenant: string;

    before(async () => {
      guard = await import('@/lib/rag/ingest/guard/cloud-budget');
      fixture =
        mode === 'multi-tenant'
          ? await createTwoTenantDatabase()
          : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
      tenant = mode === 'single-tenant' ? 's:default' : `u:${TWO_TENANT_IDS.userA}`;
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, M0354), 'utf8'));
      guard.setCloudGuardDepsForTests({ db: () => pgliteRpc(db) });
    });

    after(async () => {
      guard.resetCloudGuardDepsForTests();
      await fixture.db.close();
    });

    beforeEach(async () => {
      process.env.RAG_PARSER_ALLOW_CLOUD = 'true';
      process.env.RAG_PARSE_PREMIUM_PAGE_BUDGET = '10';
      process.env.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC = '200';
      await db.query('DELETE FROM rag_parse_budget_reservations');
      await db.query('DELETE FROM rag_parse_budget_usage');
    });

    test('two concurrent reservations of 6 pages against a budget of 10 give one ok and one budget_exhausted', async () => {
      const jobA = await insertJob(db, tenant);
      const jobB = await insertJob(db, tenant);
      const results = await Promise.all([guard.reservePremium(context(jobA, 6)), guard.reservePremium(context(jobB, 6))]);
      const outcomes = results.map((result) => (result.ok ? 'ok' : result.reason)).sort();
      assert.deepEqual(outcomes, ['budget_exhausted', 'ok']);
      assert.equal((await usage(db, tenant)).pages_reserved, 6);
    });

    test('settle records the pages sent and frees the rest; release frees a failed reservation', async () => {
      const job = await insertJob(db, tenant);
      const reserved = await guard.reservePremium(context(job, 8));
      assert.ok(reserved.ok && reserved.handle);
      assert.equal(await guard.settle(reserved.handle, 5), true);
      assert.deepEqual(await usage(db, tenant), { pages_reserved: 0, pages_used: 5, vlm_pages_used: 0 });

      const other = await insertJob(db, tenant);
      const second = await guard.reservePremium(context(other, 5));
      assert.ok(second.ok && second.handle);
      assert.equal(await guard.release(second.handle), true);
      assert.deepEqual(await usage(db, tenant), { pages_reserved: 0, pages_used: 5, vlm_pages_used: 0 });
    });

    test('an L3 reservation counts against the same budget and settles into vlm_pages_used', async () => {
      const job = await insertJob(db, tenant);
      const reserved = await guard.reserveVlm(context(job, 4));
      assert.ok(reserved.ok && reserved.handle);
      assert.equal(await guard.settle(reserved.handle, 3), true);
      assert.deepEqual(await usage(db, tenant), { pages_reserved: 0, pages_used: 0, vlm_pages_used: 3 });
      const parse = await guard.reservePremium(context(await insertJob(db, tenant), 8));
      assert.deepEqual(parse, { ok: false, reason: 'budget_exhausted' });
    });

    test('a batch with 0.10 USD left refuses a 0.20 USD estimate and gives the pages back', async () => {
      const batch = await insertBatch(db, tenant, 0.1);
      const job = await insertJob(db, tenant, batch);
      const result = await guard.reservePremium(context(job, 3, 1, 0.2));
      assert.deepEqual(result, { ok: false, reason: 'batch_budget_exhausted' });
      assert.deepEqual(await usage(db, tenant), { pages_reserved: 0, pages_used: 0, vlm_pages_used: 0 });
      const within = await guard.reservePremium(context(job, 3, 2, 0.05));
      assert.equal(within.ok, true);
    });

    test('readMonthlyUsage returns this month for the tenant', async () => {
      const job = await insertJob(db, tenant);
      await guard.reservePremium(context(job, 2));
      const rows = await guard.readMonthlyUsage(tenant);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.tenant_key, tenant);
      assert.equal(rows[0]?.pages_reserved, 2);
    });

    test('cloud off refuses before any statement runs', async () => {
      process.env.RAG_PARSER_ALLOW_CLOUD = 'false';
      const job = await insertJob(db, tenant);
      assert.deepEqual(await guard.reservePremium(context(job, 1)), { ok: false, reason: 'cloud_not_allowed' });
      assert.deepEqual(await usage(db, tenant), { pages_reserved: 0, pages_used: 0, vlm_pages_used: 0 });
    });
  });
}
