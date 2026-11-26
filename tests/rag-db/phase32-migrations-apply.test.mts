import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';

/**
 * Phase 3.2 migration block 0801-0810 (plan 03.2-65, D-48). Later live Phase 3.2 files (0812-0820) redefine a few block functions
 * (rag_write_chunks 0812, rag_upload_approval_keys 0814, rag_translation_settings_set 0816, rag_translation_eligible_chunks and
 * rag_translation_pending_page 0820), so the final state of a database is the block followed by those files; the tests assert that state.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SETUP_FILES = ['supabase/single-tenant-setup.sql', 'supabase/multi-tenant-setup.sql'];

const BLOCK_NAMES = [
  '0801_phase32_columns_checks',
  '0802_hybrid_search_scopes_dates_und',
  '0803_publish_hold',
  '0804_quarantine_reasons',
  '0805_scope_tags',
  '0806_supersession',
  '0807_effective_dates',
  '0808_fingerprint_impact',
  '0809_rebuild_batches',
  '0810_chunk_translations',
];

const stemOf = (file: string): string => path.basename(file).replace(/(\.(single|multi)-tenant)?\.sql$/, '');
const numberOf = (file: string): number => Number(stemOf(file).slice(0, 4));
const isBlock = (file: string): boolean => BLOCK_NAMES.includes(stemOf(file));
const isLaterPhase32 = (file: string): boolean => numberOf(file) >= 811 && numberOf(file) <= 899;
const readRepo = (relpath: string): string => fs.readFileSync(path.join(REPO_ROOT, relpath), 'utf8');

function blockFiles(mode: DeploymentMode): string[] {
  return migrationFiles(mode).filter(isBlock);
}

function laterFiles(mode: DeploymentMode): string[] {
  return migrationFiles(mode).filter(isLaterPhase32);
}

function namesCreated(files: string[], kind: 'FUNCTION' | 'TABLE'): Set<string> {
  const pattern =
    kind === 'FUNCTION'
      ? /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi
      : /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_0-9]+)/gi;
  const out = new Set<string>();
  for (const file of files) for (const match of readRepo(file).matchAll(pattern)) out.add((match[1] as string).toLowerCase());
  return out;
}

type Snapshot = Record<string, string[]>;

async function rows(db: PGlite, sql: string): Promise<string[]> {
  const result = await db.query<Record<string, unknown>>(sql);
  return result.rows.map((row) => JSON.stringify(row)).sort();
}

const sortAcl = (column: string): string =>
  `(SELECT array_agg(x::text ORDER BY x::text)::text FROM unnest(${column}) AS x)`;

const OUTSIDE_EXTENSIONS = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = ${alias}.oid AND dep.deptype = 'e')`;

async function snapshot(db: PGlite): Promise<Snapshot> {
  return {
    tables: await rows(
      db,
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls, ${sortAcl('c.relacl')} AS acl
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`,
    ),
    columns: await rows(
      db,
      `SELECT c.relname AS "table", a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS "default", a.attgenerated AS generated
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p') AND c.relnamespace = 'public'::regnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attnum > 0 AND NOT a.attisdropped`,
    ),
    constraints: await rows(
      db,
      `SELECT conrelid::regclass::text AS "table", conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    ),
    indexes: await rows(db, `SELECT tablename AS "table", indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'public'`),
    functions: await rows(
      db,
      `SELECT p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS definition, p.prosecdef AS security_definer,
              p.proconfig::text AS config, ${sortAcl('p.proacl')} AS acl
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND ${OUTSIDE_EXTENSIONS('p')}`,
    ),
    triggers: await rows(
      db,
      `SELECT tgrelid::regclass::text AS "table", tgname AS name, pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)`,
    ),
    policies: await rows(
      db,
      `SELECT tablename AS "table", policyname AS name, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public'`,
    ),
  };
}

function differences(left: Snapshot, right: Snapshot): string[] {
  const out: string[] = [];
  for (const section of Object.keys(left)) {
    const a = new Set(left[section]);
    const b = new Set(right[section]);
    for (const row of a) if (!b.has(row)) out.push(`${section}: only before: ${row.slice(0, 200)}`);
    for (const row of b) if (!a.has(row)) out.push(`${section}: only after: ${row.slice(0, 200)}`);
  }
  return out;
}

/** Names of the functions whose rows differ between two snapshots. */
function changedFunctionNames(left: Snapshot, right: Snapshot): string[] {
  const nameOf = (row: string): string => (JSON.parse(row) as { signature: string }).signature.replace(/\(.*$/, '');
  const a = new Set(left.functions);
  const b = new Set(right.functions);
  const names = new Set<string>();
  for (const row of a) if (!b.has(row)) names.add(nameOf(row));
  for (const row of b) if (!a.has(row)) names.add(nameOf(row));
  return [...names].sort();
}

function withoutFunctions(snap: Snapshot): Snapshot {
  const { functions: _functions, ...rest } = snap;
  return rest;
}

async function freshDatabase(mode: DeploymentMode, files: string[]): Promise<PGlite> {
  const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false, supabaseFunctionDefaults: true });
  try {
    await applyMigrationFiles(fixture.db, files);
    return fixture.db;
  } catch (error) {
    await fixture.db.close();
    throw error;
  }
}

async function overloads(db: PGlite, name: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1",
    [name],
  );
  return result.rows[0]?.n ?? 0;
}

describe('Phase 3.2 migration block files', () => {
  test('the ten files 0801-0810 exist and only later Phase 3.2 files sort after them', () => {
    const listed = fs.readdirSync(path.join(REPO_ROOT, 'supabase/migrations'));
    for (const name of BLOCK_NAMES) assert.ok(listed.includes(`${name}.sql`), `supabase/migrations/${name}.sql is missing`);
    assert.ok(BLOCK_NAMES.includes('0810_chunk_translations'));
    for (const mode of MODES) {
      const files = migrationFiles(mode);
      const blockIndexes = files.map((file, index) => (isBlock(file) ? index : -1)).filter((index) => index >= 0);
      assert.equal(blockIndexes.length, BLOCK_NAMES.length, `${mode}: every block file is in the migration order`);
      assert.deepEqual(blockFiles(mode).map(stemOf), BLOCK_NAMES, `${mode}: the block applies in file-name order`);
      const first = blockIndexes[0] as number;
      const last = blockIndexes[blockIndexes.length - 1] as number;
      assert.equal(last - first + 1, BLOCK_NAMES.length, `${mode}: no other file sorts inside the block`);
      assert.deepEqual(files.slice(0, first).filter((file) => numberOf(file) >= 800), [], `${mode}: every earlier file is numbered below 0800`);
      assert.deepEqual(files.slice(last + 1).filter((file) => numberOf(file) < 900 && !isLaterPhase32(file)), [], `${mode}: below 0900 only Phase 3.2 files (0811-0899) follow`);
    }
  });

  test('neither setup file contains an object created only by the block', () => {
    const earlier = migrationFiles('single-tenant')
      .concat(migrationFiles('multi-tenant'))
      .filter((file) => numberOf(file) < 801);
    const before = new Set([...namesCreated(earlier, 'FUNCTION'), ...namesCreated(earlier, 'TABLE'), ...namesCreated(SETUP_FILES, 'FUNCTION'), ...namesCreated(SETUP_FILES, 'TABLE')]);
    const block = [...new Set([...blockFiles('single-tenant'), ...blockFiles('multi-tenant')])];
    const blockOnly = [...namesCreated(block, 'FUNCTION'), ...namesCreated(block, 'TABLE')].filter((name) => !before.has(name));
    assert.ok(blockOnly.includes('rag_scope_vocabulary'), 'rag_scope_vocabulary is created by the block');
    assert.ok(blockOnly.includes('chunk_translations'), 'chunk_translations is created by the block');
    for (const setup of SETUP_FILES) {
      const text = readRepo(setup);
      assert.deepEqual(
        blockOnly.filter((name) => new RegExp(`\\b${name}\\b`).test(text)),
        [],
        `${setup} must not fold the 08xx block`,
      );
    }
  });
});

for (const mode of MODES) {
  describe(`Phase 3.2 migration block apply (${mode})`, () => {
    test('trunk then the block applies, and a second apply of the block changes nothing', async () => {
      const throughBlock = migrationFiles(mode).filter((file) => numberOf(file) <= 810);
      const db = await freshDatabase(mode, throughBlock.filter((file) => !isBlock(file)));
      try {
        const trunk = await snapshot(db);
        await applyMigrationFiles(db, blockFiles(mode));
        const first = await snapshot(db);
        assert.notDeepEqual(first, trunk, 'the block changes the schema');
        await applyMigrationFiles(db, blockFiles(mode));
        assert.deepEqual(differences(first, await snapshot(db)), []);
      } finally {
        await db.close();
      }
    });

    test('on the final state, re-applying the block changes only what later 08xx files redefine, and those files restore it', async () => {
      const db = await freshDatabase(mode, migrationFiles(mode));
      try {
        const final = await snapshot(db);
        await applyMigrationFiles(db, blockFiles(mode));
        const reapplied = await snapshot(db);
        assert.deepEqual(differences(withoutFunctions(final), withoutFunctions(reapplied)), [], 'tables, columns, constraints, indexes, triggers and policies');
        const laterNames = namesCreated(laterFiles(mode), 'FUNCTION');
        const changed = changedFunctionNames(final, reapplied);
        assert.deepEqual(changed.filter((name) => !laterNames.has(name)), [], 'only functions a later 08xx file redefines change');
        await applyMigrationFiles(db, laterFiles(mode));
        assert.deepEqual(differences(final, await snapshot(db)), []);
      } finally {
        await db.close();
      }
    });

    test('re-running 0314, 0316, 0425, 0426 and 0602 then the 08xx files restores every Phase 3.2 function with one overload', async () => {
      const files = migrationFiles(mode);
      // 0314 runs first since 0856 changed the rag_exact_id_documents signature that the 0425 precheck names (0856 header).
      const older = files.filter((file) => ['0314', '0316', '0425', '0426', '0602'].includes(stemOf(file).slice(0, 4)) && file.endsWith('.sql'));
      assert.equal(older.filter((file) => stemOf(file).startsWith('0425_')).length, 2, '0425 runs with its mode file');
      assert.equal(older.filter((file) => stemOf(file).startsWith('0316_')).length, 2, '0316 runs with its mode file');
      const phase32 = files.filter((file) => numberOf(file) >= 801);
      const phase32Functions = namesCreated(phase32, 'FUNCTION');
      const db = await freshDatabase(mode, files);
      try {
        const final = await snapshot(db);
        await applyMigrationFiles(db, older);
        assert.ok(changedFunctionNames(final, await snapshot(db)).some((name) => phase32Functions.has(name)), 'the older files put back older bodies');

        await applyMigrationFiles(db, phase32);
        const repaired = await snapshot(db);
        assert.deepEqual(differences(withoutFunctions(final), withoutFunctions(repaired)), []);
        const stillChanged = changedFunctionNames(final, repaired);
        assert.deepEqual(stillChanged.filter((name) => phase32Functions.has(name)), [], 'every function an 08xx file defines has its final body');
        for (const name of ['hybrid_search_chunks', 'rag_list_quarantine', 'rag_release_quarantine']) {
          assert.equal(await overloads(db, name), 1, `${name} has exactly one overload`);
        }

        // What still differs comes from files between 0425 and 0801 (0425's own operator rule: re-run every later file after it).
        const between = files.filter((file) => numberOf(file) > 425 && numberOf(file) < 801);
        const betweenNames = namesCreated(between, 'FUNCTION');
        assert.deepEqual(stillChanged.filter((name) => !betweenNames.has(name)), []);
        await applyMigrationFiles(db, [...between, ...phase32]);
        assert.deepEqual(differences(final, await snapshot(db)), []);
      } finally {
        await db.close();
      }
    });

    test('every 08xx function has an empty search_path and service_role-only execute; every block table has RLS on and no policies', async () => {
      const files = migrationFiles(mode);
      const phase32 = files.filter((file) => numberOf(file) >= 801);
      const functionNames = [...namesCreated(phase32, 'FUNCTION')].sort();
      const tableNames = [...namesCreated(blockFiles(mode), 'TABLE')].sort();
      assert.ok(functionNames.includes('hybrid_search_translations') && functionNames.length > 80, `saw ${functionNames.length} functions`);
      assert.ok(tableNames.includes('rag_scope_vocabulary') && tableNames.includes('chunk_translations'));
      const db = await freshDatabase(mode, files);
      try {
        const fns = await db.query<{
          proname: string;
          signature: string;
          config: string[] | null;
          trigger: boolean;
          public_exec: boolean;
          anon: boolean;
          authenticated: boolean;
          service_role: boolean;
        }>(
          `SELECT p.proname, p.oid::regprocedure::text AS signature, p.proconfig AS config, p.prorettype = 'trigger'::regtype AS trigger,
                  EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
          [functionNames],
        );
        const present = new Set(fns.rows.map((row) => row.proname));
        assert.deepEqual(functionNames.filter((name) => !present.has(name)), [], 'every 08xx function exists');
        assert.deepEqual(
          fns.rows.filter((row) => JSON.stringify(row.config) !== JSON.stringify(['search_path=""'])).map((row) => `${row.signature} ${JSON.stringify(row.config)}`),
          [],
          'search_path is empty',
        );
        assert.deepEqual(
          fns.rows.filter((row) => row.public_exec || row.anon || row.authenticated).map((row) => row.signature),
          [],
          'no execute for PUBLIC, anon or authenticated',
        );
        assert.deepEqual(
          fns.rows.filter((row) => !row.trigger && !row.service_role).map((row) => row.signature),
          [],
          'service_role executes every callable 08xx function',
        );

        const tables = await db.query<{ relname: string; rls: boolean; policies: number }>(
          `SELECT c.relname, c.relrowsecurity AS rls,
                  (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
             FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`,
          [tableNames],
        );
        assert.equal(tables.rows.length, tableNames.length, 'every block table exists');
        assert.deepEqual(tables.rows.filter((row) => !row.rls || row.policies !== 0).map((row) => row.relname), [], 'RLS on, no policies');
      } finally {
        await db.close();
      }
    });
  });
}
