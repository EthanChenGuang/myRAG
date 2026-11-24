import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, applyMigrations, migrationFiles } from '../../eval/harness/migrations.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const frozenSetup = (mode: DeploymentMode): string => `tests/fixtures/sql/pre-phase3-${mode}-setup.sql`;

type CatalogDump = Record<string, string[]>;

async function rows(db: PGlite, sql: string): Promise<string[]> {
  const result = await db.query<Record<string, unknown>>(sql);
  return result.rows.map((row) => JSON.stringify(row)).sort();
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

async function build(mode: DeploymentMode, options: { setupSqlPath?: string; apply: 'all' | 'twice' | 'all-but-last' }): Promise<{ fixture: FixtureDatabase; dump: CatalogDump }> {
  const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, migrations: false, ...(options.setupSqlPath ? { setupSqlPath: options.setupSqlPath } : {}) });
  try {
    if (options.apply === 'all-but-last') await applyMigrationFiles(fixture.db, migrationFiles(mode).slice(0, -1));
    else await applyMigrations(fixture.db, mode);
    if (options.apply === 'twice') await applyMigrations(fixture.db, mode);
    return { fixture, dump: await catalogDump(fixture.db) };
  } catch (error) {
    await fixture.db.close();
    throw error;
  }
}

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
