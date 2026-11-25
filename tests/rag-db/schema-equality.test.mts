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
 * after 0424 (plan 04-47). Phase 6 (plan 06-45) is not folded yet, so a fresh install from a setup file is completed by those migrations alone.
 */
const FOLDED_MIGRATION = /^supabase\/migrations\/(030[1-9]|031\d|0320|035[1-9]|040[1-9]|041[0-3]|042[0-5])_[a-z0-9_]+(\.(single|multi)-tenant)?\.sql$/;
const PHASE4_MIGRATION = /^supabase\/migrations\/04(0[1-9]|1\d)_/;
const PHASE31_MIGRATION = /^supabase\/migrations\/(035[1-9]|042[0-4])_/;
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

    test(`every Phase 3.1 migration of ${mode} is folded into the setup file`, () => {
      const phase31 = migrationFiles(mode).filter((file) => PHASE31_MIGRATION.test(file));
      assert.ok(phase31.length >= 15);
      assert.deepEqual(phase31.filter((file) => !FOLDED_MIGRATION.test(file)), []);
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
// The empty search_path rewrite (0425, plan 04-47) runs after 0424, so its section follows the 0420-0424 section and closes the file.
const SEARCH_PATH_SECTION = {
  header: `${BAR}\n-- Phase 4 gap closure: empty search_path for SECURITY DEFINER, trigger and post-Phase-3 functions (migration 0425, plan 04-47, after 0424)\n${BAR}`,
  files: /^supabase\/migrations\/0425_/,
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

/** The folded setup file with both Phase 3.1 sections and the later 0425 section cut out: what the setup was before the Phase 3.1 fold. */
function setupWithoutPhase31(mode: DeploymentMode): string {
  let text = fs.readFileSync(path.join(REPO_ROOT, FOLDED_SETUP[mode]), 'utf8');
  for (const section of phase31Sections(mode)) {
    assert.ok(text.includes(section), `${FOLDED_SETUP[mode]} lacks a Phase 3.1 section`);
    text = text.replace(section, '');
  }
  const searchPath = foldedSection(mode, SEARCH_PATH_SECTION);
  assert.ok(text.includes(searchPath), `${FOLDED_SETUP[mode]} lacks the 0425 section`);
  return text.replace(searchPath, '');
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
      assert.ok(text.endsWith(`${late}\n${foldedSection(mode, SEARCH_PATH_SECTION)}`), 'after Phase 4 come the 0420-0424 section and then the 0425 section, which closes the file');
      assert.ok(text.indexOf(late) > text.indexOf(PHASE_4_HEADER));
    });

    test(`${mode} setup alone equals the setup without its Phase 3.1 sections plus the Phase 3.1 migrations`, async () => {
      const folded = await freshDatabase([readRepo(FOLDED_SETUP[mode])]);
      const migrated = await freshDatabase([setupWithoutPhase31(mode), ...phase31Files(mode).map(readRepo), ...searchPathFiles(mode).map(readRepo)]);
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
