import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, applyMigrations } from '../../eval/harness/migrations.mts';

const M0415 = 'supabase/migrations/0415_ingestion_dead_letter.sql';
const MODES: DeploymentMode[] = ['single-tenant'];
const TENANT = 's:default';
const ADMIN = '00000000-0000-4000-8000-0000000000c1';

async function enqueueJob(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ingestion_jobs (id, tenant_key, kind, source_key, status, locked_by, lease_until, retries, max_retries)
     VALUES ($1, $2, 'ingest', $3, 'parsing', 'w1', now() + interval '5 minutes', 2, 2)`,
    [id, TENANT, `k-${id}`],
  );
  return id;
}

for (const mode of MODES) {
  describe(`ingestion dead letter (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      await applyMigrations(db, mode);
      await applyMigrationFiles(db, [M0415]);
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ADMIN, 'admin@example.invalid']);
      await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
    });

    after(async () => {
      await db.close();
    });

    test('exhausted retries land in failed with dead_letter_at and last_error', async () => {
      const jobId = await enqueueJob(db);
      const row = (
        await db.query<{ status: string; error: string | null; dead_letter_at: string | null }>(
          `SELECT status, error, dead_letter_at::text FROM rag_fail_ingestion_job($1, 'w1', 'transient', true, 'stage_timeout')`,
          [jobId],
        )
      ).rows[0];
      assert.equal(row?.status, 'failed');
      assert.equal(row?.error, 'stage_timeout');
      assert.ok(row?.dead_letter_at);

      const count = (await db.query<{ n: string }>(`SELECT rag_count_ingestion_dead_letters(NULL)::text AS n`)).rows[0]?.n;
      assert.equal(count, '1');
    });

    test('rag_retry_ingestion_job clears dead letter state', async () => {
      const jobId = await enqueueJob(db);
      await db.query(`SELECT rag_fail_ingestion_job($1, 'w1', 'transient', true, 'boom')`, [jobId]);
      const admin = '00000000-0000-4000-8000-0000000000c1';
      const retried = (
        await db.query<{ status: string; dead_letter_at: string | null }>(
          `SELECT status, dead_letter_at FROM rag_retry_ingestion_job($1, $2)`,
          [jobId, admin],
        )
      ).rows[0];
      assert.equal(retried?.status, 'queued');
      assert.equal(retried?.dead_letter_at, null);
    });
  });
}