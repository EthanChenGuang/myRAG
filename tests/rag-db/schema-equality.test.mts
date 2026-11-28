import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  createEmptyFixtureDatabase,
  SUPABASE_GRANTS_SQL,
  SUPABASE_SHIM_SQL,
  type DeploymentMode,
  type FixtureDatabase,
} from '../../eval/harness/pglite-supabase.mts';
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
 * Migrations whose final shape is folded into both setup files: Phase 3 (0301-0320, plans 03-47 and later), Phase 3.1 (0351-0359, and the queue
 * hardening and chunk writer fix 0420-0424 after Phase 4, plan 03.1-52), Phase 4 (0401-0413, plan 04-42) and the empty search_path rewrite 0425
 * after 0424 (plan 04-47), Phase 3.1.1 (0440-0442, plan 03.1.1-14), Phase 5 (0501-0502, plan 05-25), Phase 5.1.1 (0531-0537, plan
 * 05.1.1-22), Phase 6 (0601-0603, plan 06-45), Phase 4.1.1 (0471-0473, plan 04.1.1-14), Phase 6.1 (0651-0654, plan 06.1-18) and Phase 7
 * (0701-0707, plan 07-31). 0426, 0427, 0708 onward (0740 and later included) and the 08xx and later blocks are not folded yet, so a fresh install
 * from a setup file is completed by those migrations alone.
 */
const FOLDED_MIGRATION = /^supabase\/migrations\/(030[1-9]|031\d|0320|035[1-9]|040[1-9]|041[0-3]|042[0-5]|044[0-2]|047[1-3]|050[12]|053[1-7]|060[1-3]|065[1-4]|070[1-7])_[a-z0-9_]+(\.(single|multi)-tenant)?\.sql$/;
const PHASE4_MIGRATION = /^supabase\/migrations\/04(0[1-9]|1\d)_/;
const PHASE31_MIGRATION = /^supabase\/migrations\/(035[1-9]|042[0-4])_/;
const PHASE5_MIGRATION = /^supabase\/migrations\/050\d_/;
const PHASE311_MIGRATION = /^supabase\/migrations\/044\d_/;
const PHASE511_MIGRATION = /^supabase\/migrations\/053\d_/;
const PHASE6_MIGRATION = /^supabase\/migrations\/060\d_/;
const PHASE61_MIGRATION = /^supabase\/migrations\/065\d_/;
const PHASE411_MIGRATION = /^supabase\/migrations\/047\d_/;
const PHASE7_FOLDED_MIGRATION = /^supabase\/migrations\/070[1-7]_/;
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
       FROM pg_policies WHERE schemaname IN ('public', 'realtime')`,
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
        assert.ok(found.some((line) => /^(functions|columns|constraints|triggers):/.test(line)));
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

    test(`every Phase 3.1 migration of ${mode} is folded into the setup file`, () => {
      const phase31 = migrationFiles(mode).filter((file) => PHASE31_MIGRATION.test(file));
      assert.ok(phase31.length >= 15);
      assert.deepEqual(phase31.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });

    test(`every Phase 5 migration of ${mode} is folded into the setup file`, () => {
      const phase5 = migrationFiles(mode).filter((file) => PHASE5_MIGRATION.test(file));
      assert.deepEqual(phase5, ['supabase/migrations/0501_rag_answer_records.sql', `supabase/migrations/0502_rag_answer_records_tenant.${mode}.sql`]);
      assert.deepEqual(phase5.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });

    test(`every Phase 3.1.1 migration of ${mode} is folded into the setup file`, () => {
      const phase311 = migrationFiles(mode).filter((file) => PHASE311_MIGRATION.test(file));
      assert.deepEqual(phase311, [
        'supabase/migrations/0440_embedding_bindings.sql',
        'supabase/migrations/0441_binding_gate.sql',
        'supabase/migrations/0442_reembed_scope.sql',
      ]);
      assert.deepEqual(phase311.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });

    test(`every Phase 5.1.1 migration of ${mode} is folded into the setup file`, () => {
      const phase511 = migrationFiles(mode).filter((file) => PHASE511_MIGRATION.test(file));
      assert.deepEqual(phase511, [
        'supabase/migrations/0531_rag_retrieval_log.sql',
        `supabase/migrations/0532_rag_retrieval_log_tenant.${mode}.sql`,
        'supabase/migrations/0533_rag_retrieval_log_functions.sql',
        'supabase/migrations/0534_rag_feedback_review.sql',
        'supabase/migrations/0535_rag_feedback_mining.sql',
        'supabase/migrations/0536_rag_retrieval_log_source_opened.sql',
        'supabase/migrations/0537_rag_feedback_mining_report.sql',
      ]);
      assert.deepEqual(phase511.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });

    test(`every Phase 6 migration of ${mode} is folded into the setup file`, () => {
      const phase6 = migrationFiles(mode).filter((file) => PHASE6_MIGRATION.test(file));
      assert.deepEqual(phase6, [
        'supabase/migrations/0601_tenant_language_shares.sql',
        'supabase/migrations/0602_hybrid_include_undated.sql',
        'supabase/migrations/0603_semantic_cache.sql',
      ]);
      assert.deepEqual(phase6.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });

    test(`every Phase 6.1 migration of ${mode} is folded into the setup file`, () => {
      const phase61 = migrationFiles(mode).filter((file) => PHASE61_MIGRATION.test(file));
      assert.deepEqual(phase61, [
        'supabase/migrations/0651_finetune_registry.sql',
        'supabase/migrations/0652_finetune_slots.sql',
        'supabase/migrations/0653_finetune_export.sql',
        'supabase/migrations/0654_finetune_binding_guard.sql',
      ]);
      assert.deepEqual(phase61.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });

    test(`migrations 0701 to 0707 of ${mode} are folded and 0708 onward are not`, () => {
      const phase7 = migrationFiles(mode).filter((file) => /^supabase\/migrations\/07\d\d_/.test(file));
      const folded = phase7.filter((file) => FOLDED_MIGRATION.test(file));
      assert.deepEqual(folded, phase7.filter((file) => PHASE7_FOLDED_MIGRATION.test(file)));
      assert.equal(folded.length, 7, 'one common file per number from 0701 to 0707, no mode variant');
      assert.ok(phase7.some((file) => file.startsWith('supabase/migrations/0740_')), '0740 is applied on top of the setup file');
    });

    test(`every Phase 4.1.1 migration of ${mode} is folded into the setup file`, () => {
      const phase411 = migrationFiles(mode).filter((file) => PHASE411_MIGRATION.test(file));
      assert.deepEqual(phase411, [
        'supabase/migrations/0471_terminology_schema.sql',
        'supabase/migrations/0472_terminology_writers.sql',
        'supabase/migrations/0473_terminology_mining.sql',
      ]);
      assert.deepEqual(phase411.filter((file) => !FOLDED_MIGRATION.test(file)), []);
    });
  }
});

/** Every function 0651-0654 create; each one is service-role only with an empty search_path (Phase 6.1 D-32). */
const PHASE61_FUNCTIONS = [
  'rag_finetune_set_consent',
  'rag_finetune_list_consent',
  'rag_finetune_consent_for_export',
  'rag_finetune_register_model',
  'rag_finetune_list_models',
  'rag_finetune_set_model_status',
  'rag_finetune_slot_guard',
  'rag_finetune_bind_slot',
  'rag_finetune_clear_slot',
  'rag_finetune_release_rollback',
  'rag_finetune_version_taint_guard',
  'rag_finetune_export_vectors',
  'rag_finetune_normalize_doc_types',
  'rag_finetune_bind_scoped_slot',
  'rag_finetune_scope_slot',
  'rag_finetune_binding_guard',
  'rag_finetune_backfill_run_guard',
] as const;

/** The 0651-0654 schema as a fresh install gets it: both tables locked to service_role with RLS, the two unbound slot rows, the new functions
 * service-role only with an empty search_path, and the 0654 bodies (not the 0652 ones they replace). */
async function assertFinetuneSecured(db: PGlite): Promise<void> {
  for (const table of ['rag_finetune_consent', 'embedding_model_versions']) {
    const rls = await db.query<{ rls: boolean }>('SELECT relrowsecurity AS rls FROM pg_class WHERE oid = to_regclass($1)', [`public.${table}`]);
    assert.equal(rls.rows[0]?.rls, true, `${table} exists with row level security enabled`);
    const held = await db.query<{ role: string; privilege: string }>(
      `SELECT r.role, p.privilege FROM unnest(ARRAY['anon', 'authenticated']) AS r(role),
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
       WHERE has_table_privilege(r.role, $1, p.privilege)`,
      [`public.${table}`],
    );
    assert.deepEqual(held.rows, [], `clients have no privilege on ${table}`);
  }
  const slots = await db.query<{ id: string; model: string; status: string }>(
    "SELECT id, model, status FROM public.embedding_profiles WHERE id IN ('ft-a-1024', 'ft-b-1024') ORDER BY id",
  );
  assert.deepEqual(slots.rows, [
    { id: 'ft-a-1024', model: 'unbound', status: 'available' },
    { id: 'ft-b-1024', model: 'unbound', status: 'available' },
  ]);
  const functions = await db.query<{ proname: string; signature: string; config: string[] | null; anon: boolean; authenticated: boolean; service_role: boolean }>(
    `SELECT p.proname, p.oid::regprocedure::text AS signature, p.proconfig AS config,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    [[...PHASE61_FUNCTIONS]],
  );
  const present = new Set(functions.rows.map((row) => row.proname));
  assert.deepEqual(PHASE61_FUNCTIONS.filter((name) => !present.has(name)), [], 'every 0651-0654 function is defined by the setup file');
  assert.equal(functions.rows.length, PHASE61_FUNCTIONS.length, 'one overload per 0651-0654 function');
  for (const row of functions.rows) {
    assert.ok(!row.anon && !row.authenticated, `${row.signature} is not executable by anon or authenticated`);
    assert.ok(row.service_role, `${row.signature} is executable by service_role`);
    assert.ok((row.config ?? []).includes('search_path=""'), `${row.signature} pins an empty search_path (${JSON.stringify(row.config)})`);
  }
  const clear = await functionSource(db, 'rag_finetune_clear_slot(text,text,integer)');
  assert.ok(clear?.includes('embedding_profile_bindings'), 'rag_finetune_clear_slot carries the 0654 body, not the 0652 one');
  for (const trigger of ['rag_finetune_binding_guard', 'rag_finetune_backfill_run_guard', 'rag_finetune_slot_guard', 'rag_finetune_version_taint_guard']) {
    const found = await db.query('SELECT 1 FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal', [trigger]);
    assert.equal(found.rows.length, 1, `trigger ${trigger} exists once`);
  }
}

/** Every function 0440-0442 create; each one is service-role only with an empty search_path (D-06, D-16). */
const PHASE311_FUNCTIONS = [
  'rag_embedding_profiles_scope_guard',
  'rag_embedding_bindings_guard',
  'rag_list_embedding_bindings',
  'rag_list_embedding_profile_scopes',
  'rag_create_embedding_binding',
  'rag_set_embedding_binding_status',
  'rag_record_binding_evidence',
  'rag_activate_embedding_binding',
  'rag_rollback_embedding_binding',
  'rag_deactivate_embedding_binding',
  'rag_reembed_require_binding',
] as const;

/** The 0440-0442 schema as a fresh install gets it: the bindings table locked to service_role, the doc_types scope, the seeded candidates, their
 * indexes, the new functions and the scoped guard and re-embed bodies (not the 0425 ones they replace). */
async function assertDomainBindingsSecured(db: PGlite): Promise<void> {
  const table = await db.query<{ rls: boolean }>("SELECT relrowsecurity AS rls FROM pg_class WHERE oid = to_regclass('public.embedding_profile_bindings')");
  assert.equal(table.rows[0]?.rls, true, 'embedding_profile_bindings exists with row level security enabled');
  const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  const held = await db.query<{ role: string; privilege: string }>(
    `SELECT r.role, p.privilege FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role), unnest($1::text[]) AS p(privilege)
     WHERE has_table_privilege(r.role, 'public.embedding_profile_bindings', p.privilege) ORDER BY 1, 2`,
    [privileges],
  );
  assert.deepEqual(held.rows.filter((row) => row.role !== 'service_role'), [], 'clients have no privilege on embedding_profile_bindings');
  assert.deepEqual(held.rows.filter((row) => row.role === 'service_role').map((row) => row.privilege), [...privileges].sort());
  const column = await db.query<{ type: string }>(
    "SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'public.embedding_profiles'::regclass AND attname = 'doc_types'",
  );
  assert.equal(column.rows[0]?.type, 'text[]', 'embedding_profiles.doc_types');
  const seeded = await db.query<{ id: string; status: string; doc_types: string[] }>(
    "SELECT id, status, doc_types FROM public.embedding_profiles WHERE doc_types IS NOT NULL ORDER BY id",
  );
  assert.deepEqual(seeded.rows, [
    { id: 'voyage-4-large-1024-domain', status: 'available', doc_types: ['contract_legal', 'financial_report', 'invoice_receipt'] },
    { id: 'voyage-finance-2-1024', status: 'available', doc_types: ['financial_report', 'invoice_receipt'] },
    { id: 'voyage-law-2-1024', status: 'available', doc_types: ['contract_legal'] },
  ]);
  const indexes = await db.query<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'
       AND indexname IN ('chunk_embeddings_voyage_law_2_1024_hnsw', 'chunk_embeddings_voyage_finance_2_1024_hnsw',
                         'chunk_embeddings_voyage_4_large_1024_domain_hnsw', 'embedding_profile_bindings_single_active',
                         'embedding_profile_bindings_single_backfilling', 'embedding_profile_bindings_triple_ux') ORDER BY 1`,
  );
  assert.equal(indexes.rows.length, 6, `the 0440 indexes: ${indexes.rows.map((row) => row.name).join(', ')}`);
  const functions = await db.query<{ proname: string; signature: string; config: string[] | null; anon: boolean; authenticated: boolean; service_role: boolean }>(
    `SELECT p.proname, p.oid::regprocedure::text AS signature, p.proconfig AS config,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    [[...PHASE311_FUNCTIONS]],
  );
  const present = new Set(functions.rows.map((row) => row.proname));
  assert.deepEqual(PHASE311_FUNCTIONS.filter((name) => !present.has(name)), [], 'every 0440-0442 function is defined by the setup file');
  for (const row of functions.rows) {
    assert.ok(!row.anon && !row.authenticated, `${row.signature} is not executable by anon or authenticated`);
    assert.ok(row.service_role, `${row.signature} is executable by service_role`);
    assert.ok((row.config ?? []).includes('search_path=""'), `${row.signature} pins an empty search_path (${JSON.stringify(row.config)})`);
  }
  for (const signature of ['rag_chunk_embeddings_guard()', 'rag_reembed_pick(text,text,uuid,integer)', 'rag_reembed_start_run(text,text,text,text)']) {
    const source = await functionSource(db, signature);
    assert.ok(source?.includes('doc_types'), `${signature} carries the 0440/0442 doc-type scope`);
  }
}

const ANSWER_RECORD_TENANT_KEY: Record<DeploymentMode, RegExp> = {
  'single-tenant': /^'s:default'::text$/,
  'multi-tenant': /^CASE WHEN \(organization_id IS NOT NULL\) THEN \('o:'::text \|\| \(organization_id\)::text\) ELSE \('u:'::text \|\| \(user_id\)::text\) END$/,
};

/** rag_answer_records as a fresh install gets it: RLS on, the select-own policy, the mode's tenant key, no anon privilege, SELECT only for clients. */
async function assertAnswerRecordsSecured(db: PGlite, mode: DeploymentMode): Promise<void> {
  const table = await db.query<{ rls: boolean }>("SELECT relrowsecurity AS rls FROM pg_class WHERE oid = to_regclass('public.rag_answer_records')");
  assert.equal(table.rows[0]?.rls, true, 'rag_answer_records exists with row level security enabled');
  const tenantKey = await db.query<{ generated: string; expr: string }>(
    `SELECT a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS expr FROM pg_attribute a
     JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.rag_answer_records'::regclass AND a.attname = 'tenant_key'`,
  );
  assert.equal(tenantKey.rows[0]?.generated, 's', 'tenant_key is a stored generated column');
  assert.match(String(tenantKey.rows[0]?.expr).replace(/\s+/g, ' ').trim(), ANSWER_RECORD_TENANT_KEY[mode], `tenant_key uses the ${mode} expression`);
  const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  const held = await db.query<{ role: string; privilege: string }>(
    `SELECT r.role, p.privilege FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role), unnest($1::text[]) AS p(privilege)
     WHERE has_table_privilege(r.role, 'public.rag_answer_records', p.privilege) ORDER BY 1, 2`,
    [privileges],
  );
  const byRole = (role: string) => held.rows.filter((row) => row.role === role).map((row) => row.privilege);
  assert.deepEqual(byRole('anon'), [], 'anon has no privilege on rag_answer_records');
  assert.deepEqual(byRole('authenticated'), ['SELECT'], 'authenticated may only read rag_answer_records');
  assert.deepEqual(byRole('service_role'), [...privileges].sort(), 'service_role writes rag_answer_records');
  const policies = await db.query<{ name: string; cmd: string; roles: string; qual: string }>(
    "SELECT policyname AS name, cmd, roles::text AS roles, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rag_answer_records'",
  );
  assert.deepEqual(policies.rows, [{ name: 'rag_answer_records_select_own', cmd: 'SELECT', roles: '{authenticated}', qual: '(user_id = auth.uid())' }]);
}

const FEEDBACK_TABLES = ['rag_domain_experts', 'rag_retrieval_log', 'rag_review_items', 'rag_tenant_feedback_settings'];
const FEEDBACK_SERVICE_ROLE_FUNCTIONS = [
  'rag_feedback_loop_on_chat_delete()',
  'rag_mine_failed_queries(timestamptz, timestamptz, jsonb)',
  'rag_mine_failed_queries_report(timestamptz, timestamptz, jsonb)',
  'rag_purge_retrieval_log(integer, integer)',
  'rag_record_source_opened(text, uuid)',
];
const LANGUAGE_COLUMNS: Record<string, string> = {
  query_language: 'text',
  query_language_confidence: 'real',
  chunk_languages: 'text[]',
  answer_language: 'text',
};

/** The Phase 5.1.1 schema as a fresh install gets it (D-03a, D-29): RLS on every table, no anon privilege, the language snapshot columns with
 * their checks on the log and the review items, the tags column, the mode's tenant key and the functions locked to their roles. */
async function assertFeedbackLoopSecured(db: PGlite, mode: DeploymentMode): Promise<void> {
  const tables = await db.query<{ name: string; rls: boolean }>(
    `SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1`,
    [FEEDBACK_TABLES],
  );
  assert.deepEqual(tables.rows, FEEDBACK_TABLES.map((name) => ({ name, rls: true })), 'the feedback-loop tables exist with row level security');
  for (const table of FEEDBACK_TABLES) {
    const anon = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
       WHERE has_table_privilege('anon', $1, p.privilege)`,
      [`public.${table}`],
    );
    assert.equal(anon.rows[0]?.n, 0, `anon has no privilege on ${table}`);
  }
  const logClient = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(privilege)
     WHERE has_table_privilege('authenticated', 'public.rag_retrieval_log', p.privilege)`,
  );
  assert.equal(logClient.rows[0]?.n, 0, 'authenticated has no privilege on rag_retrieval_log');
  for (const table of ['rag_retrieval_log', 'rag_review_items']) {
    const columns = await db.query<{ name: string; type: string }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY($2::text[]) ORDER BY 1`,
      [`public.${table}`, Object.keys(LANGUAGE_COLUMNS)],
    );
    assert.deepEqual(
      Object.fromEntries(columns.rows.map((row) => [row.name, row.type])),
      LANGUAGE_COLUMNS,
      `${table} carries the D-03a language columns`,
    );
    const checks = await db.query<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' AND conname = ANY($2::text[]) ORDER BY 1`,
      [`public.${table}`, Object.keys(LANGUAGE_COLUMNS).map((column) => `${table}_${column}_check`)],
    );
    assert.equal(checks.rows.length, 4, `${table} checks each language column`);
    const tenantKey = await db.query<{ generated: string }>(
      `SELECT a.attgenerated AS generated FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = 'tenant_key'`,
      [`public.${table}`],
    );
    assert.ok(tenantKey.rows.length === 1, `${table} has tenant_key`);
  }
  const logKey = await db.query<{ expr: string }>(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.rag_retrieval_log'::regclass AND a.attname = 'tenant_key'`,
  );
  assert.match(String(logKey.rows[0]?.expr).replace(/\s+/g, ' ').trim(), ANSWER_RECORD_TENANT_KEY[mode], `rag_retrieval_log.tenant_key uses the ${mode} expression`);
  const tags = await db.query<{ type: string; check: string | null }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type,
            (SELECT conname FROM pg_constraint WHERE conrelid = a.attrelid AND conname = 'rag_review_items_tags_check') AS check
     FROM pg_attribute a WHERE a.attrelid = 'public.rag_review_items'::regclass AND a.attname = 'tags'`,
  );
  assert.deepEqual(tags.rows, [{ type: 'text[]', check: 'rag_review_items_tags_check' }], 'rag_review_items carries the D-29 tags column');
  for (const signature of FEEDBACK_SERVICE_ROLE_FUNCTIONS) {
    const acl = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') AS anon,
              has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE') AS service`,
      [`public.${signature}`],
    );
    assert.deepEqual(acl.rows[0], { anon: false, authenticated: false, service: true }, `${signature} is service_role only`);
  }
  const expert = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
    `SELECT has_function_privilege('anon', to_regprocedure('public.rag_is_domain_expert(text)'), 'EXECUTE') AS anon,
            has_function_privilege('authenticated', to_regprocedure('public.rag_is_domain_expert(text)'), 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', to_regprocedure('public.rag_is_domain_expert(text)'), 'EXECUTE') AS service`,
  );
  assert.deepEqual(expert.rows[0], { anon: false, authenticated: true, service: true }, 'rag_is_domain_expert is the RLS helper for authenticated');
}

/** Every function 0601-0603 create; each one is service-role only (D-23, D-34). */
const PHASE6_FUNCTIONS = [
  'rag_tenant_language_shares',
  'hybrid_search_chunks',
  'rag_cache_sources_current',
  'rag_cache_check',
  'rag_cache_store',
  'rag_cache_invalidate',
  'rag_cache_resolve_sources',
  'rag_semantic_cache_on_documents_insert',
  'rag_semantic_cache_on_documents_update',
  'rag_semantic_cache_on_documents_delete',
] as const;

/** The Phase 6 schema as a fresh install gets it: one hybrid_search_chunks overload (the 0602 one with p_include_undated), every Phase 6
 * function service_role only, and the semantic cache table with RLS, no client privilege and its three documents triggers. */
async function assertPhase6Secured(db: PGlite): Promise<void> {
  const overloads = await db.query<{ args: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'hybrid_search_chunks'`,
  );
  assert.equal(overloads.rows.length, 1, 'exactly one hybrid_search_chunks overload');
  assert.match(String(overloads.rows[0]?.args), /p_include_undated boolean$/, 'the folded hybrid_search_chunks is the 0602 one');
  const result = await db.query<{ proname: string; signature: string; anon: boolean; authenticated: boolean; service_role: boolean }>(
    `SELECT p.proname, p.oid::regprocedure::text AS signature,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    [[...PHASE6_FUNCTIONS]],
  );
  const present = new Set(result.rows.map((row) => row.proname));
  assert.deepEqual(PHASE6_FUNCTIONS.filter((name) => !present.has(name)), [], 'every Phase 6 function is defined by the setup file');
  assert.deepEqual(
    result.rows.filter((row) => row.anon || row.authenticated || !row.service_role).map((row) => row.signature),
    [],
    'every Phase 6 function is service_role only',
  );
  const table = await db.query<{ rls: boolean; policies: number }>(
    `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = c.relname) AS policies
     FROM pg_class c WHERE c.oid = to_regclass('public.rag_semantic_cache')`,
  );
  assert.deepEqual(table.rows, [{ rls: true, policies: 0 }], 'rag_semantic_cache has RLS on and no policy');
  for (const role of ['anon', 'authenticated']) {
    const granted = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
       WHERE has_table_privilege($1, 'public.rag_semantic_cache', p.privilege)`,
      [role],
    );
    assert.equal(granted.rows[0]?.n, 0, `${role} has no privilege on rag_semantic_cache`);
  }
  const triggers = await db.query<{ name: string }>(
    `SELECT tgname AS name FROM pg_trigger WHERE tgrelid = 'public.documents'::regclass AND tgname LIKE 'rag_semantic_cache_documents_%' ORDER BY 1`,
  );
  assert.deepEqual(
    triggers.rows.map((row) => row.name),
    ['rag_semantic_cache_documents_delete', 'rag_semantic_cache_documents_insert', 'rag_semantic_cache_documents_update'],
  );
}

const TERMINOLOGY_TABLES = ['rag_term_audit', 'rag_term_candidates', 'rag_term_entries', 'rag_term_layers', 'rag_term_misses'];
const TERMINOLOGY_SERVICE_ROLE_FUNCTIONS = [
  'rag_term_effective(text)',
  'rag_term_upsert_entry(uuid, text, jsonb, bigint)',
  'rag_term_delete_entry(uuid, text, uuid, bigint)',
  'rag_term_set_suppression(uuid, text, uuid, boolean, bigint)',
  'rag_term_apply_import(uuid, text, jsonb, text, bigint)',
  'rag_term_list_entries(uuid, text, integer, integer, text)',
  'rag_term_list_audit(uuid, text, integer, integer)',
  'rag_term_record_miss(text, jsonb)',
  'rag_term_purge_misses(integer)',
  'rag_term_read_misses(text, integer)',
  'rag_term_corpus_df(text, text[])',
  'rag_term_upsert_candidates(text, jsonb)',
  'rag_term_list_candidates(uuid, text, integer, integer)',
  'rag_term_decide_candidate(uuid, uuid, text, uuid)',
];

/** The Phase 4.1.1 schema as a fresh install gets it (D-07): the five rag_term_ tables with RLS and no client privilege, service_role read only,
 * every rag_term_ function closed to anon and authenticated, the callable ones granted to service_role and the rag_term__ helpers to nobody. */
async function assertTerminologySecured(db: PGlite): Promise<void> {
  const tables = await db.query<{ name: string; rls: boolean }>(
    `SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'rag\\_term\\_%' ORDER BY 1`,
  );
  assert.deepEqual(tables.rows, TERMINOLOGY_TABLES.map((name) => ({ name, rls: true })), 'the terminology tables exist with row level security');
  const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  for (const table of TERMINOLOGY_TABLES) {
    const held = await db.query<{ role: string; privilege: string }>(
      `SELECT r.role, p.privilege FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
       CROSS JOIN unnest($2::text[]) AS p(privilege) WHERE has_table_privilege(r.role, $1, p.privilege) ORDER BY 1, 2`,
      [`public.${table}`, privileges],
    );
    assert.deepEqual(held.rows, [{ role: 'service_role', privilege: 'SELECT' }], `${table}: clients hold nothing, service_role may only read`);
  }
  const functions = await db.query<{ signature: string; helper: boolean; trigger: boolean; anon: boolean; authenticated: boolean; service: boolean }>(
    `SELECT p.oid::regprocedure::text AS signature, p.proname LIKE 'rag\\_term\\_\\_%' AS helper, p.prorettype = 'trigger'::regtype AS trigger,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag\\_term\\_%' ORDER BY 1`,
  );
  const bare = (signature: string) => signature.replace(/^public\./, '').replace(/\s+/g, '');
  const present = new Set(functions.rows.map((row) => bare(row.signature)));
  assert.deepEqual(TERMINOLOGY_SERVICE_ROLE_FUNCTIONS.filter((signature) => !present.has(bare(signature))), [], 'every rag_term_ function is defined');
  assert.deepEqual(functions.rows.filter((row) => row.anon || row.authenticated).map((row) => row.signature), [], 'anon and authenticated execute no rag_term_ function');
  assert.deepEqual(
    functions.rows.filter((row) => !row.helper && !row.trigger && !row.service).map((row) => row.signature),
    [],
    'service_role can execute every callable rag_term_ function',
  );
  assert.deepEqual(functions.rows.filter((row) => row.helper && row.service).map((row) => row.signature), [], 'the rag_term__ helpers have no grant');
}

/** Every function 0701-0707 create or replace; each one is closed to anon and authenticated (D-01, D-10). */
const PHASE7_FUNCTIONS = [
  'rag_vector_sync_enqueue',
  'rag_vector_sync_chunks_insert',
  'rag_vector_sync_chunks_update',
  'rag_vector_sync_chunks_delete',
  'rag_vector_sync_documents_update',
  'rag_vector_sync_documents_delete',
  'rag_vector_sync_embeddings_insert',
  'rag_vector_sync_embeddings_update',
  'rag_vector_sync_embeddings_delete',
  'rag_vector_sync_embedding_profiles',
  'rag_vector_sync_chunking_profiles',
  'rag_vector_sync_claim',
  'rag_vector_sync_complete',
  'rag_vector_sync_fail',
  'rag_vector_sync_checkpoint',
  'rag_vector_sync_expand',
  'rag_vector_sync_requeue_dead',
  'rag_vector_sync_set_target',
  'rag_validate_chunks',
  'rag_vector_sync_document_rows',
  'rag_vector_sync_chunk_row',
  'rag_vector_sync_profiles',
  'rag_backend_readiness',
  'rag_activate_embedding_profile',
  'rag_vector_sync_tenants',
  'rag_vector_sync_reconcile_summary',
  'rag_vector_sync_prune',
  'rag_vector_sync_enqueue_repair',
  'rag_vector_sync_bucket_rows',
  'rag_set_backend_index_state',
] as const;
const PHASE7_TABLES = ['rag_backend_index_state', 'rag_vector_sync_targets', 'vector_sync_outbox'] as const;

/** The Phase 7 fold (plan 07-31): the outbox, targets and index-state tables with RLS, no policy and no client privilege, both targets seeded
 * disabled, the servable-chunk view as security_invoker, the statement triggers, and every function closed to the client roles. */
async function assertPhase7Secured(db: PGlite): Promise<void> {
  const tables = await db.query<{ name: string; rls: boolean; policies: number; client: boolean; service: boolean }>(
    `SELECT c.relname AS name, c.relrowsecurity AS rls,
            (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
            (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS client,
            has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS service
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1`,
    [[...PHASE7_TABLES]],
  );
  assert.deepEqual(tables.rows.map((row) => row.name), [...PHASE7_TABLES], 'every Phase 7 table is defined by the setup file');
  for (const row of tables.rows) {
    assert.equal(row.rls, true, `${row.name} has RLS on`);
    assert.equal(row.policies, 0, `${row.name} has no policy`);
    assert.equal(row.client, false, `anon and authenticated have no privilege on ${row.name}`);
    assert.equal(row.service, true, `service_role reads and writes ${row.name}`);
  }
  const view = await db.query<{ options: string[] | null; client: boolean }>(
    `SELECT c.reloptions AS options,
            (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT')) AS client
     FROM pg_class c WHERE c.oid = 'public.rag_servable_chunks'::regclass`,
  );
  assert.ok(view.rows[0]?.options?.includes('security_invoker=true'), 'rag_servable_chunks is security_invoker');
  assert.equal(view.rows[0]?.client, false, 'anon and authenticated cannot read rag_servable_chunks');
  const targets = await db.query<{ target: string; enabled: boolean }>('SELECT target, enabled FROM public.rag_vector_sync_targets ORDER BY target');
  assert.deepEqual(targets.rows, [
    { target: 'qdrant', enabled: false },
    { target: 'weaviate', enabled: false },
  ]);
  const triggers = await db.query<{ name: string }>(
    "SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'rag_vector_sync_%' ORDER BY 1",
  );
  assert.equal(triggers.rows.length, 10, 'the ten 0702 statement triggers exist');
  const functions = await db.query<{ proname: string; signature: string; trigger: boolean; client: boolean; service: boolean }>(
    `SELECT p.proname, p.oid::regprocedure::text AS signature, p.prorettype = 'trigger'::regtype AS trigger,
            (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS client,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    [[...PHASE7_FUNCTIONS]],
  );
  const present = new Set(functions.rows.map((row) => row.proname));
  assert.deepEqual(PHASE7_FUNCTIONS.filter((name) => !present.has(name)), [], 'every 0701-0707 function is defined by the setup file');
  assert.deepEqual(functions.rows.filter((row) => row.client).map((row) => row.signature), [], 'anon and authenticated have no EXECUTE on a Phase 7 function');
  assert.deepEqual(
    functions.rows.filter((row) => !row.trigger && !row.service).map((row) => row.signature),
    [],
    'service_role can execute every callable Phase 7 function, rag_vector_sync_claim included',
  );
}

for (const mode of MODES) {
  describe(`${mode} setup`, () => {
    test(`${mode} setup applies cleanly on fresh PGlite`, async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true, migrations: false });
      try {
        assert.deepEqual(Object.keys(fixture.sqlSha256), [FOLDED_SETUP[mode]], 'the setup file alone was loaded, no migration');
        await assertRagFunctionsNotCallableByClients(fixture.db);
        await assertPhase4FunctionsServiceRoleOnly(fixture.db);
        await assertAnswerRecordsSecured(fixture.db, mode);
        await assertDomainBindingsSecured(fixture.db);
        await assertFeedbackLoopSecured(fixture.db, mode);
        await assertPhase6Secured(fixture.db);
        await assertFinetuneSecured(fixture.db);
        await assertTerminologySecured(fixture.db);
        await assertPhase7Secured(fixture.db);
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
        const phase7Grants = (dump: CatalogDump) => dump.grants.filter((row) => row.includes('"signature":"rag_vector_sync_claim('));
        assert.ok(phase7Grants(migrated.dump).length > 0, 'the 0703 claim grants are part of the comparison');
        assert.deepEqual(phase7Grants(folded.dump), phase7Grants(migrated.dump), 'rag_vector_sync_claim grants are equal');
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

// Phase 3.1 fold (plan 03.1-52): 0351-0359 of the mode sit between the Phase 3 and Phase 4 sections, 0420-0424 after Phase 4 (migration order),
// each appended verbatim in loader order.
const BAR = '------------------------------------------';
const PHASE_31_SECTIONS = [
  { header: `${BAR}\n-- Phase 3.1: Tiered parsing, ingestion queue and bulk backfill (migrations 0351-0359)\n${BAR}`, files: /^supabase\/migrations\/035[1-9]_/ },
  {
    header: `${BAR}\n-- Phase 3.1: Ingestion queue hardening and chunk writer fix (migrations 0420-0424, after Phase 4 in migration order)\n${BAR}`,
    files: /^supabase\/migrations\/042[0-4]_/,
  },
] as const;
const PHASE_4_HEADER = `${BAR}\n-- Phase 4: Hybrid retrieval`;
// The empty search_path rewrite (0425, plan 04-47) runs after 0424, so its section follows the 0420-0424 section; the Phase 3.1.1 section
// (0440-0442, plan 03.1.1-14) replaces 0425 guard and re-embed bodies, so it follows 0425; the Phase 5 section (0501-0502, plan 05-25) follows, then
// the Phase 5.1.1 section (0531-0537, plan 05.1.1-22), the Phase 6 section (0601-0603, plan 06-45), the Phase 4.1.1 section (0471-0473,
// plan 04.1.1-14, folded after Phase 6), the Phase 6.1 section (0651-0654, plan 06.1-18), which reads the 0440 bindings, and the Phase 7
// section (0701-0707, plan 07-31), which closes the file.
const SEARCH_PATH_SECTION = {
  header: `${BAR}\n-- Phase 4 gap closure: empty search_path for SECURITY DEFINER, trigger and post-Phase-3 functions (migration 0425, plan 04-47, after 0424)\n${BAR}`,
  files: /^supabase\/migrations\/0425_/,
} as const;
const PHASE_311_SECTION = {
  header: `${BAR}\n-- Phase 3.1.1: Domain embedding bindings and scoped re-embed (migrations 0440-0442, plan 03.1.1-14, after 0425 in migration order)\n${BAR}`,
  files: /^supabase\/migrations\/044[0-2]_/,
} as const;
const PHASE_5_SECTION = {
  header: `${BAR}\n-- Phase 5: Answer records (migrations 0501-0502, plan 05-25, after 0425 in migration order)\n${BAR}`,
  files: /^supabase\/migrations\/050[12]_/,
} as const;
const PHASE_511_SECTION = {
  header: `${BAR}\n-- Phase 5.1.1: Feedback loop (migrations 0531-0537, plan 05.1.1-22, after 0502 in migration order)\n${BAR}`,
  files: /^supabase\/migrations\/053[1-7]_/,
} as const;
const PHASE_6_SECTION = {
  header: `${BAR}\n-- Phase 6: Query layer language shares, undated filter and semantic cache (migrations 0601-0603, plan 06-45, after 0537 in migration order)\n${BAR}`,
  files: /^supabase\/migrations\/060[1-3]_/,
} as const;
const PHASE_411_SECTION = {
  header: `${BAR}\n-- Phase 4.1.1: Terminology dictionary (migrations 0471-0473, plan 04.1.1-14, after 0442 in migration order)\n${BAR}`,
  files: /^supabase\/migrations\/047[1-3]_/,
} as const;
const PHASE_61_SECTION = {
  header: `${BAR}\n-- Phase 6.1: Embedding fine-tuning registry, slots, export and binding guard (migrations 0651-0654, plan 06.1-18, after 0603 in migration order)\n${BAR}`,
  files: /^supabase\/migrations\/065[1-4]_/,
} as const;
const PHASE_7_SECTION = {
  header: `${BAR}\n-- Phase 7: Vector sync outbox, triggers, claim, reads, servable-chunk validation, activation gate and reconcile (migrations 0701-0707, plan 07-31, after 0654 in migration order; 0708 onward stay migrations)\n${BAR}`,
  files: /^supabase\/migrations\/070[1-7]_/,
} as const;
const OTHER_MODE: Record<DeploymentMode, DeploymentMode> = { 'single-tenant': 'multi-tenant', 'multi-tenant': 'single-tenant' };

const phase31Files = (mode: DeploymentMode): string[] => migrationFiles(mode).filter((file) => PHASE31_MIGRATION.test(file));

/** The Phase 3.1 sections as the fold writes them: a header, then each migration file under a `-- >>> path` line. */
export function phase31Sections(mode: DeploymentMode): string[] {
  return PHASE_31_SECTIONS.map((section) => foldedSection(mode, section));
}

/** A fold section as written to the setup file: a header, then each migration file under a `-- >>> path` line. */
function foldedSection(mode: DeploymentMode, { header, files }: { header: string; files: RegExp }): string {
  const blocks = migrationFiles(mode)
    .filter((file) => files.test(file))
    .map((relpath) => {
      const content = fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf8');
      return `-- >>> ${relpath}\n${content}${content.endsWith('\n') ? '' : '\n'}`;
    });
  return `${header}\n\n${blocks.join('\n')}`;
}

const searchPathFiles = (mode: DeploymentMode): string[] => migrationFiles(mode).filter((file) => SEARCH_PATH_SECTION.files.test(file));
const phase311Files = (mode: DeploymentMode): string[] => migrationFiles(mode).filter((file) => PHASE_311_SECTION.files.test(file));
const phase61Files = (mode: DeploymentMode): string[] => migrationFiles(mode).filter((file) => PHASE_61_SECTION.files.test(file));
const phase7Files = (mode: DeploymentMode): string[] => migrationFiles(mode).filter((file) => PHASE_7_SECTION.files.test(file));

/** The folded setup file with both Phase 3.1 sections and the later 0425 and 0440-0442 sections cut out: what the setup was before the Phase 3.1
 * fold. */
function setupWithoutPhase31(mode: DeploymentMode): string {
  let text = fs.readFileSync(path.join(REPO_ROOT, FOLDED_SETUP[mode]), 'utf8');
  for (const section of phase31Sections(mode)) {
    assert.ok(text.includes(section), `${FOLDED_SETUP[mode]} lacks a Phase 3.1 section`);
    text = text.replace(section, '');
  }
  const searchPath = foldedSection(mode, SEARCH_PATH_SECTION);
  assert.ok(text.includes(searchPath), `${FOLDED_SETUP[mode]} lacks the 0425 section`);
  const phase311 = foldedSection(mode, PHASE_311_SECTION);
  assert.ok(text.includes(phase311), `${FOLDED_SETUP[mode]} lacks the 0440-0442 section`);
  const phase61 = foldedSection(mode, PHASE_61_SECTION);
  assert.ok(text.includes(phase61), `${FOLDED_SETUP[mode]} lacks the 0651-0654 section`);
  const phase7 = foldedSection(mode, PHASE_7_SECTION);
  assert.ok(text.includes(phase7), `${FOLDED_SETUP[mode]} lacks the 0701-0707 section`);
  return text.replace(searchPath, '').replace(phase311, '').replace(phase61, '').replace(phase7, '');
}

/** Supabase Realtime as far as 0353 needs it: realtime.messages with RLS, realtime.topic() and realtime.send(). */
const REALTIME_STUB_SQL = `
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (id bigserial PRIMARY KEY, topic text NOT NULL, extension text NOT NULL, payload jsonb, event text, private boolean);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('realtime.topic', true), '') $$;
CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) RETURNS void LANGUAGE sql AS $$ SELECT $$;`;

/** A fresh database with the Supabase shim, optionally Realtime, then the given SQL texts in order. */
async function freshDatabase(sqlTexts: string[], options: { realtime?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector, pg_trgm } });
  try {
    await db.waitReady;
    await db.exec(SUPABASE_SHIM_SQL);
    await db.exec(SUPABASE_GRANTS_SQL);
    if (options.realtime) await db.exec(REALTIME_STUB_SQL);
    for (const sql of sqlTexts) await db.exec(sql);
    return db;
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}

const readRepo = (relpath: string): string => fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf8');

async function functionSource(db: PGlite, signature: string): Promise<string | null> {
  const result = await db.query<{ definition: string | null }>('SELECT pg_get_functiondef(to_regprocedure($1)) AS definition', [signature]);
  return result.rows[0]?.definition ?? null;
}

async function realtimePolicies(db: PGlite): Promise<string[]> {
  return rows(db, "SELECT policyname AS name, cmd, roles::text AS roles, qual FROM pg_policies WHERE schemaname = 'realtime'");
}

const TOPIC_RULE = 'rag_ingest_realtime_topic_allowed(text)';

for (const mode of MODES) {
  describe(`${mode} setup: Phase 3.1 fold`, () => {
    test(`${mode} setup carries migrations 0351 to 0359 before Phase 4 and 0420 to 0424 after it, verbatim and in loader order`, () => {
      const files = phase31Files(mode);
      assert.ok(files.length >= 15, `expected the 0351-0359 and 0420-0424 files of ${mode}, saw ${files.length}`);
      assert.ok(files.includes(`supabase/migrations/0353_ingestion_transitions.${mode}.sql`));
      assert.ok(!files.includes(`supabase/migrations/0353_ingestion_transitions.${OTHER_MODE[mode]}.sql`));
      const text = readRepo(FOLDED_SETUP[mode]);
      const [early, late] = phase31Sections(mode) as [string, string];
      assert.ok(text.includes(`${early}\n${PHASE_4_HEADER}`), 'the 0351-0359 section sits right before the Phase 4 section');
      assert.ok(
        text.endsWith(
          `${late}\n${foldedSection(mode, SEARCH_PATH_SECTION)}\n${foldedSection(mode, PHASE_311_SECTION)}\n${foldedSection(mode, PHASE_5_SECTION)}\n${foldedSection(mode, PHASE_511_SECTION)}\n${foldedSection(mode, PHASE_6_SECTION)}\n${foldedSection(mode, PHASE_411_SECTION)}\n` +
            `${foldedSection(mode, PHASE_61_SECTION)}\n${foldedSection(mode, PHASE_7_SECTION)}`,
        ),
        'after Phase 4 come the 0420-0424, 0425, 0440-0442, Phase 5, Phase 5.1.1, Phase 6, Phase 4.1.1 and Phase 6.1 sections, then the Phase 7 section, which closes the file',
      );
      assert.ok(text.indexOf(late) > text.indexOf(PHASE_4_HEADER));
    });

    test(`${mode} setup alone equals the setup without its Phase 3.1 sections plus the Phase 3.1 migrations`, async () => {
      const folded = await freshDatabase([readRepo(FOLDED_SETUP[mode])]);
      const migrated = await freshDatabase([
        setupWithoutPhase31(mode),
        ...phase31Files(mode).map(readRepo),
        ...searchPathFiles(mode).map(readRepo),
        ...phase311Files(mode).map(readRepo),
        ...phase61Files(mode).map(readRepo),
        ...phase7Files(mode).map(readRepo),
      ]);
      try {
        const foldedDump = await catalogDump(folded);
        assert.ok(foldedDump.columns.some((row) => row.includes('"table":"ingestion_jobs"')), 'ingestion_jobs is in the setup file');
        assert.deepEqual(differences(foldedDump, await catalogDump(migrated)), []);
      } finally {
        await folded.close();
        await migrated.close();
      }
    });

    test(`${mode} setup alone carries this mode's Realtime topic rule and not the other mode's`, async () => {
      const folded = await freshDatabase([readRepo(FOLDED_SETUP[mode])]);
      const own = await freshDatabase([readRepo(frozenSetup(mode)), ...migrationFiles(mode).map(readRepo)]);
      const other = await freshDatabase([readRepo(frozenSetup(mode)), ...migrationFiles(mode).map(readRepo)]);
      try {
        await other.exec(readRepo(`supabase/migrations/0353_ingestion_transitions.${OTHER_MODE[mode]}.sql`));
        const source = await functionSource(folded, TOPIC_RULE);
        assert.ok(source, `${TOPIC_RULE} is in ${FOLDED_SETUP[mode]}`);
        assert.equal(source, await functionSource(own, TOPIC_RULE));
        assert.notEqual(source, await functionSource(other, TOPIC_RULE));
      } finally {
        await folded.close();
        await own.close();
        await other.close();
      }
      const code = readRepo(FOLDED_SETUP[mode])
        .split('\n')
        .filter((line) => !/^\s*--/.test(line))
        .join('\n');
      if (mode === 'multi-tenant') assert.ok(!code.includes('rag-ingest:s:default'), 'the multi-tenant setup carries the single-tenant topic');
      else assert.ok(!code.includes("'rag-ingest:u:'"), 'the single-tenant setup carries the multi-tenant topic');
    });

    test(`${mode} with Supabase Realtime: every migration applies in loader order and the folded setup alone has the same broadcast policy`, async () => {
      const migrated = await freshDatabase([readRepo(frozenSetup(mode)), ...migrationFiles(mode).map(readRepo)], { realtime: true });
      const folded = await freshDatabase([readRepo(FOLDED_SETUP[mode])], { realtime: true });
      const foldedThenMigrated = await freshDatabase([readRepo(FOLDED_SETUP[mode]), ...migrationFiles(mode).map(readRepo)], { realtime: true });
      try {
        const policies = await realtimePolicies(migrated);
        assert.equal(policies.length, 1, 'rag_ingest_broadcast_read exists on realtime.messages');
        assert.match(policies[0] as string, /rag_ingest_broadcast_read/);
        assert.match(policies[0] as string, /rag_ingest_realtime_topic_allowed/);
        assert.deepEqual(await realtimePolicies(folded), policies);
        assert.equal(await functionSource(folded, TOPIC_RULE), await functionSource(migrated, TOPIC_RULE));
        assert.deepEqual(differences(await catalogDump(foldedThenMigrated), await catalogDump(migrated)), []);
      } finally {
        await migrated.close();
        await folded.close();
        await foldedThenMigrated.close();
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
