import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, applyMigrations, migrationFiles } from '../../eval/harness/migrations.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SETUP: Record<DeploymentMode, string> = {
  'single-tenant': 'supabase/single-tenant-setup.sql',
  'multi-tenant': 'supabase/multi-tenant-setup.sql',
};
const frozenSetup = (mode: DeploymentMode): string => `tests/fixtures/sql/pre-phase3-${mode}-setup.sql`;

/** A migration is folded when the setup file carries its `-- >>> <path>` marker; the setup is completed by the others alone. */
function unfoldedMigrationFiles(mode: DeploymentMode): string[] {
  const setup = fs.readFileSync(path.join(REPO_ROOT, SETUP[mode]), 'utf8');
  const folded = new Set([...setup.matchAll(/^-- >>> (supabase\/migrations\/\S+\.sql)$/gm)].map((match) => match[1]));
  return migrationFiles(mode).filter((file) => !folded.has(file));
}

const EXTENSION_MEMBER = `EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')`;
const EMPTY_PATH = `COALESCE('search_path=""' = ANY (p.proconfig), false)`;

/** Function names of the pre-Phase-3 schema; anything else was created by migration 0301 or later. */
async function legacyFunctionNames(mode: DeploymentMode): Promise<string[]> {
  const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false, setupSqlPath: frozenSetup(mode) });
  try {
    const result = await fixture.db.query<{ proname: string }>(
      `SELECT DISTINCT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND NOT ${EXTENSION_MEMBER}`,
    );
    return result.rows.map((row) => row.proname);
  } finally {
    await fixture.db.close();
  }
}

type Build = 'setup-plus-unfolded' | 'frozen-plus-all';

async function build(mode: DeploymentMode, kind: Build): Promise<PGlite> {
  const fixture = await createEmptyFixtureDatabase({
    deploymentMode: mode,
    migrations: false,
    ...(kind === 'frozen-plus-all' ? { setupSqlPath: frozenSetup(mode) } : {}),
  });
  try {
    if (kind === 'frozen-plus-all') await applyMigrations(fixture.db, mode);
    else await applyMigrationFiles(fixture.db, unfoldedMigrationFiles(mode));
    return fixture.db;
  } catch (error) {
    await fixture.db.close();
    throw error;
  }
}

interface FunctionRow {
  signature: string;
  definer: boolean;
  trigger: boolean;
  legacy: boolean;
  empty_path: boolean;
  config: string | null;
  source: string;
}

async function functionRows(db: PGlite, legacy: string[]): Promise<FunctionRow[]> {
  const result = await db.query<FunctionRow>(
    `SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS definer, p.prorettype = 'trigger'::regtype AS trigger,
            p.proname = ANY ($1::text[]) AS legacy,
            ${EMPTY_PATH} AS empty_path, p.proconfig::text AS config, p.prosrc AS source
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND NOT ${EXTENSION_MEMBER}
      ORDER BY 1`,
    [legacy],
  );
  return result.rows;
}

interface PublicNames {
  relations: Set<string>;
  functions: Set<string>;
  /** pg_catalog tables and views: under an empty search_path pg_temp is still searched first for relations, so these need pg_catalog. too. */
  catalogRelations: Set<string>;
}

async function publicNames(db: PGlite): Promise<PublicNames> {
  const relations = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'S', 'p', 'f')`,
  );
  // Functions that exist only in public: a call to one of them cannot fall back to pg_catalog under an empty search_path.
  const functions = await db.query<{ name: string }>(
    `SELECT DISTINCT p.proname AS name FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace AND c.proname = p.proname)`,
  );
  const catalog = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f')`,
  );
  return {
    relations: new Set(relations.rows.map((row) => row.name)),
    functions: new Set(functions.rows.map((row) => row.name)),
    catalogRelations: new Set(catalog.rows.map((row) => row.name)),
  };
}

const VECTOR_OPERATOR = /(<=>|<->|<#>|<\+>|<~>|<%>)/g;

/**
 * Names a function body resolves through the search_path. Comments and plain string literals are skipped; SQL text built for EXECUTE
 * (a literal that starts with SELECT, UPDATE, INSERT, DELETE or WITH) is checked like code.
 */
function unqualifiedReferences(source: string, names: PublicNames): string[] {
  const code = source
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, (literal) => (/^'\s*(SELECT|UPDATE|INSERT|DELETE|WITH)\b/i.test(literal) ? literal.slice(1, -1) : "''"));
  const found = new Set<string>();
  for (const match of code.matchAll(/\b(?:from|join|into|update|table|using|only)\s+([a-z_][a-z0-9_]*)\b(?!\s*\.)/gi)) {
    if (names.relations.has(match[1]!.toLowerCase())) found.add(`relation ${match[1]}`);
  }
  for (const match of code.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)\s*%\s*rowtype\b/gi)) {
    if (names.relations.has(match[1]!.toLowerCase())) found.add(`row type ${match[1]}`);
  }
  for (const match of code.matchAll(/::\s*(vector|halfvec|sparsevec)\b/gi)) found.add(`type ${match[1]}`);
  for (const match of code.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)\s*\(/gi)) {
    if (names.functions.has(match[1]!.toLowerCase())) found.add(`function ${match[1]}`);
  }
  for (const match of code.replace(/OPERATOR\(public\.[^)]*\)/g, ' ').matchAll(VECTOR_OPERATOR)) found.add(`operator ${match[1]}`);
  // Any position, so comma joins and subqueries count; a name followed by '.' is a column qualifier and one followed by '(' is a call.
  for (const match of code.matchAll(/(?<![.\w"])(pg_[a-z0-9_]+)\b(?!\s*[.(])/gi)) {
    if (names.catalogRelations.has(match[1]!.toLowerCase())) found.add(`catalog relation ${match[1]}`);
  }
  return [...found].sort();
}

describe('the unqualified-reference scanner', () => {
  const names: PublicNames = {
    relations: new Set(['documents', 'chunk_embeddings']),
    functions: new Set(['rag_assert_tenant_key', 'vector_dims']),
    catalogRelations: new Set(['pg_attribute', 'pg_class', 'pg_extension', 'pg_namespace']),
  };

  test('flags unqualified relations, row types, vector casts and operators, public-only calls and dynamic SQL', () => {
    const source = `
      DECLARE d documents%ROWTYPE;
      BEGIN
        PERFORM rag_assert_tenant_key(p_key);
        SELECT * INTO d FROM documents WHERE id = p_id;
        DELETE FROM public.chunk_embeddings e USING chunk_embeddings c WHERE e.embedding <=> $1::vector < 0.5;
        EXECUTE 'UPDATE documents SET slug = NULL WHERE id = $1' USING p_id;
      END`;
    assert.deepEqual(unqualifiedReferences(source, names), [
      'function rag_assert_tenant_key',
      'operator <=>',
      'relation chunk_embeddings',
      'relation documents',
      'row type documents',
      'type vector',
    ]);
  });

  test('accepts the qualified forms, comments and message strings', () => {
    const source = `
      DECLARE d public.documents%ROWTYPE;
      BEGIN
        -- FROM documents in a comment
        PERFORM public.rag_assert_tenant_key(p_key);
        SELECT * INTO d FROM public.documents WHERE id = p_id AND public.vector_dims($1) = 3;
        RAISE EXCEPTION 'nothing to read from documents';
        EXECUTE 'UPDATE public.documents SET slug = NULL WHERE id = $1' USING p_id;
        PERFORM e.embedding OPERATOR(public.<=>) $1::public.vector FROM public.chunk_embeddings e;
      END`;
    assert.deepEqual(unqualifiedReferences(source, names), []);
  });

  test('flags unqualified pg_catalog relations in FROM, JOIN, comma joins and subqueries, and accepts pg_catalog. and column qualifiers', () => {
    const flagged = `
      BEGIN
        SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
        PERFORM 1 FROM pg_catalog.pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, pg_attribute a WHERE a.attrelid = c.oid;
      END`;
    assert.deepEqual(unqualifiedReferences(flagged, names), ['catalog relation pg_attribute', 'catalog relation pg_extension', 'catalog relation pg_namespace']);
    const qualified = `
      BEGIN
        multi := EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE pg_attribute.attrelid = 'public.documents'::regclass);
        PERFORM pg_catalog.pg_notify('t', 'pg_class in a message');
        PERFORM pg_advisory_xact_lock(1);
      END`;
    assert.deepEqual(unqualifiedReferences(qualified, names), []);
  });
});

// Under SET search_path = '' PostgreSQL still searches the session's pg_temp first for relations and types (it is implicit and comes before
// pg_catalog unless listed), so a temporary table named after a catalog table must not change what a definer or guard reads.
describe('a temporary table named like a catalog table (multi-tenant, service_role)', () => {
  let db: PGlite;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.exec(`GRANT TEMPORARY ON DATABASE postgres TO service_role`);
  });

  after(async () => {
    await db?.close();
  });

  test('rag_ingest_assert_tenant_key still rejects the single-tenant key with pg_attribute shadowed', async () => {
    await db.exec(`SET ROLE service_role`);
    try {
      await db.exec(`CREATE TEMP TABLE pg_attribute (attrelid regclass, attname name, attnotnull boolean, attisdropped boolean)`);
      await db.exec(`CREATE TEMP TABLE pg_extension (extname name, extversion text)`);
      await assert.rejects(
        db.query(`SELECT public.rag_ingest_assert_tenant_key('s:default')`),
        (error: { code?: string; message?: string }) => error.code === '22023' && /invalid_tenant_key/.test(error.message ?? ''),
      );
    } finally {
      await db.exec(`DROP TABLE IF EXISTS pg_temp.pg_attribute, pg_temp.pg_extension`);
      await db.exec(`RESET ROLE`);
    }
  });
});

// The 0425 bodies name public.vector, public.halfvec, public.vector_dims and OPERATOR(public.<=>), so pgvector moved to another schema (for
// example by acting on Supabase lint 0014) would break them at run time. Each 0425 file stops first with a message that says so.
for (const mode of MODES) {
  describe(`0425 with pgvector outside public (${mode})`, () => {
    let db: PGlite;
    const files = migrationFiles(mode).filter((file) => /^supabase\/migrations\/0425_/.test(file));

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      await db.exec(`CREATE SCHEMA extensions; ALTER EXTENSION vector SET SCHEMA extensions`);
    });

    after(async () => {
      await db?.close();
    });

    test('every 0425 file stops with 55000 and names the schema check', async () => {
      assert.equal(files.length, 2);
      for (const file of files) {
        try {
          await assert.rejects(
            applyMigrationFiles(db, [file]),
            (error: { code?: string; message?: string }) =>
              error.code === '55000' && /pgvector must be in schema public, found extensions/.test(error.message ?? '') && /pg_extension/.test(error.message ?? ''),
            file,
          );
        } finally {
          await db.exec('ROLLBACK');
        }
      }
    });

    test('with pgvector back in public every 0425 file applies', async () => {
      await db.exec(`ALTER EXTENSION vector SET SCHEMA public`);
      await applyMigrationFiles(db, files);
    });
  });
}

for (const mode of MODES) {
  for (const kind of ['setup-plus-unfolded', 'frozen-plus-all'] as Build[]) {
    describe(`search_path '' (${mode}, ${kind})`, () => {
      let db: PGlite;
      let rows: FunctionRow[];
      let names: PublicNames;

      before(async () => {
        const legacy = await legacyFunctionNames(mode);
        db = await build(mode, kind);
        rows = await functionRows(db, legacy);
        names = await publicNames(db);
      });

      after(async () => {
        await db?.close();
      });

      // Trigger functions are in scope whatever their age: a trigger runs with the search_path of the statement that fired it, so a legacy
      // trigger without its own search_path fails (or resolves through pg_temp) under an empty-search_path writer.
      test('every public SECURITY DEFINER function, every trigger function and every function created from 0301 on has search_path ""', () => {
        const scoped = rows.filter((row) => row.definer || row.trigger || !row.legacy);
        assert.ok(scoped.filter((row) => row.definer).length > 100, `expected the full SECURITY DEFINER inventory, saw ${scoped.length}`);
        assert.ok(scoped.filter((row) => !row.legacy && !row.definer).length > 20, 'the post-Phase-3 invoker and trigger functions are in scope');
        assert.deepEqual(
          scoped.filter((row) => !row.empty_path).map((row) => `${row.signature} ${row.config ?? 'no search_path'}`),
          [],
        );
      });

      test('a function with an empty search_path names every public relation, type, function and operator with its schema', () => {
        const empty = rows.filter((row) => row.empty_path);
        const offenders = empty
          .map((row) => ({ signature: row.signature, references: unqualifiedReferences(row.source, names) }))
          .filter((entry) => entry.references.length > 0);
        assert.deepEqual(offenders, []);
        assert.ok(empty.length > 100, `expected the empty search_path inventory, saw ${empty.length}`);
      });

      test('no empty-search_path function calls a public function that has no search_path of its own', () => {
        const unpinned = new Set(rows.filter((row) => row.config === null).map((row) => row.signature.replace(/\(.*$/, '')));
        const callers = rows
          .filter((row) => row.empty_path)
          .flatMap((row) => [...row.source.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\s*\(/gi)].filter((match) => unpinned.has(match[1]!)).map((match) => `${row.signature} -> ${match[1]}`));
        assert.deepEqual([...new Set(callers)], []);
      });
    });
  }
}
