import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrations, migrationFiles } from '../../eval/harness/migrations.mts';
import { catalogDump } from './schema-equality.test.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION_0351 = 'supabase/migrations/0351_ingestion_schema.sql';

const SERVICE_TABLES = [
  'ingestion_batches',
  'ingestion_jobs',
  'rag_parse_budget_usage',
  'rag_parse_budget_reservations',
  'rag_parse_tier_overrides',
  'rag_parse_cache',
  'rag_embed_batches',
] as const;

const TENANT_SINGLE = 's:default';
const TENANT_USER = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_ORG = `o:${TWO_TENANT_IDS.orgO}`;
const OPTIONS_HASH = 'a'.repeat(64);
const FILE_SHA = 'b'.repeat(64);

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

async function relationExists(db: PGlite, name: string): Promise<boolean> {
  const result = await db.query<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [`public.${name}`]);
  return result.rows[0]?.found === true;
}

async function requireIngestionSchema(db: PGlite): Promise<void> {
  for (const table of SERVICE_TABLES) {
    assert.equal(await relationExists(db, table), true, `${table} is missing`);
  }
}

async function insertMinimalJob(db: PGlite, mode: DeploymentMode, overrides: Record<string, unknown> = {}): Promise<string> {
  const tenant = tenantFor(mode);
  const id = (overrides.id as string) ?? crypto.randomUUID();
  const kind = (overrides.kind as string) ?? 'ingest';
  const status = (overrides.status as string) ?? 'queued';
  const batchId = overrides.batch_id ?? null;
  const sourceKey = (overrides.source_key as string) ?? `fixture/${id}`;
  await db.query(
    `INSERT INTO ingestion_jobs (id, tenant_key, kind, status, source, source_key, settings, batch_id)
     VALUES ($1, $2, $3, $4, 'config_upload', $5, '{}'::jsonb, $6)`,
    [id, tenant, kind, status, sourceKey, batchId],
  );
  return id;
}

async function insertBatch(db: PGlite, mode: DeploymentMode): Promise<string> {
  const tenant = tenantFor(mode);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ingestion_batches (id, tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, status)
     VALUES ($1, $2, 'folder', '/tmp/backfill', 100, 2, 'worker', 'pending')`,
    [id, tenant],
  );
  return id;
}

for (const mode of MODES) {
  describe(`ingestion schema (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, supabaseGrants: true, migrations: true });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('migration 0351 is in the loader list', () => {
      assert.ok(migrationFiles(mode).includes(MIGRATION_0351));
    });

    test('all Phase 3.1 tables and document columns exist', async () => {
      const { db } = fixture;
      await requireIngestionSchema(db);
      for (const column of ['needs_review', 'needs_review_reason', 'provisional', 'parse_cache_id']) {
        const rows = await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = $1`,
          [column],
        );
        assert.equal(rows.rows.length, 1, `documents.${column}`);
      }
      const chunkCol = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_chunks' AND column_name = 'provisional'`,
      );
      assert.equal(chunkCol.rows.length, 1);
    });

    test('ingestion_jobs rejects bogus status or kind and defaults are applied', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const badStatus = await tryQuery(
        db,
        `INSERT INTO ingestion_jobs (tenant_key, kind, status, source, source_key, settings)
         VALUES ($1, 'ingest', 'bogus', 'config_upload', 'x', '{}'::jsonb)`,
        [tenant],
      );
      expectSqlState(badStatus, '23514');
      const badKind = await tryQuery(
        db,
        `INSERT INTO ingestion_jobs (tenant_key, kind, status, source, source_key, settings)
         VALUES ($1, 'other', 'queued', 'config_upload', 'x', '{}'::jsonb)`,
        [tenant],
      );
      expectSqlState(badKind, '23514');

      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO ingestion_jobs (id, tenant_key, kind, status, source, source_key, settings)
         VALUES ($1, $2, 'ingest', 'queued', 'config_upload', 'defaults-check', '{}'::jsonb)`,
        [id, tenant],
      );
      const row = (
        await db.query<{
          status: string;
          retries: number;
          priority: number;
          stage_state: unknown;
          attempts: unknown;
          page_ranges: unknown;
        }>('SELECT status, retries, priority, stage_state, attempts, page_ranges FROM ingestion_jobs WHERE id = $1', [id])
      ).rows[0];
      assert.deepEqual(row, {
        status: 'queued',
        retries: 0,
        priority: 100,
        stage_state: {},
        attempts: [],
        page_ranges: [],
      });
    });

    test('batch dedupe index is per kind; dry_run and ingest may share a batch', async () => {
      const { db } = fixture;
      const batchId = await insertBatch(db, mode);
      const sourceKey = 'sample/report.pdf';
      await insertMinimalJob(db, mode, { batch_id: batchId, source_key: sourceKey, kind: 'ingest' });
      await insertMinimalJob(db, mode, { batch_id: batchId, source_key: sourceKey, kind: 'dry_run' });
      const dup = await tryQuery(
        db,
        `INSERT INTO ingestion_jobs (tenant_key, kind, status, source, source_key, settings, batch_id)
         VALUES ($1, 'ingest', 'queued', 'config_upload', $2, '{}'::jsonb, $3)`,
        [tenantFor(mode), sourceKey, batchId],
      );
      expectSqlState(dup, '23505');
      await insertMinimalJob(db, mode, { source_key: 'no-batch/file.pdf', batch_id: null });
      await insertMinimalJob(db, mode, { source_key: 'no-batch/file.pdf', batch_id: null });
    });

    test('rag_parse_cache enforces options_hash and unique cache key', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const badHash = await tryQuery(
        db,
        `INSERT INTO rag_parse_cache (tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix, result)
         VALUES ($1, $2, 'docling', 'v1', 'NOT_HEX', 'pfx/', '{}'::jsonb)`,
        [tenant, FILE_SHA],
      );
      expectSqlState(badHash, '23514');
      await db.query(
        `INSERT INTO rag_parse_cache (tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix, result)
         VALUES ($1, $2, 'docling', 'v1', $3, 'pfx/', '{}'::jsonb)`,
        [tenant, FILE_SHA, OPTIONS_HASH],
      );
      const dup = await tryQuery(
        db,
        `INSERT INTO rag_parse_cache (tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix, result)
         VALUES ($1, $2, 'docling', 'v1', $3, 'pfx2/', '{}'::jsonb)`,
        [tenant, FILE_SHA, OPTIONS_HASH],
      );
      expectSqlState(dup, '23505');
    });

    test('rag_parse_tier_overrides enforces tier order', async () => {
      const { db } = fixture;
      const bad = await tryQuery(
        db,
        `INSERT INTO rag_parse_tier_overrides (doc_type, min_tier, max_tier, updated_by)
         VALUES ('general', 'premium', 'fast', 'test')`,
      );
      expectSqlState(bad, '23514');
      await db.query(
        `INSERT INTO rag_parse_tier_overrides (doc_type, min_tier, max_tier, updated_by)
         VALUES ('general', 'structured', 'structured', 'test')
         ON CONFLICT (doc_type) DO UPDATE SET min_tier = EXCLUDED.min_tier, max_tier = EXCLUDED.max_tier`,
      );
    });

    test('pre-migration document rows keep safe defaults; status deleted is allowed', async () => {
      const { db } = fixture;
      const leg = (
        await db.query<{
          needs_review: boolean;
          provisional: boolean;
          parse_cache_id: string | null;
        }>('SELECT needs_review, provisional, parse_cache_id FROM documents LIMIT 1')
      ).rows[0];
      assert.deepEqual(leg, { needs_review: false, provisional: false, parse_cache_id: null });
      const id = crypto.randomUUID();
      if (mode === 'multi-tenant') {
        await db.query(
          `INSERT INTO documents (id, filename, content, user_id, status, source, source_key, lineage_id, version, is_current)
           VALUES ($1, 'del.md', 'body', $2, 'deleted', 'config_upload', $3, $1, 1, false)`,
          [id, fixture.fixtureUserId, `del/${id}`],
        );
      } else {
        await db.query(
          `INSERT INTO documents (id, filename, content, status, source, source_key, lineage_id, version, is_current)
           VALUES ($1, 'del.md', 'body', 'deleted', 'config_upload', $2, $1, 1, false)`,
          [id, `del/${id}`],
        );
      }
      assert.equal((await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [id])).rows[0]?.status, 'deleted');
    });

    // 0425 later replaces 0351's functions with an empty search_path, 0426 replaces rag_advance_ingestion_job again, 0427 replaces
    // rag_record_parse_attempt and the Phase 3.2 files (08xx) replace the ledger functions and rag_set_document_fields again, so a re-run of
    // 0351 is followed by 0425, 0426, 0427 and the 08xx files, as in migration order.
    test('applying 0351 twice (then 0425, 0426, 0427 and 08xx, which supersede its functions) leaves the catalog unchanged', async () => {
      const once = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, migrations: true, supabaseGrants: true });
      const before = await catalogDump(once.db);
      const fs = await import('node:fs');
      await once.db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION_0351), 'utf8'));
      for (const file of migrationFiles(mode).filter((relpath) => /^supabase\/migrations\/(042[5-7]|08\d\d)_/.test(relpath))) {
        await once.db.exec(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      }
      const after = await catalogDump(once.db);
      assert.deepEqual(catalogDifferences(before, after), []);
      await once.db.close();
    });

    test('seven new tables are RLS-on, policy-free, and closed to anon and authenticated', async () => {
      const { db } = fixture;
      await requireIngestionSchema(db);
      for (const table of SERVICE_TABLES) {
        const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; rls: boolean }>(
          `SELECT has_table_privilege('anon', $1, 'SELECT') OR has_table_privilege('anon', $1, 'INSERT')
                    OR has_table_privilege('anon', $1, 'UPDATE') OR has_table_privilege('anon', $1, 'DELETE') AS anon,
                  has_table_privilege('authenticated', $1, 'SELECT') OR has_table_privilege('authenticated', $1, 'INSERT')
                    OR has_table_privilege('authenticated', $1, 'UPDATE') OR has_table_privilege('authenticated', $1, 'DELETE') AS authenticated,
                  has_table_privilege('service_role', $1, 'SELECT,INSERT,UPDATE,DELETE') AS service,
                  (SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass) AS rls`,
          [`public.${table}`],
        );
        assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true, rls: true }, table);
        await asRole(db, 'anon', async () => {
          expectSqlState(await tryQuery(db, `SELECT 1 FROM ${table} LIMIT 1`), '42501');
          if (table === 'ingestion_jobs') {
            const tenant = tenantFor(mode);
            expectSqlState(
              await tryQuery(
                db,
                `INSERT INTO ingestion_jobs (tenant_key, kind, status, source, source_key, settings)
                 VALUES ($1, 'ingest', 'queued', 'config_upload', 'deny', '{}'::jsonb)`,
                [tenant],
              ),
              '42501',
            );
          }
        });
        await asRole(db, 'authenticated', async () => {
          expectSqlState(await tryQuery(db, `SELECT 1 FROM ${table} LIMIT 1`), '42501');
        });
      }
      const policies = await db.query('SELECT 1 FROM pg_policies WHERE schemaname = $1 AND tablename = ANY($2)', ['public', [...SERVICE_TABLES]]);
      assert.equal(policies.rows.length, 0);
    });

    test('rag_ingest_assert_tenant_key validates tenant keys for this schema', async () => {
      const { db } = fixture;
      const good = mode === 'single-tenant' ? TENANT_SINGLE : TENANT_USER;
      await db.query('SELECT rag_ingest_assert_tenant_key($1)', [good]);
      if (mode === 'multi-tenant') {
        await db.query('SELECT rag_ingest_assert_tenant_key($1)', [TENANT_ORG]);
        expectSqlState(await tryQuery(db, 'SELECT rag_ingest_assert_tenant_key($1)', [TENANT_SINGLE]), '22023');
      } else {
        expectSqlState(await tryQuery(db, 'SELECT rag_ingest_assert_tenant_key($1)', [TENANT_USER]), '22023');
      }
      for (const bad of ['', 'U:' + TWO_TENANT_IDS.userA, `u:x' OR '1'='1`]) {
        expectSqlState(await tryQuery(db, 'SELECT rag_ingest_assert_tenant_key($1)', [bad]), '22023');
      }
      expectSqlState(await tryQuery(db, 'SELECT rag_ingest_assert_tenant_key(NULL)'), '22023');
      await asRole(db, 'anon', async () => {
        expectSqlState(await tryQuery(db, 'SELECT rag_ingest_assert_tenant_key($1)', [good]), '42501');
      });
    });

    test('rag_release_job_reservations releases open rows and decrements usage once', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await insertMinimalJob(db, mode);
      const month = '2026-11-01';
      await db.query(
        `INSERT INTO rag_parse_budget_usage (tenant_key, month, pages_reserved, pages_used, vlm_pages_used)
         VALUES ($1, $2::date, 10, 0, 0)`,
        [tenant, month],
      );
      await db.query(
        `INSERT INTO rag_parse_budget_reservations (job_id, attempt_no, tenant_key, month, pages, kind, state)
         VALUES ($1, 1, $2, $3::date, 4, 'parse', 'open'),
                ($1, 2, $2, $3::date, 3, 'vlm', 'open')`,
        [jobId, tenant, month],
      );
      const first = (await db.query<{ rag_release_job_reservations: number }>('SELECT rag_release_job_reservations($1) AS rag_release_job_reservations', [jobId]))
        .rows[0]?.rag_release_job_reservations;
      assert.equal(first, 2);
      const usage = (
        await db.query<{ pages_reserved: number }>('SELECT pages_reserved FROM rag_parse_budget_usage WHERE tenant_key = $1 AND month = $2::date', [tenant, month])
      ).rows[0];
      assert.equal(usage?.pages_reserved, 3);
      const second = (await db.query<{ n: number }>('SELECT rag_release_job_reservations($1) AS n', [jobId])).rows[0]?.n;
      assert.equal(second, 0);
      await asRole(db, 'anon', async () => {
        expectSqlState(await tryQuery(db, 'SELECT rag_release_job_reservations($1)', [jobId]), '42501');
      });
    });

    test('fake edge with the anon key does not return ingestion_jobs rows', async () => {
      const { db } = fixture;
      await insertMinimalJob(db, mode);
      let edge: FakeEdge | undefined;
      try {
        edge = await startFakeEdge({ db });
        const env = fixtureProcessEnv(edge.url);
        const res = await fetch(`${edge.url}/rest/v1/ingestion_jobs?select=id&limit=1`, {
          headers: {
            apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
          },
        });
        assert.ok(res.status >= 400, `expected client error, got ${res.status}`);
        const body = await res.json();
        assert.notEqual(res.status, 200);
        if (Array.isArray(body)) assert.equal(body.length, 0);
      } finally {
        await edge?.close();
      }
    });
  });
}

type CatalogDump = Awaited<ReturnType<typeof catalogDump>>;

function catalogDifferences(left: CatalogDump, right: CatalogDump): string[] {
  const out: string[] = [];
  for (const section of Object.keys(left)) {
    const a = new Set(left[section]);
    const b = new Set(right[section]);
    for (const row of a) if (!b.has(row)) out.push(`${section}: only before: ${row.slice(0, 120)}`);
    for (const row of b) if (!a.has(row)) out.push(`${section}: only after: ${row.slice(0, 120)}`);
  }
  return out;
}