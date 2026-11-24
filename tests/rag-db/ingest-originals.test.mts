import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION = 'supabase/migrations/0311_rag_originals_bucket.sql';

type Row = Record<string, unknown>;

const rowsOf = async (db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

describe('rag-originals bucket migration', () => {
  for (const mode of MODES) {
    test(`${mode}: a private bucket with a 20 MB limit and no storage.objects policy`, async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      try {
        const buckets = await rowsOf(fixture.db, "SELECT id, name, public, file_size_limit::bigint::text AS file_size_limit FROM storage.buckets WHERE id = 'rag-originals'");
        assert.deepEqual(buckets, [{ id: 'rag-originals', name: 'rag-originals', public: false, file_size_limit: '20971520' }]);
        const policies = await rowsOf(fixture.db, "SELECT policyname FROM pg_policies WHERE schemaname = 'storage'");
        assert.deepEqual(policies, [], 'no policy on storage.objects: only the service key reaches the bucket');
      } finally {
        await fixture.db.close();
      }
    });

    test(`${mode}: applying the migration again keeps one bucket and turns a public or resized bucket back to private and 20 MB`, async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      try {
        await fixture.db.query("UPDATE storage.buckets SET public = true, file_size_limit = 1 WHERE id = 'rag-originals'");
        await applyMigrationFiles(fixture.db, [MIGRATION]);
        await applyMigrationFiles(fixture.db, [MIGRATION]);
        const buckets = await rowsOf(fixture.db, "SELECT public, file_size_limit::bigint::text AS file_size_limit FROM storage.buckets WHERE id = 'rag-originals'");
        assert.deepEqual(buckets, [{ public: false, file_size_limit: '20971520' }]);
      } finally {
        await fixture.db.close();
      }
    });
  }
});

describe('rag_get_ingest_document carries what a rehydrator needs, for its own tenant only', () => {
  let fixture: TwoTenantDatabase;
  let documentA: string;
  let lineageA: string;
  const tenantA = `u:${TWO_TENANT_IDS.userA}`;
  const tenantB = `u:${TWO_TENANT_IDS.userB}`;
  const ORIGINAL_PATH = (lineage: string) => `${tenantA}/${lineage}/1/original.md`;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    const begun = await rowsOf(
      fixture.db,
      `SELECT * FROM rag_begin_document_version(
        p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL::uuid, p_source => 'nango', p_source_key => $3, p_filename => $4,
        p_file_sha256 => $5, p_doc_type => 'general', p_doc_type_origin => 'fallback', p_profile_id => 'general-1', p_profile_version => 1::int)`,
      [tenantA, TWO_TENANT_IDS.userA, 'drive/folder/handbook.md', '合同.md', crypto.createHash('sha256').update('originals-a').digest('hex')],
    );
    documentA = String(begun[0]?.document_id);
    lineageA = String(begun[0]?.lineage_id);
    await fixture.db.query('SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => $3::jsonb)', [
      documentA,
      tenantA,
      JSON.stringify({ original_path: ORIGINAL_PATH(lineageA) }),
    ]);
  });

  after(async () => {
    await fixture?.db.close();
  });

  test('the owner reads lineage id, original path, source and source key next to the existing columns', async () => {
    const [row] = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantA]);
    assert.ok(row, 'the owner finds the document');
    assert.equal(row.lineage_id, lineageA);
    assert.equal(row.original_path, ORIGINAL_PATH(lineageA));
    assert.equal(row.source, 'nango');
    assert.equal(row.source_key, 'drive/folder/handbook.md');
    assert.equal(row.filename, '合同.md');
    assert.equal(row.status, 'processing');
    assert.equal(row.version, 1);
    for (const column of ['processing_status', 'processing_state', 'doc_type', 'parser_used', 'created_at']) {
      assert.ok(column in row, `${column} is still returned`);
    }
  });

  test('another tenant gets no row for the same id, so neither the path nor the lineage leaks', async () => {
    const foreign = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantB]);
    assert.deepEqual(foreign, []);
    const org = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [documentA, `o:${TWO_TENANT_IDS.orgO}`]);
    assert.deepEqual(org, []);
    const unknown = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [
      '00000000-0000-4000-8000-0000000000aa',
      tenantA,
    ]);
    assert.deepEqual(unknown, []);
  });

  test('the function is still executable by service_role only', async () => {
    const privileges = await rowsOf(
      fixture.db,
      `SELECT r AS role, has_function_privilege(r, 'rag_get_ingest_document(uuid, text)', 'EXECUTE') AS can_execute
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r ORDER BY r`,
    );
    assert.deepEqual(privileges, [
      { role: 'anon', can_execute: false },
      { role: 'authenticated', can_execute: false },
      { role: 'service_role', can_execute: true },
    ]);
    const exposed = await rowsOf(
      fixture.db,
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'rag\\_%' AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    );
    assert.deepEqual(exposed, []);
  });

  test('applying the migration a second time changes nothing the function returns', async () => {
    const before = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantA]);
    await applyMigrationFiles(fixture.db, [MIGRATION]);
    const after = await rowsOf(fixture.db, 'SELECT * FROM rag_get_ingest_document(p_document_id => $1, p_tenant_key => $2)', [documentA, tenantA]);
    assert.deepEqual(after, before);
  });
});
