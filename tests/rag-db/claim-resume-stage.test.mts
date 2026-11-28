import { after, before, describe, test } from 'node:test';
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
const MIGRATION_0810 = 'supabase/migrations/0810_chunk_translations.sql';
const MIGRATION_FIX = 'supabase/migrations/0865_claim_resume_status_for_stage.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const WORKER = 'sidecar-ingest';

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `u:${TWO_TENANT_IDS.userA}`;
}

async function enqueue(db: PGlite, tenant: string): Promise<string> {
  const key = `claim-resume/${crypto.randomUUID()}`;
  const row = (
    await db.query<{ id: string }>(
      `SELECT (rag_enqueue_ingestion_job(p_tenant_key => $1, p_kind => 'ingest', p_source => 'config_upload', p_source_key => $2,
         p_file_sha256 => $3, p_filename => 'doc.pdf', p_mime_type => 'application/pdf')).id`,
      [tenant, key, crypto.createHash('sha256').update(key).digest('hex')],
    )
  ).rows[0];
  assert.ok(row?.id);
  return row.id;
}

async function claimAll(db: PGlite, limit: number): Promise<Map<string, string>> {
  const result = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM rag_claim_ingestion_jobs($1, $2, false, 'worker')`,
    [WORKER, limit],
  );
  return new Map(result.rows.map((row) => [row.id, row.status]));
}

/** Claims the job, advances it to the given stage and fails it retryably: status queued, stage kept, claimable now. */
async function requeueAtStage(db: PGlite, jobId: string, stage: string, status: string): Promise<void> {
  await db.query(`SELECT rag_claim_ingestion_job($1, $2, 'worker')`, [jobId, WORKER]);
  await db.query(`SELECT rag_advance_ingestion_job($1, $2, $3, $4)`, [jobId, WORKER, stage, status]);
  await db.query(`SELECT rag_fail_ingestion_job($1, $2, 'worker_error', true)`, [jobId, WORKER]);
  await db.query(`UPDATE ingestion_jobs SET run_after = now() - interval '1 second' WHERE id = $1`, [jobId]);
  const row = (await db.query<{ status: string; stage: string }>('SELECT status, stage FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
  assert.deepEqual(row, { status: 'queued', stage });
}

async function clearQueue(db: PGlite): Promise<void> {
  await db.query(`UPDATE ingestion_jobs SET status = 'failed', locked_by = NULL, lease_until = NULL WHERE status <> 'failed'`);
}

for (const mode of MODES) {
  describe(`claim of a requeued job resumes at its stage's status (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    const tenant = tenantFor(mode);

    before(async () => {
      fixture =
        mode === 'multi-tenant'
          ? await createTwoTenantDatabase()
          : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
    });

    after(async () => {
      await fixture.db.close();
    });

    test('a job requeued at parse is claimed as parsing and does not block the other queued jobs', async () => {
      await clearQueue(db);
      const requeued = await enqueue(db, tenant);
      await requeueAtStage(db, requeued, 'parse', 'parsing');
      const fresh = await enqueue(db, tenant);
      const claimed = await claimAll(db, 5);
      assert.equal(claimed.get(requeued), 'parsing');
      assert.equal(claimed.get(fresh), 'preflight');
    });

    test('later stages map to their status; begin and terminal stages resume at preflight', async () => {
      for (const [stage, status, expected] of [
        ['chunk', 'chunking', 'chunking'],
        ['embed', 'embedding', 'embedding'],
        ['preflight', 'preflight', 'preflight'],
      ] as const) {
        await clearQueue(db);
        const id = await enqueue(db, tenant);
        await requeueAtStage(db, id, stage, status);
        assert.equal((await claimAll(db, 1)).get(id), expected, stage);
      }
      await clearQueue(db);
      const begin = await enqueue(db, tenant);
      await db.query(`UPDATE ingestion_jobs SET stage = 'begin' WHERE id = $1`, [begin]);
      assert.equal((await claimAll(db, 1)).get(begin), 'preflight');
    });

    test('the single-job claim resumes the same way', async () => {
      await clearQueue(db);
      const id = await enqueue(db, tenant);
      await requeueAtStage(db, id, 'parse', 'parsing');
      const row = (await db.query<{ status: string }>(`SELECT (rag_claim_ingestion_job($1, $2, 'worker')).status`, [id, WORKER])).rows[0];
      assert.equal(row?.status, 'parsing');
    });

    test('regression: the 0810 claim body breaks ingestion_jobs_status_check on such a job; the fix restores the claim', async () => {
      await clearQueue(db);
      const id = await enqueue(db, tenant);
      await requeueAtStage(db, id, 'parse', 'parsing');
      const sql0810 = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_0810), 'utf8');
      const claimFns = sql0810.slice(
        sql0810.indexOf('CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job('),
        sql0810.indexOf('CREATE OR REPLACE FUNCTION public.rag_advance_ingestion_job('),
      );
      await db.exec(claimFns);
      await assert.rejects(claimAll(db, 1), /ingestion_jobs_status_check/);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FIX), 'utf8'));
      assert.equal((await claimAll(db, 1)).get(id), 'parsing');
    });

    test('the fix migration is idempotent and keeps the claim functions service_role only', async () => {
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FIX), 'utf8'));
      const grants = await db.query<{ fn: string; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT p.proname AS fn,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rag_claim_ingestion_job', 'rag_claim_ingestion_jobs')`,
      );
      assert.equal(grants.rows.length, 2);
      for (const row of grants.rows) assert.deepEqual({ anon: row.anon, authenticated: row.authenticated, service: row.service }, { anon: false, authenticated: false, service: true }, row.fn);
    });
  });
}
