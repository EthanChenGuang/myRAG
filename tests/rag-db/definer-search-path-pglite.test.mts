import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles, type MigrationMode } from '../../eval/harness/migrations.mts';

const MIGRATION = 'supabase/migrations/0411_security_definer_search_path.sql';

const FORMERLY_UNFIXED = [
  'can_view_org_member',
  'check_admin_status',
  'delete_folder',
  'get_admin_organization_id',
  'get_folder_stats',
  'get_user_current_org',
  'get_user_org_ids',
  'get_user_role_in_org',
  'is_admin',
  'move_chats_to_folder',
  'share_chat',
  'share_personal_organization',
  'unshare_chat',
];

async function definersWithoutSearchPath(db: PGlite): Promise<{ total: number; missing: string[] }> {
  const result = await db.query<{ sig: string; fixed: boolean }>(
    `SELECT p.oid::regprocedure::text AS sig,
            COALESCE(EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), false) AS fixed
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
      ORDER BY 1`,
  );
  return { total: result.rows.length, missing: result.rows.filter((row) => !row.fixed).map((row) => row.sig) };
}

async function stripSearchPath(db: PGlite): Promise<number> {
  const result = await db.query<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    [FORMERLY_UNFIXED],
  );
  for (const row of result.rows) await db.exec(`ALTER FUNCTION ${row.sig} RESET search_path`);
  return result.rows.length;
}

for (const mode of ['multi-tenant', 'single-tenant'] as MigrationMode[]) {
  describe(`SECURITY DEFINER search_path (${mode})`, () => {
    test('a fresh install leaves every public SECURITY DEFINER function with a fixed search_path', async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      try {
        const { total, missing } = await definersWithoutSearchPath(fixture.db);
        assert.ok(total > 60, `expected the full SECURITY DEFINER inventory, saw ${total}`);
        assert.deepEqual(missing, []);
      } finally {
        await fixture.db.close();
      }
    });

    test('the folded setup file alone leaves every public SECURITY DEFINER function with a fixed search_path', async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        const { total, missing } = await definersWithoutSearchPath(fixture.db);
        assert.ok(total > 60, `expected the full SECURITY DEFINER inventory, saw ${total}`);
        const ledger = await fixture.db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'rag_claim_ingestion_jobs' AND prosecdef");
        assert.equal(ledger.rows[0]?.n, 1, 'the Phase 3.1 definers are in the setup file');
        assert.deepEqual(missing, []);
      } finally {
        await fixture.db.close();
      }
    });

    test('0411 fixes an upgraded database whose functions have no search_path, and re-applies cleanly', async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        const files = migrationFiles(mode);
        assert.ok(files.includes(MIGRATION), `${MIGRATION} is not part of the ${mode} migration order`);
        await applyMigrationFiles(fixture.db, files.filter((file) => file !== MIGRATION));
        const reset = await stripSearchPath(fixture.db);
        assert.ok(reset >= 4, `expected the simulated upgrade state to hold at least 4 of the formerly unfixed functions, saw ${reset}`);
        assert.equal((await definersWithoutSearchPath(fixture.db)).missing.length, reset, 'the simulated upgrade state is not open');

        await applyMigrationFiles(fixture.db, [MIGRATION]);
        assert.deepEqual((await definersWithoutSearchPath(fixture.db)).missing, []);

        await applyMigrationFiles(fixture.db, [MIGRATION]);
        assert.deepEqual((await definersWithoutSearchPath(fixture.db)).missing, []);
      } finally {
        await fixture.db.close();
      }
    });
  });
}
