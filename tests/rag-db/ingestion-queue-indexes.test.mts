import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, applyMigrations } from '../../eval/harness/migrations.mts';

const M0421 = 'supabase/migrations/0421_ingestion_queue_indexes.sql';
const MODES: DeploymentMode[] = ['single-tenant'];
const TENANT = 's:default';

function planText(rows: Record<string, string>[]): string {
  return rows
    .map((row) => Object.values(row).join(' '))
    .join('\n');
}

function explainPlan(rows: Record<string, string>[], indexName: string): void {
  const plan = planText(rows);
  assert.match(plan, new RegExp(indexName, 'i'), `expected plan to use ${indexName}, got:\n${plan}`);
}

for (const mode of MODES) {
  describe(`ingestion queue indexes (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      await applyMigrations(db, mode);
      await applyMigrationFiles(db, [M0421]);
      await db.query(`INSERT INTO ingestion_jobs (tenant_key, kind, source_key, status, priority)
        SELECT $1, 'ingest', 'bulk-' || g, 'queued', (g % 5)
          FROM generate_series(1, 200) g`, [TENANT]);
      const active = crypto.randomUUID();
      await db.query(
        `INSERT INTO ingestion_jobs (id, tenant_key, kind, source_key, status, lease_until, priority)
         VALUES ($1, $2, 'ingest', $3, 'parsing', now() - interval '1 minute', 50)`,
        [active, TENANT, `active-${active}`],
      );
    });

    after(async () => {
      await db.close();
    });

    test('claim partial indexes exist', async () => {
      const names = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'ingestion_jobs'
            AND indexname IN (
              'ingestion_jobs_claim_queued_idx',
              'ingestion_jobs_claim_active_lease_idx',
              'ingestion_jobs_list_created_idx'
            )
          ORDER BY 1`,
      );
      assert.deepEqual(
        names.rows.map((row) => row.indexname),
        [
          'ingestion_jobs_claim_active_lease_idx',
          'ingestion_jobs_claim_queued_idx',
          'ingestion_jobs_list_created_idx',
        ],
      );
    });

    test('queued claim index matches SKIP LOCKED claim predicate', async () => {
      const def = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ingestion_jobs_claim_queued_idx'`,
      );
      const indexdef = def.rows[0]?.indexdef ?? '';
      assert.match(indexdef, /priority DESC, created_at/i);
      assert.match(indexdef, /'ingest'/i);
      assert.match(indexdef, /'dry_run'/i);
      assert.match(indexdef, /status = 'queued'/i);
      await db.exec('SET enable_seqscan = off');
      const plan = await db.query<Record<string, string>>(
        `EXPLAIN (FORMAT TEXT)
           SELECT j.id FROM ingestion_jobs j
          WHERE j.deleted_at IS NULL
            AND j.kind IN ('ingest', 'dry_run')
            AND j.status = 'queued'
          ORDER BY j.priority DESC, j.created_at
          LIMIT 1`,
      );
      const text = planText(plan.rows);
      assert.doesNotMatch(text, /Seq Scan on ingestion_jobs/i, text);
    });

    test('lease reclaim uses a partial index, not a sequential scan', async () => {
      await db.exec('SET enable_seqscan = off');
      const plan = await db.query<Record<string, string>>(
        `EXPLAIN (FORMAT TEXT)
           SELECT j.id FROM ingestion_jobs j
          WHERE j.deleted_at IS NULL
            AND j.kind IN ('ingest', 'dry_run')
            AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
            AND j.lease_until IS NOT NULL
            AND j.lease_until < now()
          ORDER BY j.lease_until
          LIMIT 1`,
      );
      const text = planText(plan.rows);
      assert.match(text, /Index (Only )?Scan/i, text);
      assert.doesNotMatch(text, /Seq Scan on ingestion_jobs/i, text);
    });

    test('operator listing uses ingestion_jobs_list_created_idx', async () => {
      await db.exec('SET enable_seqscan = off');
      const plan = await db.query<Record<string, string>>(
        `EXPLAIN (FORMAT TEXT)
           SELECT j.id FROM ingestion_jobs j
          WHERE j.deleted_at IS NULL
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT 50`,
      );
      explainPlan(plan.rows, 'ingestion_jobs_list_created_idx');
    });
  });
}