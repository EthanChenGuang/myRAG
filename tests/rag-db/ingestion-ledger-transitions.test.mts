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
const M0352 = 'supabase/migrations/0352_ingestion_claim.sql';
const M0353 = 'supabase/migrations/0353_ingestion_transitions.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const ADMIN = '00000000-0000-4000-8000-0000000000c1';
const TENANT_SINGLE = 's:default';

function modeMigrationSuffix(mode: DeploymentMode): string {
  return mode === 'single-tenant'
    ? 'supabase/migrations/0353_ingestion_transitions.single-tenant.sql'
    : 'supabase/migrations/0353_ingestion_transitions.multi-tenant.sql';
}

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? TENANT_SINGLE : `u:${TWO_TENANT_IDS.userA}`;
}

async function applyMigrations(db: PGlite, mode: DeploymentMode): Promise<void> {
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, M0352), 'utf8'));
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, modeMigrationSuffix(mode)), 'utf8'));
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, M0353), 'utf8'));
}

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code: string | null; message: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : null;
    return { message, code };
  }
}

async function enqueue(db: PGlite, tenant: string, sourceKey: string, documentId: string | null = null): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `SELECT id FROM rag_enqueue_ingestion_job($1, 'ingest', 'config_upload', $2, NULL, NULL, NULL, NULL, '{}'::jsonb, 100, $3, NULL, 'queued')`,
      [tenant, sourceKey, documentId],
    )
  ).rows[0];
  assert.ok(row?.id);
  return row.id;
}

async function claim(db: PGlite, jobId: string, worker: string): Promise<void> {
  const row = (await db.query<{ id: string | null }>('SELECT id FROM rag_claim_ingestion_job($1, $2)', [jobId, worker])).rows[0];
  assert.equal(row?.id, jobId);
}

async function beginDoc(db: PGlite, mode: DeploymentMode, tenant: string, sourceKey: string): Promise<string> {
  const userId = mode === 'single-tenant' ? null : TWO_TENANT_IDS.userA;
  const orgId = null;
  const row = (
    await db.query<{ document_id: string }>(
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [tenant, userId, orgId, sourceKey, `${sourceKey}.md`, crypto.randomBytes(16).toString('hex')],
    )
  ).rows[0];
  assert.ok(row?.document_id);
  return row.document_id;
}

for (const mode of MODES) {
  describe(`ingestion ledger transitions (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = mode === 'multi-tenant'
        ? await createTwoTenantDatabase()
        : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      await applyMigrations(fixture.db);
      if (mode === 'multi-tenant') {
        await fixture.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ADMIN, 'admin@example.invalid']);
        await fixture.db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
      } else {
        await fixture.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ADMIN, 'admin@example.invalid']);
        await fixture.db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
      }
    });

    after(async () => {
      await fixture.db.close();
    });

    test('advance accepts chunk/chunking; rejects chunk/embedding and unknown stage', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await enqueue(db, tenant, `adv/${crypto.randomUUID()}`);
      await claim(db, jobId, 'w1');
      await db.query(
        `SELECT rag_advance_ingestion_job($1, 'w1', 'chunk', 'chunking', NULL, 10, '{}'::jsonb)`,
        [jobId],
      );
      const bad = await tryQuery(db, `SELECT rag_advance_ingestion_job($1, 'w1', 'chunk', 'embedding', NULL, 1, '{}'::jsonb)`, [jobId]);
      assert.ok(bad?.code === '22023' || bad?.message.includes('22023'));
      const unknown = await tryQuery(db, `SELECT rag_advance_ingestion_job($1, 'w1', 'nope', 'chunking', NULL, 1, '{}'::jsonb)`, [jobId]);
      assert.ok(unknown?.code === '22023' || unknown?.message.includes('22023'));
    });

    test('lease lost for wrong worker or expired lease leaves row unchanged', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await enqueue(db, tenant, `lease/${crypto.randomUUID()}`);
      await claim(db, jobId, 'owner');
      const before = (await db.query<{ stage: string | null }>('SELECT stage FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
      const err = await tryQuery(db, `SELECT rag_advance_ingestion_job($1, 'other', 'chunk', 'chunking', NULL, 1, '{}'::jsonb)`, [jobId]);
      assert.ok(err?.code === '55000' || err?.message.includes('lease_lost'));
      const afterWrong = (await db.query<{ stage: string | null }>('SELECT stage FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
      assert.deepEqual(afterWrong, before);
      await db.query(`UPDATE ingestion_jobs SET lease_until = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
      const expired = await tryQuery(db, `SELECT rag_advance_ingestion_job($1, 'owner', 'chunk', 'chunking', NULL, 1, '{}'::jsonb)`, [jobId]);
      assert.ok(expired?.code === '55000' || expired?.message.includes('lease_lost'));
    });

    test('timings accumulate, stage_state replaces, whitelist enforced, document_id set only when null', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const docId = await beginDoc(db, mode, tenant, `doc/${crypto.randomUUID()}`);
      const jobId = await enqueue(db, tenant, `fields/${crypto.randomUUID()}`);
      await claim(db, jobId, 'wf');
      await db.query(`SELECT rag_advance_ingestion_job($1, 'wf', 'chunk', 'chunking', '{"cursor":1}'::jsonb, 5, '{}'::jsonb)`, [jobId]);
      await db.query(`SELECT rag_advance_ingestion_job($1, 'wf', 'chunk', 'chunking', '{"cursor":2}'::jsonb, 7, '{}'::jsonb)`, [jobId]);
      const mid = (
        await db.query<{ timings: Record<string, number>; stage_state: Record<string, unknown> }>(
          'SELECT timings, stage_state FROM ingestion_jobs WHERE id = $1',
          [jobId],
        )
      ).rows[0];
      assert.equal(mid?.timings?.chunk, 12);
      assert.deepEqual(mid?.stage_state, { cursor: 2 });
      const badField = await tryQuery(
        db,
        `SELECT rag_advance_ingestion_job($1, 'wf', 'chunk', 'chunking', NULL, 1, '{"filename":"x"}'::jsonb)`,
        [jobId],
      );
      assert.ok(badField?.code === '22023' || badField?.message.includes('22023'));
      await db.query(
        `SELECT rag_advance_ingestion_job($1, 'wf', 'chunk', 'chunking', NULL, 1, jsonb_build_object('document_id', $2::text))`,
        [jobId, docId],
      );
      const linked = (await db.query<{ document_id: string | null }>('SELECT document_id FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
      assert.equal(linked?.document_id, docId);
    });

    test('processing_status mirror and processing_state untouched; cross-tenant document never updated', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const otherTenant = mode === 'single-tenant' ? `u:${TWO_TENANT_IDS.userA}` : TENANT_SINGLE;
      const docId = await beginDoc(db, mode, tenant, `mirror/${crypto.randomUUID()}`);
      const jobId = await enqueue(db, tenant, `mirror/${crypto.randomUUID()}`, docId);
      await db.query(`UPDATE documents SET processing_state = '{"keep":true}'::jsonb WHERE id = $1`, [docId]);
      await claim(db, jobId, 'mirror');
      await db.query(`SELECT rag_advance_ingestion_job($1, 'mirror', 'embed', 'embedding', NULL, 1, '{}'::jsonb)`, [jobId]);
      const doc = (
        await db.query<{ processing_status: string; processing_state: Record<string, unknown> }>(
          'SELECT processing_status, processing_state FROM documents WHERE id = $1',
          [docId],
        )
      ).rows[0];
      assert.equal(doc?.processing_status, 'embedding');
      assert.deepEqual(doc?.processing_state, { keep: true });
      if (mode === 'multi-tenant') {
        const foreignDoc = crypto.randomUUID();
        await db.query(
          `INSERT INTO documents (id, filename, content, user_id, status, is_current, version, lineage_id, processing_state, processing_status)
           VALUES ($1, 'f.md', '', $2, 'processing', false, 2, $1, '{"x":1}'::jsonb, 'queued')`,
          [foreignDoc, TWO_TENANT_IDS.userB],
        );
        await db.query(`UPDATE ingestion_jobs SET document_id = $2 WHERE id = $1`, [jobId, foreignDoc]);
        await db.query(`SELECT rag_advance_ingestion_job($1, 'mirror', 'chunk', 'chunking', NULL, 1, '{}'::jsonb)`, [jobId]);
        const foreign = (
          await db.query<{ processing_status: string }>('SELECT processing_status FROM documents WHERE id = $1', [foreignDoc])
        ).rows[0];
        assert.equal(foreign?.processing_status, 'queued');
      }
    });

    test('terminal ready clears lease and releases open reservations', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await enqueue(db, tenant, `ready/${crypto.randomUUID()}`);
      await claim(db, jobId, 'fin');
      await db.query(
        `INSERT INTO rag_parse_budget_reservations (job_id, attempt_no, tenant_key, month, pages, kind, state)
         VALUES ($1, 1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 3, 'parse', 'open')`,
        [jobId, tenant],
      );
      await db.query(`SELECT rag_advance_ingestion_job($1, 'fin', 'ready', 'ready', NULL, 1, '{}'::jsonb)`, [jobId]);
      const row = (await db.query<{ locked_by: string | null; lease_until: string | null }>('SELECT locked_by, lease_until FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
      assert.equal(row?.locked_by, null);
      assert.equal(row?.lease_until, null);
      const open = (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM rag_parse_budget_reservations WHERE job_id = $1 AND state = 'open'`,
          [jobId],
        )
      ).rows[0]?.n;
      assert.equal(open, 0);
    });

    test('parse attempts numbering, escalation counts and cost sum', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await enqueue(db, tenant, `attempt/${crypto.randomUUID()}`);
      await claim(db, jobId, 'pa');
      const first = (
        await db.query<{ rag_record_parse_attempt: number }>(
          `SELECT rag_record_parse_attempt($1, 'pa', '{"tier":"fast","reason":"escalation","est_cost":0.1}'::jsonb)`,
          [jobId],
        )
      ).rows[0]?.rag_record_parse_attempt;
      const second = (
        await db.query<{ rag_record_parse_attempt: number }>(
          `SELECT rag_record_parse_attempt($1, 'pa', '{"tier":"structured","reason":"table_boundary","est_cost":0.2}'::jsonb)`,
          [jobId],
        )
      ).rows[0]?.rag_record_parse_attempt;
      assert.equal(first, 1);
      assert.equal(second, 2);
      const row = (
        await db.query<{ escalations: number; est_cost_usd: string; attempts: unknown[] }>(
          'SELECT escalations, est_cost_usd::text, attempts FROM ingestion_jobs WHERE id = $1',
          [jobId],
        )
      ).rows[0];
      assert.equal(row?.escalations, 1);
      assert.ok(Number(row?.est_cost_usd) >= 0.29);
      assert.equal(row?.attempts?.length, 2);
    });

    test('retryable fail backoff and fourth failure; permanent fails at once; releases reservations', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const jobId = await enqueue(db, tenant, `fail/${crypto.randomUUID()}`);
      await claim(db, jobId, 'fw');
      await db.query(
        `INSERT INTO rag_parse_budget_reservations (job_id, attempt_no, tenant_key, month, pages, kind, state)
         VALUES ($1, 1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 2, 'parse', 'open')`,
        [jobId, tenant],
      );
      for (const [beforeRetries, expectedRetries, expectedDelay, worker] of [
        [0, 1, 30, 'fw1'],
        [1, 2, 60, 'fw2'],
        [2, 3, 120, 'fw3'],
      ] as const) {
        await db.query(
          `UPDATE ingestion_jobs SET retries = $2, status = 'parsing', locked_by = $3, lease_until = now() + interval '2 minutes' WHERE id = $1`,
          [jobId, beforeRetries, worker],
        );
        const row = (
          await db.query<{ status: string; retries: number; run_after: Date }>(
            `SELECT status, retries, run_after FROM rag_fail_ingestion_job($1, $2, 'transient', true)`,
            [jobId, worker],
          )
        ).rows[0];
        assert.equal(row?.status, 'queued');
        assert.equal(row?.retries, expectedRetries);
        const delta = Math.abs(row!.run_after.getTime() - Date.now() - expectedDelay * 1000);
        assert.ok(delta < 1500, `backoff delta ${delta} for retry ${expectedRetries}`);
        const open = (
          await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM rag_parse_budget_reservations WHERE job_id = $1 AND state = 'open'`, [jobId])
        ).rows[0]?.n;
        assert.equal(open, 0);
      }
      await db.query(
        `UPDATE ingestion_jobs SET retries = 3, status = 'parsing', locked_by = 'fw4', lease_until = now() + interval '2 minutes' WHERE id = $1`,
        [jobId],
      );
      const terminal = (
        await db.query<{ status: string; retries: number }>(`SELECT status, retries FROM rag_fail_ingestion_job($1, 'fw4', 'transient', true)`, [jobId])
      ).rows[0];
      assert.deepEqual(terminal, { status: 'failed', retries: 4 });
      const permJob = await enqueue(db, tenant, `perm/${crypto.randomUUID()}`);
      await claim(db, permJob, 'pf');
      const perm = (await db.query<{ status: string }>(`SELECT status FROM rag_fail_ingestion_job($1, 'pf', 'encrypted_pdf', false) r`, [permJob])).rows[0];
      assert.equal(perm?.status, 'failed');
    });

    test('admin retry and delete semantics with audit rows', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const actor = mode === 'multi-tenant' ? TWO_TENANT_IDS.userA : ADMIN;
      if (mode === 'multi-tenant') {
        await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [actor]);
      }
      const sourceKey = `del/${crypto.randomUUID()}`;
      const docV1 = await beginDoc(db, mode, tenant, `${sourceKey}-v1`);
      const docV2 = await beginDoc(db, mode, tenant, sourceKey);
      await db.query(`UPDATE documents SET is_current = true, status = 'ready' WHERE id = $1`, [docV1]);
      const jobCurrent = await enqueue(db, tenant, `jc/${crypto.randomUUID()}`, docV1);
      await db.query(`UPDATE ingestion_jobs SET status = 'failed' WHERE id = $1`, [jobCurrent]);
      const badCurrent = await tryQuery(db, 'SELECT rag_delete_ingestion_job($1, $2::uuid)', [jobCurrent, actor]);
      assert.ok(badCurrent?.code === '22023' || badCurrent?.message.includes('22023'));
      const jobV2 = await enqueue(db, tenant, `jv2/${crypto.randomUUID()}`, docV2);
      await db.query(`UPDATE ingestion_jobs SET status = 'failed' WHERE id = $1`, [jobV2]);
      await db.query('SELECT rag_delete_ingestion_job($1, $2::uuid)', [jobV2, actor]);
      assert.equal((await db.query('SELECT 1 FROM documents WHERE id = $1', [docV2])).rows.length, 0);
      assert.equal((await db.query('SELECT 1 FROM documents WHERE id = $1', [docV1])).rows.length, 1);
      const deleted = (await db.query<{ deleted_at: string | null }>('SELECT deleted_at FROM ingestion_jobs WHERE id = $1', [jobV2])).rows[0];
      assert.ok(deleted?.deleted_at);
      const jobRetry = await enqueue(db, tenant, `retry/${crypto.randomUUID()}`);
      await db.query(`UPDATE ingestion_jobs SET status = 'failed', retries = 3, attempts = '[{"n":1}]'::jsonb WHERE id = $1`, [jobRetry]);
      await db.query('SELECT rag_retry_ingestion_job($1, $2::uuid)', [jobRetry, actor]);
      const retried = (
        await db.query<{ status: string; retries: number; attempts: unknown[] }>('SELECT status, retries, attempts FROM ingestion_jobs WHERE id = $1', [jobRetry])
      ).rows[0];
      assert.deepEqual({ status: retried?.status, retries: retried?.retries, attemptsLen: retried?.attempts?.length }, { status: 'queued', retries: 0, attemptsLen: 1 });
      const jobReady = await enqueue(db, tenant, `ready-retry/${crypto.randomUUID()}`);
      await db.query(`UPDATE ingestion_jobs SET status = 'ready' WHERE id = $1`, [jobReady]);
      const readyErr = await tryQuery(db, 'SELECT rag_retry_ingestion_job($1, $2::uuid)', [jobReady, actor]);
      assert.ok(readyErr?.code === '22023' || readyErr?.message.includes('22023'));
      const audits = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM rag_admin_audit WHERE action IN ('retry_ingestion_job','delete_ingestion_job')`)).rows[0]?.n;
      assert.ok((audits ?? 0) >= 2);
    });

    test('tenant-scoped reads and list filters', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const other = mode === 'single-tenant' ? `u:${TWO_TENANT_IDS.userB}` : TENANT_SINGLE;
      const jobId = await enqueue(db, tenant, `read/${crypto.randomUUID()}`);
      const foreign = await db.query<{ id: string | null }>('SELECT id FROM rag_get_ingestion_job($1, $2)', [jobId, other]);
      assert.ok(!foreign.rows[0]?.id);
      assert.equal((await db.query<{ id: string }>('SELECT id FROM rag_get_ingestion_job($1, $2)', [jobId, tenant])).rows[0]?.id, jobId);
      assert.equal((await db.query<{ id: string }>('SELECT id FROM rag_get_ingestion_job_internal($1)', [jobId])).rows[0]?.id, jobId);
      await enqueue(db, tenant, `list-a/${crypto.randomUUID()}`);
      const failed = await enqueue(db, tenant, `list-b/${crypto.randomUUID()}`);
      await db.query(`UPDATE ingestion_jobs SET status = 'failed' WHERE id = $1`, [failed]);
      const listed = await db.query<{ id: string }>(
        `SELECT id FROM rag_list_ingestion_jobs($1, ARRAY['failed']::text[], 'ingest', 10, 0)`,
        [tenant],
      );
      assert.ok(listed.rows.some((r) => r.id === failed));
    });
  });
}