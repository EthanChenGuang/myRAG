import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

type Row = Record<string, unknown>;

const MIGRATION = 'supabase/migrations/0817_released_link_targets.sql';
const rowsOf = async (db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

describe('rag_released_link_targets: reviewed targets of earlier released versions of one lineage, one tenant (D-35)', () => {
  let fixture: TwoTenantDatabase;
  const tenantA = `u:${TWO_TENANT_IDS.userA}`;
  const tenantB = `u:${TWO_TENANT_IDS.userB}`;

  const begin = async (tenant: string, userId: string, sourceKey: string, seed: string): Promise<{ id: string; lineage: string; version: number }> => {
    const rows = await rowsOf(
      fixture.db,
      `SELECT * FROM rag_begin_document_version(
        p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL::uuid, p_source => 'config_upload', p_source_key => $3, p_filename => 'notes.md',
        p_file_sha256 => $4, p_doc_type => 'general', p_doc_type_origin => 'picked', p_profile_id => 'general-1', p_profile_version => 1::int)`,
      [tenant, userId, sourceKey, crypto.createHash('sha256').update(seed).digest('hex')],
    );
    const row = rows[0] as Row;
    return { id: String(row.document_id), lineage: String(row.lineage_id), version: Number(row.version) };
  };
  const settle = (id: string, quarantine: Record<string, unknown> | null) =>
    fixture.db.query(
      `UPDATE documents SET status = 'ready', is_current = false, metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(quarantine ? { quarantine } : {})],
    );
  const targets = async (id: string, tenant: string) =>
    (await rowsOf(fixture.db, 'SELECT target FROM rag_released_link_targets(p_document_id => $1, p_tenant_key => $2)', [id, tenant])).map((row) => row.target);

  let v1: { id: string; lineage: string; version: number };
  let v2: { id: string; lineage: string; version: number };
  let v3: { id: string; lineage: string; version: number };
  let other: { id: string; lineage: string; version: number };
  let foreign: { id: string; lineage: string; version: number };

  before(async () => {
    fixture = await createTwoTenantDatabase();
    v1 = await begin(tenantA, TWO_TENANT_IDS.userA, 'root/released.md', 'v1');
    await settle(v1.id, { released_at: '2026-11-25T00:00:00.000Z', released_targets: ['https://phish.example.net/login', 'b.example.net'] });
    v2 = await begin(tenantA, TWO_TENANT_IDS.userA, 'root/released.md', 'v2');
    await settle(v2.id, { released_targets: ['never-released.example.net'] });
    v3 = await begin(tenantA, TWO_TENANT_IDS.userA, 'root/released.md', 'v3');
    other = await begin(tenantA, TWO_TENANT_IDS.userA, 'root/other.md', 'other');
    foreign = await begin(tenantB, TWO_TENANT_IDS.userB, 'root/released.md', 'foreign');
  });

  after(async () => {
    await fixture?.db.close();
  });

  test('the versions under test share one lineage; the other document and the other tenant do not', () => {
    assert.equal(v2.lineage, v1.lineage);
    assert.equal(v3.lineage, v1.lineage);
    assert.deepEqual([v1.version, v2.version, v3.version], [1, 2, 3]);
    assert.notEqual(other.lineage, v1.lineage);
    assert.notEqual(foreign.lineage, v1.lineage);
  });

  test('a later version gets the targets released on earlier versions, sorted; a version that was never released adds none', async () => {
    assert.deepEqual(await targets(v3.id, tenantA), ['b.example.net', 'https://phish.example.net/login']);
    assert.deepEqual(await targets(v2.id, tenantA), ['b.example.net', 'https://phish.example.net/login']);
    assert.deepEqual(await targets(v1.id, tenantA), [], 'a version never sees its own or a later release');
  });

  test('another lineage of the same tenant and another tenant get nothing', async () => {
    assert.deepEqual(await targets(other.id, tenantA), []);
    assert.deepEqual(await targets(foreign.id, tenantB), []);
    assert.deepEqual(await targets(v3.id, tenantB), [], 'a document id with the wrong tenant key answers nothing');
  });

  test('applying the migration again changes nothing', async () => {
    await applyMigrationFiles(fixture.db, [MIGRATION, MIGRATION]);
    assert.deepEqual(await targets(v3.id, tenantA), ['b.example.net', 'https://phish.example.net/login']);
  });

  test('one overload, empty search_path, executable by service_role only', async () => {
    const rows = await rowsOf(
      fixture.db,
      `SELECT p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'rag_released_link_targets'`,
    );
    assert.equal(rows.length, 1);
    const row = rows[0] as Row;
    assert.equal(row.definer, false);
    assert.deepEqual(row.config, ['search_path=""']);
    assert.equal(row.anon, false);
    assert.equal(row.authenticated, false);
    assert.equal(row.service_role, true);
  });
});
