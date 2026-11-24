import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { createTwoTenantDatabase, TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { BackfillDryRunReportSchema } from '@/lib/rag-eval/contracts.generated';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MIGRATION_0356 = 'supabase/migrations/0356_backfill.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const TENANT_SINGLE = 's:default';
const TENANT_USER_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_ORG_O = `o:${TWO_TENANT_IDS.orgO}`;

const BACKFILL_RPCS = [
  'rag_create_ingestion_batch',
  'rag_enqueue_backfill_jobs',
  'rag_existing_file_hashes',
  'rag_batch_progress',
  'rag_update_ingestion_batch',
  'rag_list_batch_jobs',
  'rag_record_embed_batch',
  'rag_update_embed_batch',
  'rag_open_embed_batches',
] as const;

const SAMPLE_DRY_RUN_REPORT = {
  budget_usd: 10.0,
  class_shares: { text_pdf: 0.7 },
  duplicates: { already_existing: 2, in_inventory: 3 },
  embedding_cost_by_profile_usd: { 'general@1': 1.0 },
  fits_budget: true,
  inventory: { bytes: 50_000_000, files: 100, pages_estimated: 500 },
  projected_cost: { embeddings_usd: 1.0, premium_parse_usd: 2.0, total_usd: 3.5, vlm_usd: 0.5 },
  projected_l2_pages: 40,
  projected_l3_pages: 5,
  projected_pages_by_tier: { fast: 300, premium: 50, structured: 150 },
  projected_wall_time_s: 3600.0,
  sample_size_by_class: { text_pdf: 5 },
} as const;

type Role = 'anon' | 'authenticated' | 'service_role';

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? TENANT_SINGLE : TENANT_USER_A;
}

async function applyBackfillMigration(db: PGlite): Promise<void> {
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION_0356), 'utf8'));
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

async function createBatch(
  db: PGlite,
  tenant: string,
  concurrency = 2,
): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `SELECT id FROM rag_create_ingestion_batch($1, 'folder', '/data/backfill', 50, $2, 'worker', 'test')`,
      [tenant, concurrency],
    )
  ).rows[0];
  assert.ok(row?.id);
  return row.id;
}

function jobPayload(
  index: number,
  overrides: Partial<{
    kind: string;
    source_key: string;
    status: string;
  }> = {},
): Record<string, unknown> {
  return {
    kind: overrides.kind ?? 'ingest',
    source: 'config_upload',
    source_key: overrides.source_key ?? `src/${index}`,
    file_sha256: crypto.createHash('sha256').update(`file-${index}`).digest('hex'),
    filename: `doc-${index}.pdf`,
    mime_type: 'application/pdf',
    original_ref: { path: `/tmp/doc-${index}.pdf` },
    settings: {},
    status: overrides.status ?? 'queued',
  };
}

async function enqueueBackfill(db: PGlite, batchId: string, jobs: Record<string, unknown>[]): Promise<number> {
  const row = (
    await db.query<{ rag_enqueue_backfill_jobs: number }>(`SELECT rag_enqueue_backfill_jobs($1::uuid, $2::jsonb)`, [
      batchId,
      JSON.stringify(jobs),
    ])
  ).rows[0];
  return row?.rag_enqueue_backfill_jobs ?? 0;
}

async function claimRows(db: PGlite, worker: string, limit: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(`SELECT id FROM rag_claim_ingestion_jobs($1, $2, true, 'worker')`, [worker, limit]);
  return result.rows.map((r) => r.id);
}

async function firstProfileId(db: PGlite): Promise<string> {
  const row = (await db.query<{ id: string }>('SELECT id FROM embedding_profiles ORDER BY id LIMIT 1')).rows[0];
  assert.ok(row?.id, 'embedding_profiles fixture row');
  return row.id;
}

for (const mode of MODES) {
  describe(`backfill ledger (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;

    before(async () => {
      fixture =
        mode === 'multi-tenant'
          ? await createTwoTenantDatabase()
          : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
      await applyBackfillMigration(db);
    });

    after(async () => {
      await fixture.db.close();
    });

    test('rag_create_ingestion_batch refuses an invalid tenant key with SQLSTATE 22023', async () => {
      const bad = mode === 'single-tenant' ? TENANT_USER_A : 'not-a-tenant';
      expectSqlState(await tryQuery(db, `SELECT id FROM rag_create_ingestion_batch($1, 'folder', '/x', NULL, 1, 'worker')`, [bad]), '22023');
    });

    test('bulk enqueue is re-entrant and honours kind in the unique key', async () => {
      const tenant = tenantFor(mode);
      const batchId = await createBatch(db, tenant);
      const jobs = Array.from({ length: 100 }, (_, i) => jobPayload(i));
      const first = await enqueueBackfill(db, batchId, jobs);
      const second = await enqueueBackfill(db, batchId, jobs);
      assert.equal(first, 100);
      assert.equal(second, 0);
      const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1', [batchId])).rows[0]?.n;
      assert.equal(count, 100);

      const sourceKey = `dual/${crypto.randomUUID()}`;
      await enqueueBackfill(db, batchId, [jobPayload(0, { kind: 'dry_run', source_key: sourceKey }), jobPayload(0, { kind: 'ingest', source_key: sourceKey })]);
      const dual = (
        await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND source_key = $2`, [batchId, sourceKey])
      ).rows[0]?.n;
      assert.equal(dual, 2);
    });

    test('enqueued jobs use priority 10, null document_id and the batch tenant', async () => {
      const tenant = tenantFor(mode);
      const batchId = await createBatch(db, tenant);
      await enqueueBackfill(db, batchId, [jobPayload(1)]);
      const row = (
        await db.query<{ priority: number; document_id: string | null; tenant_key: string }>(
          'SELECT priority, document_id::text, tenant_key FROM ingestion_jobs WHERE batch_id = $1',
          [batchId],
        )
      ).rows[0];
      assert.deepEqual(row, { priority: 10, document_id: null, tenant_key: tenant });
    });

    test('batch claims respect concurrency (interleaved)', async () => {
      const tenant = tenantFor(mode);
      const batchId = await createBatch(db, tenant, 2);
      for (let i = 0; i < 8; i++) {
        await enqueueBackfill(db, batchId, [jobPayload(i + 100, { source_key: `conc/${i}` })]);
      }
      let maxLive = 0;
      for (let round = 0; round < 15; round++) {
        const claimed = await claimRows(db, `bf-${round}`, 4);
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
    });
  });
}

describe('backfill ledger (multi-tenant dedupe)', () => {
  let fixture: FixtureDatabase;
  let db: PGlite;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    await applyBackfillMigration(db);
  });

  after(async () => {
    await fixture.db.close();
  });

  test('rag_existing_file_hashes is tenant-scoped and caps at 1000 hashes', async () => {
    const h1 = 'a'.repeat(64);
    const h2 = 'b'.repeat(64);
    await db.query(`UPDATE documents SET file_sha256 = $1, status = 'ready', is_current = true WHERE id = $2`, [h1, TWO_TENANT_IDS.docA]);
    await db.query(`UPDATE documents SET file_sha256 = $1, status = 'ready', is_current = true WHERE id = $2`, [h1, TWO_TENANT_IDS.docO]);

    const hits = (
      await db.query<{ id: string; file_sha256: string; tenant_key: string }>(
        'SELECT id, file_sha256, tenant_key FROM rag_existing_file_hashes($1, $2::text[])',
        [TENANT_USER_A, [h1, h2]],
      )
    ).rows;
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, TWO_TENANT_IDS.docA);
    assert.equal(hits[0]?.file_sha256, h1);

    const tooMany = Array.from({ length: 1001 }, (_, i) => i.toString(16).padStart(64, '0'));
    expectSqlState(await tryQuery(db, 'SELECT id FROM rag_existing_file_hashes($1, $2::text[])', [TENANT_USER_A, tooMany]), '22023');
  });
});

for (const mode of MODES) {
  describe(`backfill batch monitor (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;

    before(async () => {
      fixture =
        mode === 'multi-tenant'
          ? await createTwoTenantDatabase()
          : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
      await applyBackfillMigration(db);
    });

    after(async () => {
      await fixture.db.close();
    });

    test('progress, update, list jobs and embed-batch tracking', async () => {
      const tenant = tenantFor(mode);
      const batchId = await createBatch(db, tenant);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        await enqueueBackfill(db, batchId, [jobPayload(200 + i, { source_key: `prog/${i}` })]);
        const row = (await db.query<{ id: string }>('SELECT id FROM ingestion_jobs WHERE batch_id = $1 ORDER BY created_at, id', [batchId])).rows[i];
        assert.ok(row?.id);
        ids.push(row.id);
      }

      const [claimed] = await claimRows(db, 'prog', 1);
      assert.ok(claimed);
      await db.query(`UPDATE ingestion_jobs SET status = 'ready', locked_by = NULL, lease_until = NULL WHERE id = $1`, [claimed]);

      const progress = (
        await db.query<{ rag_batch_progress: { spent_usd: number; leased: number; counts: Record<string, Record<string, number>> } }>(
          'SELECT rag_batch_progress($1::uuid)',
          [batchId],
        )
      ).rows[0]?.rag_batch_progress;
      assert.ok(progress);
      assert.equal(typeof progress.spent_usd, 'number');
      assert.equal(progress.counts.ingest?.ready, 1);
      assert.equal(progress.counts.ingest?.queued, 4);

      const report = structuredClone(SAMPLE_DRY_RUN_REPORT);
      BackfillDryRunReportSchema.parse(report);
      await db.query(`SELECT rag_update_ingestion_batch($1::uuid, 'sampling', $2::jsonb, NULL::jsonb)`, [batchId, JSON.stringify(report)]);
      await db.query(`SELECT rag_update_ingestion_batch($1::uuid, 'running', NULL::jsonb, NULL::jsonb)`, [batchId]);
      await db.query(`SELECT rag_update_ingestion_batch($1::uuid, 'completed', NULL::jsonb, '{"files_done":5}'::jsonb)`, [batchId]);
      const batch = (
        await db.query<{ status: string; dry_run_report: unknown; totals: unknown }>(
          'SELECT status, dry_run_report, totals FROM ingestion_batches WHERE id = $1',
          [batchId],
        )
      ).rows[0];
      assert.equal(batch?.status, 'completed');
      BackfillDryRunReportSchema.parse(batch?.dry_run_report);
      assert.deepEqual(batch?.totals, { files_done: 5 });

      const page1 = await db.query<{ id: string }>(
        `SELECT id FROM rag_list_batch_jobs($1::uuid, 'queued', NULL::uuid, 2)`,
        [batchId],
      );
      assert.equal(page1.rows.length, 2);
      const cursor = page1.rows[1]?.id;
      const page2 = await db.query<{ id: string }>(
        `SELECT id FROM rag_list_batch_jobs($1::uuid, 'queued', $2::uuid, 10)`,
        [batchId, cursor],
      );
      assert.ok(page2.rows.every((r) => !page1.rows.some((p) => p.id === r.id)));

      const profileId = await firstProfileId(db);
      const embedId = (
        await db.query<{ id: string }>(
          `SELECT id FROM rag_record_embed_batch($1::uuid, $2, 'openai', 'prov-1', 'in-1', 10, 'validating')`,
          [batchId, profileId],
        )
      ).rows[0]?.id;
      assert.ok(embedId);
      await db.query(`SELECT rag_update_embed_batch($1::uuid, 'in_progress', 'prov-1', 'out-1', NULL, NULL)`, [embedId]);
      const openMid = (await db.query<{ id: string }>(`SELECT id FROM rag_open_embed_batches($1::uuid)`, [batchId])).rows;
      assert.ok(openMid.some((r) => r.id === embedId));

      await db.query(`SELECT rag_update_embed_batch($1::uuid, 'completed', 'prov-1', 'out-1', NULL, NULL)`, [embedId]);
      const openDone = (await db.query<{ id: string }>(`SELECT id FROM rag_open_embed_batches($1::uuid)`, [batchId])).rows;
      assert.equal(openDone.length, 0);

      const failedId = (
        await db.query<{ id: string }>(
          `SELECT id FROM rag_record_embed_batch($1::uuid, $2, 'openai', 'prov-2', 'in-2', 3, 'failed')`,
          [batchId, profileId],
        )
      ).rows[0]?.id;
      assert.ok(failedId);
      const openFailed = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM rag_open_embed_batches($1::uuid)`, [batchId])).rows;
      assert.deepEqual(openFailed, [{ id: failedId, status: 'failed' }]);
    });

    test('anon and authenticated get 42501 on every backfill RPC', async () => {
      const tenant = tenantFor(mode);
      const batchId = await createBatch(db, tenant);
      const profileId = await firstProfileId(db);
      for (const fn of BACKFILL_RPCS) {
        await asRole(db, 'anon', async () => {
          const err = await tryQuery(
            db,
            fn === 'rag_create_ingestion_batch'
              ? `SELECT id FROM ${fn}('${tenant}', 'folder', '/x', NULL, 1)`
              : fn === 'rag_enqueue_backfill_jobs'
                ? `SELECT ${fn}($1::uuid, '[]'::jsonb)`
                : fn === 'rag_existing_file_hashes'
                  ? `SELECT id FROM ${fn}('${tenant}', ARRAY['${'c'.repeat(64)}']::text[])`
                  : fn === 'rag_batch_progress'
                    ? `SELECT ${fn}($1::uuid)`
                    : fn === 'rag_update_ingestion_batch'
                      ? `SELECT id FROM ${fn}($1::uuid, 'running', NULL, NULL)`
                      : fn === 'rag_list_batch_jobs'
                        ? `SELECT id FROM ${fn}($1::uuid, NULL, NULL, 1)`
                        : fn === 'rag_record_embed_batch'
                          ? `SELECT id FROM ${fn}($1::uuid, '${profileId}', 'openai', 'x', 'y', 1, 'validating')`
                          : fn === 'rag_update_embed_batch'
                            ? `SELECT id FROM ${fn}(gen_random_uuid(), 'failed', NULL, NULL, NULL, NULL)`
                            : `SELECT id FROM ${fn}($1::uuid)`,
            fn === 'rag_enqueue_backfill_jobs' ||
            fn === 'rag_batch_progress' ||
            fn === 'rag_update_ingestion_batch' ||
            fn === 'rag_list_batch_jobs' ||
            fn === 'rag_record_embed_batch' ||
            fn === 'rag_open_embed_batches'
              ? [batchId]
              : [],
          );
          expectSqlState(err, '42501');
        });
        await asRole(db, 'authenticated', async () => {
          const err = await tryQuery(
            db,
            fn === 'rag_create_ingestion_batch'
              ? `SELECT id FROM ${fn}('${tenant}', 'folder', '/x', NULL, 1)`
              : fn === 'rag_enqueue_backfill_jobs'
                ? `SELECT ${fn}($1::uuid, '[]'::jsonb)`
                : fn === 'rag_existing_file_hashes'
                  ? `SELECT id FROM ${fn}('${tenant}', ARRAY['${'d'.repeat(64)}']::text[])`
                  : fn === 'rag_batch_progress'
                    ? `SELECT ${fn}($1::uuid)`
                    : fn === 'rag_update_ingestion_batch'
                      ? `SELECT id FROM ${fn}($1::uuid, 'running', NULL, NULL)`
                      : fn === 'rag_list_batch_jobs'
                        ? `SELECT id FROM ${fn}($1::uuid, NULL, NULL, 1)`
                        : fn === 'rag_record_embed_batch'
                          ? `SELECT id FROM ${fn}($1::uuid, '${profileId}', 'openai', 'x', 'y', 1, 'validating')`
                          : fn === 'rag_update_embed_batch'
                            ? `SELECT id FROM ${fn}(gen_random_uuid(), 'failed', NULL, NULL, NULL, NULL)`
                            : `SELECT id FROM ${fn}($1::uuid)`,
            fn === 'rag_enqueue_backfill_jobs' ||
            fn === 'rag_batch_progress' ||
            fn === 'rag_update_ingestion_batch' ||
            fn === 'rag_list_batch_jobs' ||
            fn === 'rag_record_embed_batch' ||
            fn === 'rag_open_embed_batches'
              ? [batchId]
              : [],
          );
          expectSqlState(err, '42501');
        });
      }
    });
  });
}