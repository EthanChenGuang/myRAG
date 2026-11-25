import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText } from '../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../eval/harness/two-tenant.mts';

const QUERY = 'two tenant isolation canary phrase';
const LOCKED = ['match_documents_by_workspace', 'match_document_chunks_by_org', 'get_documents_by_type_slug', 'get_documents_by_type_slug_workspace'];

describe('tenant-id search RPC grants in the multi-tenant schema', () => {
  let fixture: TwoTenantDatabase;

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });
  after(async () => {
    await fixture?.db.close();
  });

  test('anon, authenticated and PUBLIC cannot execute any overload, service_role can', async () => {
    const result = await fixture.db.query<{ proname: string; anon: boolean; authenticated: boolean; service_role: boolean; public_exec: boolean }>(
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true) AS public_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [LOCKED],
    );
    assert.deepEqual(result.rows.map((row) => row.proname).sort(), [...LOCKED].sort());
    for (const row of result.rows) {
      assert.equal(row.anon, false, `${row.proname} executable by anon`);
      assert.equal(row.authenticated, false, `${row.proname} executable by authenticated`);
      assert.equal(row.public_exec, false, `${row.proname} executable by PUBLIC`);
      assert.equal(row.service_role, true, `${row.proname} not executable by service_role`);
    }
  });

  test('calling match_documents_by_workspace as anon with another tenant id is denied, as service_role it works', async () => {
    const call = `SELECT id FROM public.match_documents_by_workspace($1::vector, 100, -1, $2::uuid, NULL)`;
    const args = [`[${embedText(QUERY).join(',')}]`, TWO_TENANT_IDS.orgO];

    await fixture.db.exec('SET ROLE anon');
    try {
      await assert.rejects(fixture.db.query(call, args), /permission denied/i);
    } finally {
      await fixture.db.exec('RESET ROLE');
    }

    await fixture.db.exec('SET ROLE authenticated');
    try {
      await assert.rejects(fixture.db.query(call, args), /permission denied/i);
    } finally {
      await fixture.db.exec('RESET ROLE');
    }

    await fixture.db.exec('SET ROLE service_role');
    try {
      const allowed = await fixture.db.query(call, args);
      assert.ok(allowed.rows.length > 0);
    } finally {
      await fixture.db.exec('RESET ROLE');
    }
  });
});
