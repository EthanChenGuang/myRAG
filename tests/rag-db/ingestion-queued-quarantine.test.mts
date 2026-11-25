import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { createTwoTenantDatabase, TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

// A queued job whose injection scan quarantines the document ends with the ledger status quarantined. The terminal transition must leave the
// document quarantined (not failed), so rag_list_quarantine lists it and an admin can review, release or delete it.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SINGLE_TENANT_ADMIN = '00000000-0000-4000-8000-0000000000c2';

/** The quarantine admin of the tenant: the single-tenant admin, or in multi-tenant mode tenant u:userA's own admin user. */
function adminFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? SINGLE_TENANT_ADMIN : TWO_TENANT_IDS.userA;
}

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `u:${TWO_TENANT_IDS.userA}`;
}

async function beginDoc(db: PGlite, mode: DeploymentMode, tenant: string, sourceKey: string): Promise<string> {
  const userId = mode === 'single-tenant' ? null : TWO_TENANT_IDS.userA;
  const row = (
    await db.query<{ document_id: string }>(
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, NULL::uuid, 'config_upload', $3, $4, $5, 'general', 'fallback', 'general-1', 1)`,
      [tenant, userId, sourceKey, `${sourceKey}.md`, crypto.randomBytes(16).toString('hex')],
    )
  ).rows[0];
  assert.ok(row?.document_id);
  return row.document_id;
}

async function queuedJobFor(db: PGlite, tenant: string, sourceKey: string, documentId: string, worker: string): Promise<string> {
  const job = (
    await db.query<{ id: string }>(
      `SELECT id FROM rag_enqueue_ingestion_job($1, 'ingest', 'config_upload', $2, NULL, NULL, NULL, NULL, '{}'::jsonb, 100, $3, NULL, 'queued')`,
      [tenant, sourceKey, documentId],
    )
  ).rows[0];
  assert.ok(job?.id);
  const claimed = (await db.query<{ id: string | null }>('SELECT id FROM rag_claim_ingestion_job($1, $2)', [job.id, worker])).rows[0];
  assert.equal(claimed?.id, job.id);
  return job.id;
}

async function documentRow(db: PGlite, id: string): Promise<{ status: string; processing_status: string | null; is_current: boolean } | undefined> {
  return (
    await db.query<{ status: string; processing_status: string | null; is_current: boolean }>(
      'SELECT status, processing_status, is_current FROM documents WHERE id = $1',
      [id],
    )
  ).rows[0];
}

async function listedForAdmin(db: PGlite, mode: DeploymentMode, id: string): Promise<boolean> {
  const listed = await db.query<{ document_id: string }>('SELECT document_id FROM rag_list_quarantine($1::uuid, 100, 0)', [adminFor(mode)]);
  return listed.rows.some((row) => row.document_id === id);
}

for (const mode of MODES) {
  describe(`queued job quarantined by the injection scan (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = mode === 'multi-tenant'
        ? await createTwoTenantDatabase()
        : await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      if (mode === 'single-tenant') {
        await fixture.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [SINGLE_TENANT_ADMIN, 'quarantine-admin@example.invalid']);
      }
      await fixture.db.query('INSERT INTO admin_users (id) VALUES ($1)', [adminFor(mode)]);
    });

    after(async () => {
      await fixture.db.close();
    });

    test('the terminal quarantined transition leaves the document quarantined and listed for the quarantine admin', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const sourceKey = `scan/${crypto.randomUUID()}`;
      const docId = await beginDoc(db, mode, tenant, sourceKey);
      const jobId = await queuedJobFor(db, tenant, sourceKey, docId, 'scanner');

      await db.query(`SELECT rag_advance_ingestion_job($1, 'scanner', 'scan_injection', 'chunking', NULL, 3, '{}'::jsonb)`, [jobId]);
      await db.query('SELECT * FROM rag_set_document_fields($1, $2, $3::jsonb)', [
        docId,
        tenant,
        JSON.stringify({
          status: 'quarantined',
          metadata: { quarantine: { rule_ids: ['ignore_previous'], snippets: ['ignore all previous instructions'], quarantined_at: new Date().toISOString() } },
        }),
      ]);
      const published = (await db.query<{ outcome: string }>('SELECT outcome FROM rag_publish_document_version($1, $2)', [docId, tenant])).rows[0];
      assert.equal(published?.outcome, 'quarantined');
      assert.equal(await listedForAdmin(db, mode, docId), true, 'listed before the terminal transition');

      await db.query(`SELECT rag_advance_ingestion_job($1, 'scanner', 'quarantined', 'quarantined', NULL, 1, '{}'::jsonb)`, [jobId]);

      const job = (await db.query<{ status: string; locked_by: string | null }>('SELECT status, locked_by FROM ingestion_jobs WHERE id = $1', [jobId])).rows[0];
      assert.deepEqual(job, { status: 'quarantined', locked_by: null });
      const doc = await documentRow(db, docId);
      assert.deepEqual(doc, { status: 'quarantined', processing_status: 'quarantined', is_current: false });
      assert.equal(await listedForAdmin(db, mode, docId), true, 'the quarantine admin lists the document after the job ends');
    });

    test('a quarantined job whose document was never quarantined still fails the non-current version closed', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const sourceKey = `scan-unmarked/${crypto.randomUUID()}`;
      const docId = await beginDoc(db, mode, tenant, sourceKey);
      const jobId = await queuedJobFor(db, tenant, sourceKey, docId, 'unmarked');
      await db.query(`SELECT rag_advance_ingestion_job($1, 'unmarked', 'quarantined', 'quarantined', NULL, 1, '{}'::jsonb)`, [jobId]);
      assert.deepEqual(await documentRow(db, docId), { status: 'failed', processing_status: 'failed', is_current: false });
      assert.equal(await listedForAdmin(db, mode, docId), false);
    });

    test('a failed job still marks its non-current version failed', async () => {
      const { db } = fixture;
      const tenant = tenantFor(mode);
      const sourceKey = `fail/${crypto.randomUUID()}`;
      const docId = await beginDoc(db, mode, tenant, sourceKey);
      const jobId = await queuedJobFor(db, tenant, sourceKey, docId, 'failer');
      await db.query(`SELECT rag_advance_ingestion_job($1, 'failer', 'failed', 'failed', NULL, 1, '{}'::jsonb)`, [jobId]);
      assert.deepEqual(await documentRow(db, docId), { status: 'failed', processing_status: 'failed', is_current: false });
    });

    if (mode === 'multi-tenant') {
      test('the transition never touches a document of another tenant', async () => {
        const { db } = fixture;
        const tenant = tenantFor(mode);
        const sourceKey = `scan-foreign/${crypto.randomUUID()}`;
        const ownDoc = await beginDoc(db, mode, tenant, sourceKey);
        const jobId = await queuedJobFor(db, tenant, sourceKey, ownDoc, 'foreign');
        const foreignDoc = crypto.randomUUID();
        await db.query(
          `INSERT INTO documents (id, filename, content, user_id, status, is_current, version, lineage_id, processing_status)
           VALUES ($1, 'f.md', '', $2, 'quarantined', false, 2, $1, 'quarantined')`,
          [foreignDoc, TWO_TENANT_IDS.userB],
        );
        const ownBefore = await documentRow(db, ownDoc);
        await db.query('UPDATE ingestion_jobs SET document_id = $2 WHERE id = $1', [jobId, foreignDoc]);
        await db.query(`SELECT rag_advance_ingestion_job($1, 'foreign', 'quarantined', 'quarantined', NULL, 1, '{}'::jsonb)`, [jobId]);
        assert.deepEqual(await documentRow(db, foreignDoc), { status: 'quarantined', processing_status: 'quarantined', is_current: false });
        assert.deepEqual(await documentRow(db, ownDoc), ownBefore);
      });
    }
  });
}
