import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, applyMigrations, migrationFiles } from '../../eval/harness/migrations.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const frozenSetup = (mode: DeploymentMode): string => `tests/fixtures/sql/pre-phase3-${mode}-setup.sql`;
const FOLDED_SETUP: Record<DeploymentMode, string> = {
  'single-tenant': 'supabase/single-tenant-setup.sql',
  'multi-tenant': 'supabase/multi-tenant-setup.sql',
};

/**
 * Migrations whose final shape is folded into both setup files: Phase 3 (0301-0320, plans 03-47 and later) and Phase 4 (0401-0413, plan 04-42).
 * Phase 3.1 (0351-0358 and the queue hardening 0420-0423, plan 03.1-52), 0424 and Phase 6 (plan 06-45) are not folded yet, so a fresh install from a
 * setup file is completed by those migrations alone.
 */
const FOLDED_MIGRATION = /^supabase\/migrations\/(030[1-9]|031\d|0320|040[1-9]|041[0-3])_[a-z0-9_]+(\.(single|multi)-tenant)?\.sql$/;
const PHASE4_MIGRATION = /^supabase\/migrations\/04(0[1-9]|1\d)_/;
const unfoldedMigrationFiles = (mode: DeploymentMode): string[] => migrationFiles(mode).filter((file) => !FOLDED_MIGRATION.test(file));

/** Every function the Phase 4 migrations create; each one is service-role only (RET-04, D-04). */
const PHASE4_FUNCTIONS = [
  'hybrid_search_chunks',
  'rag_fetch_parents',
  'rag_assert_tenant_key',
  'rag_relex_candidates',
  'rag_relex_batch',
  'rag_lexical_tsvector',
  'rag_lexical_tsquery',
  'rag_chunks_lexical_tsv',
  'rag_chunks_profile_status',
  'rag_write_profile_chunks',
  'rag_list_chunking_profiles',
  'rag_rechunk_missing',
  'rag_rechunk_documents',
  'rag_rechunk_get_run',
  'rag_rechunk_start_run',
  'rag_rechunk_resume_run',
  'rag_rechunk_advance',
  'rag_rechunk_record_gap',
  'rag_rechunk_finish_run',
  'rag_rechunk_gaps',
  'rag_parent_currency_from_document',
  'rag_sync_parent_currency',
  'rag_create_chunking_profile',
  'rag_record_chunking_decision',
  'rag_activate_chunking_profile',
  'rag_rollback_chunking_profile',
  'rag_chunking_coverage',
  'rag_chunking_profile_state',
] as const;

async function reapplyFoldedSetup(db: PGlite, mode: DeploymentMode): Promise<void> {
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, FOLDED_SETUP[mode]), 'utf8'));
}

type CatalogDump = Record<string, string[]>;

function normalizeGrantEntry(serialized: string): string {
  try {
    const row = JSON.parse(serialized) as { signature?: string; acl?: string };
    if (typeof row.acl === 'string' && row.acl.startsWith('{') && row.acl.endsWith('}')) {
      const grants = row.acl
        .slice(1, -1)
        .split(',')
        .filter((entry) => entry.length > 0)
        .sort();
      row.acl = `{${grants.join(',')}}`;
    }
    return JSON.stringify(row);
  } catch {
    return serialized;
  }
}

async function rows(db: PGlite, sql: string, normalizeGrant = false): Promise<string[]> {
  const result = await db.query<Record<string, unknown>>(sql);
  return result.rows
    .map((row) => {
      const serialized = JSON.stringify(row);
      return normalizeGrant ? normalizeGrantEntry(serialized) : serialized;
    })
    .sort();
}

const OUTSIDE_EXTENSIONS = (alias: string): string => `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = ${alias}.oid AND dep.deptype = 'e')`;

/** Columns with types and defaults, constraints, indexes, functions, triggers, policies and function grants of the public schema. */
export async function catalogDump(db: PGlite): Promise<CatalogDump> {
  return {
    columns: await rows(
      db,
      `SELECT c.relname AS "table", a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS "default", a.attgenerated AS generated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped`,
    ),
    rowSecurity: await rows(
      db,
      `SELECT c.relname AS "table", c.relrowsecurity AS enabled FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    ),
    constraints: await rows(
      db,
      `SELECT conrelid::regclass::text AS "table", conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    ),
    indexes: await rows(db, "SELECT tablename AS \"table\", indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'public'"),
    functions: await rows(
      db,
      `SELECT p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND ${OUTSIDE_EXTENSIONS('p')}`,
    ),
    grants: await rows(
      db,
      `SELECT p.oid::regprocedure::text AS signature, p.proacl::text AS acl
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND ${OUTSIDE_EXTENSIONS('p')}`,
      true,
    ),
    triggers: await rows(
      db,
      `SELECT tgrelid::regclass::text AS "table", tgname AS name, pg_get_triggerdef(oid) AS definition FROM pg_trigger
       WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)`,
    ),
    policies: await rows(
      db,
      `SELECT schemaname AS schema, tablename AS "table", policyname AS name, cmd, roles::text AS roles, qual, with_check
       FROM pg_policies WHERE schemaname = 'public'`,
    ),
  };
}

function differences(left: CatalogDump, right: CatalogDump): string[] {
  const out: string[] = [];
  for (const section of Object.keys(left)) {
    const a = new Set(left[section]);
    const b = new Set(right[section]);
    for (const row of a) if (!b.has(row)) out.push(`${section}: only left: ${row.slice(0, 160)}`);
    for (const row of b) if (!a.has(row)) out.push(`${section}: only right: ${row.slice(0, 160)}`);
  }
  return out;
}

async function build(
  mode: DeploymentMode,
  options: { setupSqlPath?: string; apply: 'none' | 'unfolded' | 'all' | 'twice' | 'all-but-last' },
): Promise<{ fixture: FixtureDatabase; dump: CatalogDump }> {
  const empty = await createEmptyFixtureDatabase({
    deploymentMode: mode,
    migrations: false,
    ...(options.setupSqlPath ? { setupSqlPath: options.setupSqlPath } : {}),
  });
  const fixture: FixtureDatabase = {
    db: empty.db,
    fixtureUserId: empty.fixtureUserId,
    corpusSha256: '',
    sqlSha256: empty.sqlSha256,
  };
  try {
    if (options.apply === 'none') {
      // folded setup file alone
    } else if (options.apply === 'unfolded') await applyMigrationFiles(fixture.db, unfoldedMigrationFiles(mode));
    else if (options.apply === 'all-but-last') await applyMigrationFiles(fixture.db, migrationFiles(mode).slice(0, -1));
    else await applyMigrations(fixture.db, mode);
    if (options.apply === 'twice') await applyMigrations(fixture.db, mode);
    return { fixture, dump: await catalogDump(fixture.db) };
  } catch (error) {
    await fixture.db.close();
    throw error;
  }
}

async function assertRagFunctionsNotCallableByClients(db: PGlite): Promise<void> {
  await assertNoClientCallableRagFunctions(db, 'rag_* and match_chunks_by_profile must not be executable by anon or authenticated');
}

async function assertPhase4FunctionsServiceRoleOnly(db: PGlite): Promise<void> {
  const result = await db.query<{ proname: string; signature: string; trigger: boolean; anon: boolean; authenticated: boolean; service_role: boolean }>(
    `SELECT p.proname, p.oid::regprocedure::text AS signature, p.prorettype = 'trigger'::regtype AS trigger,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    [[...PHASE4_FUNCTIONS]],
  );
  const present = new Set(result.rows.map((row) => row.proname));
  assert.deepEqual(PHASE4_FUNCTIONS.filter((name) => !present.has(name)), [], 'every Phase 4 function is defined by the setup file');
  assert.deepEqual(
    result.rows.filter((row) => row.anon || row.authenticated).map((row) => row.signature),
    [],
    'anon and authenticated have no EXECUTE on a Phase 4 function',
  );
  // Trigger functions run without an EXECUTE check, so some are revoked from every role; every callable function is granted to service_role.
  assert.deepEqual(
    result.rows.filter((row) => !row.trigger && !row.service_role).map((row) => row.signature),
    [],
    'service_role can execute every callable Phase 4 function',
  );
}

async function tenantKeyGuardError(db: PGlite, tenantKey: string): Promise<string | null> {
  try {
    await db.query('SELECT public.rag_assert_tenant_key($1)', [tenantKey]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const SAMPLE_UUID = '00000000-0000-4000-8000-000000000001';

for (const mode of MODES) {
  describe(`schema equality (${mode})`, () => {
    test('the frozen pre-Phase-3 setup file carries none of the Phase 3 objects', () => {
      const frozen = fs.readFileSync(path.join(REPO_ROOT, frozenSetup(mode)), 'utf8');
      for (const needle of ['lineage_id', 'tenant_key', 'rag_documents_legacy_defaults', 'is_current']) {
        assert.ok(!frozen.includes(needle), `${frozenSetup(mode)} must stay the pre-Phase-3 file (found ${needle})`);
      }
    });

    test('frozen setup plus migrations equals current setup plus migrations', async () => {
      const frozen = await build(mode, { setupSqlPath: frozenSetup(mode), apply: 'all' });
      const current = await build(mode, { apply: 'all' });
      try {
        assert.deepEqual(Object.keys(frozen.fixture.sqlSha256), [frozenSetup(mode)], 'the frozen file was loaded as the setup');
        assert.deepEqual(differences(frozen.dump, current.dump), []);
      } finally {
        await frozen.fixture.db.close();
        await current.fixture.db.close();
      }
    });

    test('applying the migrations twice equals applying them once', async () => {
      const once = await build(mode, { apply: 'all' });
      const twice = await build(mode, { apply: 'twice' });
      try {
        assert.deepEqual(differences(once.dump, twice.dump), []);
      } finally {
        await once.fixture.db.close();
        await twice.fixture.db.close();
      }
    });

    test('the dump has teeth: leaving out the last migration shows up as a difference', async () => {
      const full = await build(mode, { apply: 'all' });
      const partial = await build(mode, { apply: 'all-but-last' });
      try {
        const found = differences(full.dump, partial.dump);
        assert.ok(found.length > 0);
        assert.ok(found.some((line) => line.startsWith('functions:')));
      } finally {
        await full.fixture.db.close();
        await partial.fixture.db.close();
      }
    });
  });
}

describe('folded migration set', () => {
  for (const mode of MODES) {
    test(`every Phase 4 migration of ${mode} is folded into the setup file`, () => {
      const phase4 = migrationFiles(mode).filter((file) => PHASE4_MIGRATION.test(file));
      assert.ok(phase4.length >= 13);
      assert.deepEqual(phase4.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });
  }
});

for (const mode of MODES) {
  describe(`${mode} setup`, () => {
    test(`${mode} setup applies cleanly on fresh PGlite`, async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true, migrations: false });
      try {
        assert.deepEqual(Object.keys(fixture.sqlSha256), [FOLDED_SETUP[mode]], 'the setup file alone was loaded, no migration');
        await assertRagFunctionsNotCallableByClients(fixture.db);
        await assertPhase4FunctionsServiceRoleOnly(fixture.db);
        const tables = await fixture.db.query<{ name: string }>(
          `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
             AND c.relname IN ('document_parents', 'chunking_profiles', 'chunking_build_runs', 'chunking_build_gaps') ORDER BY 1`,
        );
        assert.deepEqual(tables.rows.map((row) => row.name), ['chunking_build_gaps', 'chunking_build_runs', 'chunking_profiles', 'document_parents']);
        const ownKeys = mode === 'single-tenant' ? ['s:default'] : [`u:${SAMPLE_UUID}`, `o:${SAMPLE_UUID}`];
        const foreignKeys = mode === 'single-tenant' ? [`u:${SAMPLE_UUID}`, `o:${SAMPLE_UUID}`] : ['s:default'];
        for (const key of ownKeys) assert.equal(await tenantKeyGuardError(fixture.db, key), null, `${key} is a ${mode} tenant key`);
        for (const key of foreignKeys) assert.match(String(await tenantKeyGuardError(fixture.db, key)), /not valid for this deployment mode/);
        assert.match(String(await tenantKeyGuardError(fixture.db, 'x:bad')), /malformed tenant key/);
      } finally {
        await fixture.db.close();
      }
    });

    test(`${mode} setup equals the migrated schema`, async () => {
      const folded = await build(mode, { apply: 'unfolded' });
      const migrated = await build(mode, { setupSqlPath: frozenSetup(mode), apply: 'all' });
      try {
        assert.deepEqual(differences(folded.dump, migrated.dump), []);
        const legacyGrants = (dump: CatalogDump) => dump.grants.filter((row) => row.includes('"signature":"match_'));
        assert.ok(legacyGrants(migrated.dump).length > 0, 'the legacy match_* RPCs are part of the comparison');
        assert.deepEqual(legacyGrants(folded.dump), legacyGrants(migrated.dump), 'legacy match_* grants are unchanged');
      } finally {
        await folded.fixture.db.close();
        await migrated.fixture.db.close();
      }
    });

    test(`${mode} setup is unchanged by re-applying migrations`, async () => {
      const once = await build(mode, { apply: 'unfolded' });
      const twice = await build(mode, { apply: 'all' });
      try {
        assert.deepEqual(differences(once.dump, twice.dump), []);
      } finally {
        await once.fixture.db.close();
        await twice.fixture.db.close();
      }
    });

    test(`${mode} folded setup is safe to re-run on an existing schema`, async () => {
      const empty = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        const dumpBefore = await catalogDump(empty.db);
        await reapplyFoldedSetup(empty.db, mode);
        const dumpAfter = await catalogDump(empty.db);
        assert.deepEqual(differences(dumpBefore, dumpAfter), []);
      } finally {
        await empty.db.close();
      }
    });
  });
}

describe('setup-database.sh --list-migrations', () => {
  const run = (...args: string[]) =>
    spawnSync('bash', ['scripts/setup-database.sh', ...args], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }, encoding: 'utf8' });

  for (const mode of MODES) {
    test(`prints exactly migrationFiles('${mode}') in order without needing Supabase environment variables`, () => {
      const result = run('--list-migrations', mode);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split('\n'), migrationFiles(mode));
    });
  }

  test('rejects an unknown mode and a missing mode with a usage message and exit code 2', () => {
    for (const args of [['--list-migrations', 'both'], ['--list-migrations']]) {
      const result = run(...args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /single-tenant\|multi-tenant/);
    }
  });
});
