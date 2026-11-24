import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles, type MigrationMode } from '../../eval/harness/migrations.mts';
import { AUTHENTICATED_ALLOW_LIST } from '../helpers/security-definer-allow-list';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REVOKE_MIGRATION = 'supabase/migrations/0409_search_rpc_revoke.sql';
const GRANTS_MIGRATION = 'supabase/migrations/0410_security_definer_rpc_grants.sql';

const LOCKED = [
  'match_documents_by_workspace',
  'match_document_chunks_by_org',
  'get_documents_by_type_slug',
  'get_documents_by_type_slug_workspace',
] as const;

/** Simulates a multi-tenant DB that ran 0306 CREATE OR REPLACE while anon still had EXECUTE from an older grant. */
const LIVE_HOLE_GRANTS = `
GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_document_chunks_by_org(uuid, vector, integer, double precision) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug(uuid, text, text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO PUBLIC, anon, authenticated;
`;

type PrivRow = {
  proname: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  public_exec: boolean;
};

async function privileges(db: PGlite): Promise<PrivRow[]> {
  const result = await db.query<PrivRow>(
    `SELECT p.proname,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
            COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true) AS public_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [LOCKED],
  );
  return result.rows;
}

function assertLockedDown(rows: PrivRow[]): void {
  assert.deepEqual(rows.map((row) => row.proname).sort(), [...LOCKED].sort());
  for (const row of rows) {
    assert.equal(row.anon, false, `${row.proname} executable by anon`);
    assert.equal(row.authenticated, false, `${row.proname} executable by authenticated`);
    assert.equal(row.public_exec, false, `${row.proname} executable by PUBLIC`);
    assert.equal(row.service_role, true, `${row.proname} not executable by service_role`);
  }
}

describe('0409_search_rpc_revoke migration (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    const fixture = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', migrations: false });
    db = fixture.db;
    const beforeRevoke = migrationFiles('multi-tenant').filter((file) => file !== REVOKE_MIGRATION);
    await applyMigrationFiles(db, beforeRevoke);
    await db.exec(LIVE_HOLE_GRANTS);
  });

  after(async () => {
    await db?.close();
  });

  test('tenant search RPCs deny anon after the migration stack (0409 required)', async () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, REVOKE_MIGRATION)), `${REVOKE_MIGRATION} missing`);
    await applyMigrationFiles(db, [REVOKE_MIGRATION]);
    assertLockedDown(await privileges(db));
  });

  test('0409 is idempotent on re-apply', async () => {
    await applyMigrationFiles(db, [REVOKE_MIGRATION]);
    assertLockedDown(await privileges(db));
  });
});

/** The state a hosted project reaches after CREATE OR REPLACE kept older grants: every role may execute every function. */
const EVERYTHING_OPEN = 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC, anon, authenticated, service_role;';

interface DefinerRow {
  sig: string;
  proname: string;
  is_trigger: boolean;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  public_exec: boolean;
}

async function definerInventory(db: PGlite): Promise<DefinerRow[]> {
  const result = await db.query<DefinerRow>(
    `SELECT p.oid::regprocedure::text AS sig, p.proname,
            p.prorettype = 'trigger'::regtype AS is_trigger,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
            COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true) AS public_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
      ORDER BY 1`,
  );
  return result.rows;
}

function assertFullInventory(rows: DefinerRow[]): void {
  assert.ok(rows.length > 60, `expected the full SECURITY DEFINER inventory, saw ${rows.length} functions`);
  const names = new Set(rows.map((row) => row.proname));
  for (const name of [...LOCKED, 'rag_begin_document_version', 'rag_write_chunks', 'rag_publish_document_version']) {
    assert.ok(names.has(name), `${name} missing from the inventory`);
  }
  const problems: string[] = [];
  for (const row of rows) {
    const allow = AUTHENTICATED_ALLOW_LIST[row.proname];
    if (row.public_exec) problems.push(`${row.sig} executable by PUBLIC`);
    if (!row.service_role) problems.push(`${row.sig} not executable by service_role`);
    if (allow) {
      if (!row.authenticated) problems.push(`${row.sig} allow-listed but authenticated cannot execute it`);
      if (row.anon !== allow.anon) problems.push(`${row.sig} anon EXECUTE is ${row.anon}, allow-list says ${allow.anon}`);
    } else {
      if (row.anon) problems.push(`${row.sig} executable by anon`);
      if (row.authenticated) problems.push(`${row.sig} executable by authenticated`);
    }
  }
  assert.deepEqual(problems, []);
}

for (const mode of ['multi-tenant', 'single-tenant'] as MigrationMode[]) {
  describe(`0410_security_definer_rpc_grants (${mode})`, () => {
    test('a fresh install (folded setup file, then every migration, with hosted Supabase default function grants) leaves no SECURITY DEFINER function open to anon or PUBLIC', async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseFunctionDefaults: true });
      try {
        assertFullInventory(await definerInventory(fixture.db));
      } finally {
        await fixture.db.close();
      }
    });

    test('an upgraded database whose functions all kept their old open grants is locked by 0409 and 0410, and both re-apply cleanly', async () => {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, GRANTS_MIGRATION)), `${GRANTS_MIGRATION} missing`);
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false, supabaseFunctionDefaults: true });
      try {
        const files = migrationFiles(mode);
        const before = files.filter((file) => file !== REVOKE_MIGRATION && file !== GRANTS_MIGRATION);
        await applyMigrationFiles(fixture.db, before);
        await fixture.db.exec(EVERYTHING_OPEN);
        const open = await definerInventory(fixture.db);
        assert.ok(open.some((row) => row.anon && row.public_exec), 'the simulated upgrade state is not open');

        await applyMigrationFiles(fixture.db, files.filter((file) => file === REVOKE_MIGRATION || file === GRANTS_MIGRATION));
        assertFullInventory(await definerInventory(fixture.db));

        await applyMigrationFiles(fixture.db, files.filter((file) => file === REVOKE_MIGRATION || file === GRANTS_MIGRATION));
        assertFullInventory(await definerInventory(fixture.db));
      } finally {
        await fixture.db.close();
      }
    });
  });
}
