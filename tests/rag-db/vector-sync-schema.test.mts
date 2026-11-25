import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { catalogDump } from './schema-equality.test.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION_0701 = 'supabase/migrations/0701_vector_sync_outbox.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const TABLES = ['vector_sync_outbox', 'rag_vector_sync_targets', 'rag_backend_index_state'] as const;

type Role = 'anon' | 'authenticated' | 'service_role';
type SqlError = { message: string; code: string | null };

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<SqlError | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : null;
    return { message, code };
  }
}

function expectSqlState(err: SqlError | null, state: string): void {
  assert.ok(err, `expected SQLSTATE ${state}`);
  assert.equal(err.code, state, `expected ${state}, got code=${err.code} message=${err.message}`);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function tableExists(db: PGlite, name: string): Promise<boolean> {
  const r = await db.query<{ found: boolean }>('SELECT to_regclass($1) IS NOT NULL AS found', [`public.${name}`]);
  return r.rows[0]?.found === true;
}

async function requireTables(db: PGlite): Promise<void> {
  for (const table of TABLES) assert.equal(await tableExists(db, table), true, `${table} is missing`);
}

const INSERTS: Record<(typeof TABLES)[number], string> = {
  vector_sync_outbox: "INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key) VALUES ('qdrant', 'tenant', 's:default', 's:default')",
  rag_vector_sync_targets: "INSERT INTO public.rag_vector_sync_targets (target, enabled) VALUES ('weaviate', true) ON CONFLICT DO NOTHING",
  rag_backend_index_state:
    "INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ('qdrant', 'p-role', 's:default', 'building')",
};

for (const mode of MODES) {
  describe(`vector sync schema 0701 (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db.close();
    });

    test('the outbox, sync-target and index-state tables exist with the planned columns', async () => {
      await requireTables(db);
      const cols = await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position`,
        [TABLES as unknown as string[]],
      );
      const byTable = (t: string) => cols.rows.filter((r) => r.table_name === t).map((r) => r.column_name);
      for (const c of ['id', 'target', 'entity', 'entity_id', 'tenant_key', 'profile_id', 'enqueued_at', 'attempts', 'status', 'lease_until', 'last_error', 'cursor']) {
        assert.ok(byTable('vector_sync_outbox').includes(c), `vector_sync_outbox.${c} missing`);
      }
      for (const c of ['target', 'enabled', 'updated_at', 'updated_by']) {
        assert.ok(byTable('rag_vector_sync_targets').includes(c), `rag_vector_sync_targets.${c} missing`);
      }
      for (const c of ['target', 'profile_id', 'tenant_key', 'state', 'last_reconciled_at', 'lag_seconds', 'supabase_count', 'backend_count', 'last_error']) {
        assert.ok(byTable('rag_backend_index_state').includes(c), `rag_backend_index_state.${c} missing`);
      }
      const types = await db.query<{ data_type: string }>(
        "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vector_sync_outbox' AND column_name = 'entity_id'",
      );
      assert.equal(types.rows[0]?.data_type, 'text');
    });

    test('both backends are seeded disabled', async () => {
      await requireTables(db);
      const r = await db.query<{ target: string; enabled: boolean }>('SELECT target, enabled FROM public.rag_vector_sync_targets ORDER BY target');
      assert.deepEqual(r.rows, [
        { target: 'qdrant', enabled: false },
        { target: 'weaviate', enabled: false },
      ]);
    });

    test('enum columns reject unknown values', async () => {
      await requireTables(db);
      const bad: [string, string][] = [
        ['target', "INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key) VALUES ('pinecone', 'tenant', 's:default', 's:default')"],
        ['entity', "INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key) VALUES ('qdrant', 'row', 's:default', 's:default')"],
        ['status', "INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, status) VALUES ('qdrant', 'tenant', 's:default', 's:default', 'running')"],
        ['tenant case', "INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key) VALUES ('qdrant', 'tenant', 'S:DEFAULT', 'S:DEFAULT')"],
        ['targets', "INSERT INTO public.rag_vector_sync_targets (target, enabled) VALUES ('milvus', false)"],
        ['state', "INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ('qdrant', 'p', 's:default', 'warming')"],
        ['state target', "INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ('pgvector', 'p', 's:default', 'ready')"],
      ];
      for (const [label, sql] of bad) expectSqlState(await tryQuery(db, sql), '23514');
      for (const status of ['pending', 'leased', 'done', 'dead']) {
        for (const entity of ['chunk', 'document', 'profile', 'tenant']) {
          assert.equal(
            await tryQuery(
              db,
              "INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, status) VALUES ('weaviate', $1, 'x', 's:default', $2)",
              [entity, status],
            ),
            null,
          );
        }
      }
      for (const state of ['building', 'ready', 'stale', 'failed']) {
        assert.equal(
          await tryQuery(db, "INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ('weaviate', $1, 's:default', $1)", [state]),
          null,
        );
      }
      await db.exec('DELETE FROM public.vector_sync_outbox; DELETE FROM public.rag_backend_index_state;');
    });

    test('rag_backend_index_state is keyed by (target, profile_id, tenant_key)', async () => {
      await requireTables(db);
      const r = await db.query<{ cols: string }>(
        `SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS cols
           FROM pg_constraint c
           CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.conrelid = 'public.rag_backend_index_state'::regclass AND c.contype = 'p'`,
      );
      assert.equal(r.rows[0]?.cols, 'target,profile_id,tenant_key');
    });

    test('claim and per-entity indexes exist', async () => {
      await requireTables(db);
      const r = await db.query<{ def: string }>("SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'vector_sync_outbox'");
      const defs = r.rows.map((x) => x.def);
      assert.ok(defs.some((d) => /\(status, lease_until, enqueued_at\)/.test(d)), `claim index missing: ${defs.join(' | ')}`);
      assert.ok(defs.some((d) => /\(target, entity, entity_id\)/.test(d)), `entity index missing: ${defs.join(' | ')}`);
    });

    test('RLS is on with no policy on every table', async () => {
      await requireTables(db);
      const r = await db.query<{ relname: string; relrowsecurity: boolean; policies: number }>(
        `SELECT c.relname, c.relrowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c WHERE c.oid = ANY (ARRAY['public.vector_sync_outbox', 'public.rag_vector_sync_targets', 'public.rag_backend_index_state']::regclass[])
          ORDER BY c.relname`,
      );
      assert.equal(r.rows.length, 3);
      for (const row of r.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} has RLS off`);
        assert.equal(row.policies, 0, `${row.relname} has a policy`);
      }
    });

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on SELECT and INSERT for every table (anon and authenticated refused)`, async () => {
        await requireTables(db);
        for (const table of TABLES) {
          expectSqlState(await asRole(db, role, () => tryQuery(db, `SELECT 1 FROM public.${table} LIMIT 1`)), '42501');
          expectSqlState(await asRole(db, role, () => tryQuery(db, INSERTS[table])), '42501');
          expectSqlState(await asRole(db, role, () => tryQuery(db, `DELETE FROM public.${table}`)), '42501');
        }
      });
    }

    test('service_role reads and writes every table', async () => {
      await requireTables(db);
      await asRole(db, 'service_role', async () => {
        for (const table of TABLES) {
          assert.equal(await tryQuery(db, INSERTS[table]), null, `service_role insert into ${table}`);
          assert.equal(await tryQuery(db, `SELECT 1 FROM public.${table}`), null, `service_role select ${table}`);
        }
        assert.equal(await tryQuery(db, "UPDATE public.vector_sync_outbox SET status = 'done'"), null);
        assert.equal(await tryQuery(db, 'DELETE FROM public.vector_sync_outbox'), null);
        assert.equal(await tryQuery(db, "DELETE FROM public.rag_backend_index_state WHERE profile_id = 'p-role'"), null);
        assert.equal(await tryQuery(db, 'UPDATE public.rag_vector_sync_targets SET enabled = false'), null);
      });
    });

    test('re-applying 0701 leaves the catalog unchanged and keeps the seed', async () => {
      await requireTables(db);
      const before = await catalogDump(db);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION_0701), 'utf8'));
      const afterDump = await catalogDump(db);
      assert.deepEqual(afterDump, before);
      const n = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_vector_sync_targets');
      assert.equal(n.rows[0]?.n, 2);
    });
  });
}
