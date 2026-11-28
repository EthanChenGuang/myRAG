import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

type Row = Record<string, unknown>;

const MIGRATION = 'supabase/migrations/0822_rescan_candidates.sql';
const rowsOf = async (db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

describe('rag_rescan_candidates: current, ready documents for the security rescan, one tenant or all, read only (D-47)', () => {
  let fixture: TwoTenantDatabase;
  const tenantA = `u:${TWO_TENANT_IDS.userA}`;
  const tenantB = `u:${TWO_TENANT_IDS.userB}`;
  const ids: Record<string, string> = {};

  const begin = async (tenant: string, userId: string, sourceKey: string): Promise<string> => {
    const rows = await rowsOf(
      fixture.db,
      `SELECT * FROM rag_begin_document_version(
        p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL::uuid, p_source => 'config_upload', p_source_key => $3, p_filename => 'notes.md',
        p_file_sha256 => $4, p_doc_type => 'general', p_doc_type_origin => 'picked', p_profile_id => 'general-1', p_profile_version => 1::int)`,
      [tenant, userId, sourceKey, crypto.createHash('sha256').update(sourceKey).digest('hex')],
    );
    return String((rows[0] as Row).document_id);
  };
  const settle = (id: string, status: string, isCurrent: boolean, metadata: Record<string, unknown> = {}) =>
    fixture.db.query('UPDATE documents SET status = $2, is_current = $3, metadata = COALESCE(metadata, \'{}\'::jsonb) || $4::jsonb WHERE id = $1', [
      id,
      status,
      isCurrent,
      JSON.stringify(metadata),
    ]);
  const candidates = async (tenant: string | null, after: string | null = null, limit = 50) =>
    rowsOf(fixture.db, 'SELECT * FROM rag_rescan_candidates(p_tenant_key => $1, p_after => $2::uuid, p_limit => $3)', [tenant, after, limit]);

  before(async () => {
    fixture = await createTwoTenantDatabase();
    // Only the current, ready versions are candidates: the corpus documents are moved out of the way.
    await fixture.db.exec("UPDATE documents SET status = 'deleted', is_current = false");
    ids.ready = await begin(tenantA, TWO_TENANT_IDS.userA, 'rescan/ready.md');
    await settle(ids.ready, 'ready', true, { security_rescan: { links: { key: 'k', outcome: 'clean' } } });
    ids.released = await begin(tenantA, TWO_TENANT_IDS.userA, 'rescan/released.md');
    await settle(ids.released, 'ready', true, {
      quarantine: {
        released_at: '2026-11-25T00:00:00.000Z',
        released_targets: ['https://outside.example.net/a'],
        reasons: [{ kind: 'untrusted_link' }, { kind: 'hidden_text' }, 'not an object'],
      },
    });
    ids.quarantined = await begin(tenantA, TWO_TENANT_IDS.userA, 'rescan/quarantined.md');
    await settle(ids.quarantined, 'quarantined', true);
    ids.old = await begin(tenantA, TWO_TENANT_IDS.userA, 'rescan/old.md');
    await settle(ids.old, 'ready', false);
    ids.pending = await begin(tenantA, TWO_TENANT_IDS.userA, 'rescan/pending.md');
    await settle(ids.pending, 'pending_review', false);
    ids.foreign = await begin(tenantB, TWO_TENANT_IDS.userB, 'rescan/foreign.md');
    await settle(ids.foreign, 'ready', true, { quarantine: { released_targets: ['never-released.example.net'] } });
  });

  after(async () => {
    await fixture?.db.close();
  });

  test('one tenant: its current, ready versions only, in id order, with the rescan state and the reviewed release', async () => {
    const rows = await candidates(tenantA);
    assert.deepEqual(rows.map((row) => row.id), [ids.ready, ids.released].sort());
    const ready = rows.find((row) => row.id === ids.ready) as Row;
    assert.deepEqual(ready.rescan, { links: { key: 'k', outcome: 'clean' } });
    assert.equal(ready.released, false);
    assert.deepEqual(ready.released_kinds, []);
    assert.deepEqual(ready.released_targets, []);
    const released = rows.find((row) => row.id === ids.released) as Row;
    assert.equal(released.released, true);
    assert.deepEqual(released.released_kinds, ['hidden_text', 'untrusted_link']);
    assert.deepEqual(released.released_targets, ['https://outside.example.net/a']);
    assert.deepEqual(released.rescan, {});
  });

  test('every tenant without a key; targets of a quarantine that was never released are not returned', async () => {
    const rows = await candidates(null);
    assert.deepEqual(rows.map((row) => row.id), [ids.ready, ids.released, ids.foreign].sort());
    assert.deepEqual((rows.find((row) => row.id === ids.foreign) as Row).released_targets, []);
    assert.deepEqual((await candidates(tenantB)).map((row) => row.id), [ids.foreign]);
  });

  test('pages by id with p_after and p_limit; a limit outside 1..200 and a tenant key of the other mode are refused', async () => {
    const all = (await candidates(null)).map((row) => String(row.id));
    const first = await candidates(null, null, 1);
    assert.deepEqual(first.map((row) => row.id), [all[0]]);
    assert.deepEqual((await candidates(null, all[0] as string, 50)).map((row) => row.id), all.slice(1));
    for (const limit of [0, 201]) await assert.rejects(candidates(null, null, limit), /invalid_limit/);
    await assert.rejects(candidates('s:default'));
    await assert.rejects(candidates('not-a-key'));
  });

  test('applying the migration again changes nothing', async () => {
    await applyMigrationFiles(fixture.db, [MIGRATION, MIGRATION]);
    assert.deepEqual((await candidates(tenantA)).map((row) => row.id), [ids.ready, ids.released].sort());
  });

  test('one overload, invoker rights, empty search_path, executable by service_role only', async () => {
    const rows = await rowsOf(
      fixture.db,
      `SELECT p.prosecdef AS definer, p.proconfig AS config, p.provolatile AS volatility,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'rag_rescan_candidates'`,
    );
    assert.equal(rows.length, 1);
    const row = rows[0] as Row;
    assert.equal(row.definer, false);
    assert.deepEqual(row.config, ['search_path=""']);
    assert.equal(row.volatility, 's');
    assert.equal(row.anon, false);
    assert.equal(row.authenticated, false);
    assert.equal(row.service_role, true);
  });
});
