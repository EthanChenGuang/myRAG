import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, applyMigrations } from '../../eval/harness/migrations.mts';

const M0420 = 'supabase/migrations/0420_ingestion_queue_retention.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const TENANT = 's:default';

async function insertTerminalJob(db: PGlite, status: string, updatedAt: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ingestion_jobs (id, tenant_key, kind, source_key, status, updated_at)
     VALUES ($1, $2, 'ingest', $3, $4, $5::timestamptz)`,
    [id, TENANT, `key-${id}`, status, updatedAt],
  );
  return id;
}

for (const mode of MODES) {
  describe(`ingestion queue retention (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      await applyMigrations(db, mode);
      await applyMigrationFiles(db, [M0420]);
    });

    after(async () => {
      await db.close();
    });

    test('rag_purge_stale_ingestion_jobs archives and deletes old terminal rows idempotently', async () => {
      const oldReady = await insertTerminalJob(db, 'ready', '2019-01-01T00:00:00Z');
      const freshReady = await insertTerminalJob(db, 'ready', new Date().toISOString());
      const active = crypto.randomUUID();
      await db.query(
        `INSERT INTO ingestion_jobs (id, tenant_key, kind, source_key, status, updated_at)
         VALUES ($1, $2, 'ingest', $3, 'parsing', now())`,
        [active, TENANT, `active-${active}`],
      );

      const first = await db.query<{ payload: { purged: number } }>(
        `SELECT rag_purge_stale_ingestion_jobs(90, 100) AS payload`,
      );
      assert.equal((first.rows[0]?.payload as { purged: number }).purged, 1);

      const gone = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM ingestion_jobs WHERE id = $1', [oldReady])).rows[0]?.n;
      assert.equal(gone, 0);
      const archived = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM ingestion_jobs_archive WHERE id = $1', [oldReady])).rows[0]?.n;
      assert.equal(archived, 1);

      const stillThere = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM ingestion_jobs WHERE id = ANY($1::uuid[])', [[freshReady, active]])).rows[0]?.n;
      assert.equal(stillThere, 2);

      const second = await db.query<{ purged: number }>(
        `SELECT (rag_purge_stale_ingestion_jobs(90, 100)->>'purged')::int AS purged`,
      );
      assert.equal(second.rows[0]?.purged, 0);
    });

    test('anon cannot execute the purge RPC', async () => {
      await db.exec('SET ROLE anon');
      try {
        const err = await db.query(`SELECT rag_purge_stale_ingestion_jobs(30, 10)`).catch((e: Error) => e);
        assert.ok(err instanceof Error);
        assert.match(String(err), /42501|permission denied|insufficient_privilege/i);
      } finally {
        await db.exec('RESET ROLE');
      }
    });
  });
}