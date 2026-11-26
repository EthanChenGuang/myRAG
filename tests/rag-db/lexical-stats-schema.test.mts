import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0900: the Phase 4.4 lexical statistics store (D-10, D-31). Four tables closed to every client role, RLS on with no policy, and
 * rag_lexical_dl(tsvector), the length of a positional vector. Idempotent, with a 55000 precheck.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0900_lexical_stats_schema.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus'] as const;
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

const COLUMNS: Record<(typeof TABLES)[number], Record<string, { type: string; nullable: boolean }>> = {
  rag_lexical_stats_state: {
    tenant_key: { type: 'text', nullable: false },
    status: { type: 'text', nullable: false },
    enabled_at: { type: 'timestamp with time zone', nullable: false },
    rebuilt_at: { type: 'timestamp with time zone', nullable: true },
    compacted_at: { type: 'timestamp with time zone', nullable: true },
  },
  rag_lexical_stats_pending: {
    id: { type: 'bigint', nullable: false },
    tenant_key: { type: 'text', nullable: false },
    corpus: { type: 'text', nullable: false },
    chunking_profile_id: { type: 'text', nullable: false },
    language: { type: 'text', nullable: false },
    sign: { type: 'smallint', nullable: false },
    lexemes: { type: 'ARRAY', nullable: false },
    dl: { type: 'integer', nullable: false },
    created_at: { type: 'timestamp with time zone', nullable: false },
  },
  rag_lexical_df: {
    tenant_key: { type: 'text', nullable: false },
    corpus: { type: 'text', nullable: false },
    lexeme: { type: 'text', nullable: false },
    chunking_profile_id: { type: 'text', nullable: false },
    language: { type: 'text', nullable: false },
    df: { type: 'bigint', nullable: false },
  },
  rag_lexical_corpus: {
    tenant_key: { type: 'text', nullable: false },
    corpus: { type: 'text', nullable: false },
    chunking_profile_id: { type: 'text', nullable: false },
    language: { type: 'text', nullable: false },
    chunk_count: { type: 'bigint', nullable: false },
    total_len: { type: 'bigint', nullable: false },
  },
};

const PRIMARY_KEYS: Record<(typeof TABLES)[number], string[]> = {
  rag_lexical_stats_state: ['tenant_key'],
  rag_lexical_stats_pending: ['id'],
  rag_lexical_df: ['tenant_key', 'corpus', 'lexeme', 'chunking_profile_id', 'language'],
  rag_lexical_corpus: ['tenant_key', 'corpus', 'chunking_profile_id', 'language'],
};

async function tableExists(db: PGlite, table: string): Promise<boolean> {
  return (await db.query<{ ok: boolean }>('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS ok', [`public.${table}`])).rows[0]?.ok === true;
}

async function rejectsWithCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (error: unknown) => (error as { code?: string }).code === code);
}

for (const mode of MODES) {
  describe(`0900 lexical statistics store (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db.close();
    });

    test('the four tables exist with the D-10 columns and primary keys', async () => {
      for (const table of TABLES) {
        assert.ok(await tableExists(db, table), `${table} is missing`);
        const rows = (
          await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
            [table],
          )
        ).rows;
        const actual = Object.fromEntries(rows.map((row) => [row.column_name, { type: row.data_type, nullable: row.is_nullable === 'YES' }]));
        assert.deepEqual(actual, COLUMNS[table], table);
        const pk = (
          await db.query<{ attname: string }>(
            `SELECT a.attname FROM pg_catalog.pg_index i
               JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = $1::regclass AND i.indisprimary
              ORDER BY array_position(i.indkey::int2[], a.attnum)`,
            [`public.${table}`],
          )
        ).rows.map((row) => row.attname);
        assert.deepEqual(pk, PRIMARY_KEYS[table], `${table} primary key`);
      }
    });

    test('checks: status, sign and corpus; corpus defaults to chunks; pending has a (tenant_key, id) index', async () => {
      assert.ok(await tableExists(db, 'rag_lexical_stats_state'));
      await rejectsWithCode(() => db.query("INSERT INTO public.rag_lexical_stats_state (tenant_key, status) VALUES ('s:probe', 'other')"), '23514');
      await rejectsWithCode(
        () =>
          db.query(
            "INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl) VALUES ('s:probe', 'legacy', 'und', 2, '{}', 0)",
          ),
        '23514',
      );
      await rejectsWithCode(
        () =>
          db.query(
            "INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df) VALUES ('s:probe', 'other', 'w1', 'legacy', 'und', 1)",
          ),
        '23514',
      );
      await db.query('BEGIN');
      try {
        const corpus = await db.query<{ corpus: string }>(
          "INSERT INTO public.rag_lexical_corpus (tenant_key, chunking_profile_id, language, chunk_count, total_len) VALUES ('s:probe', 'legacy', 'und', 0, 0) RETURNING corpus",
        );
        assert.equal(corpus.rows[0]?.corpus, 'chunks');
        const df = await db.query<{ corpus: string }>(
          "INSERT INTO public.rag_lexical_df (tenant_key, lexeme, chunking_profile_id, language, df) VALUES ('s:probe', 'w1', 'legacy', 'und', -1) RETURNING corpus",
        );
        assert.equal(df.rows[0]?.corpus, 'chunks', 'no positivity check: compaction removes non-positive rows');
      } finally {
        await db.query('ROLLBACK');
      }
      const idx = (
        await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'rag_lexical_stats_pending_tenant_id_idx'")
      ).rows;
      assert.equal(idx.length, 1);
      assert.match(idx[0]!.indexdef, /\(tenant_key, id\)$/);
    });

    test('RLS is on with no policy; anon and authenticated hold no table privilege, service_role holds all', async () => {
      for (const table of TABLES) {
        const rls = (await db.query<{ on: boolean }>('SELECT relrowsecurity AS on FROM pg_class WHERE oid = to_regclass($1)', [`public.${table}`])).rows;
        assert.equal(rls[0]?.on, true, `${table} RLS`);
        const policies = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = $1", [table])).rows;
        assert.equal(policies[0]?.n, 0, `${table} policies`);
        for (const privilege of PRIVILEGES) {
          for (const role of ['anon', 'authenticated']) {
            const r = await db.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, privilege]);
            assert.equal(r.rows[0]?.ok, false, `${role} ${privilege} on ${table}`);
          }
          const s = await db.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', ['service_role', `public.${table}`, privilege]);
          assert.equal(s.rows[0]?.ok, true, `service_role ${privilege} on ${table}`);
        }
      }
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>("SELECT has_sequence_privilege($1, 'public.rag_lexical_stats_pending_id_seq', 'USAGE') AS ok", [role]);
        assert.equal(r.rows[0]?.ok, false, `${role} sequence usage`);
      }
    });

    test('a client role reading the tables is refused', async () => {
      assert.ok(await tableExists(db, 'rag_lexical_df'));
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          for (const table of TABLES) await rejectsWithCode(() => db.query(`SELECT 1 FROM public.${table}`), '42501');
        } finally {
          await db.exec('RESET ROLE');
        }
      }
    });

    test('rag_lexical_dl sums stored positions; immutable, empty search_path, service_role only', async () => {
      const r = await db.query<{ three: number; zero: number; one: number }>(
        "SELECT public.rag_lexical_dl('w1:1,3 w2:2'::tsvector) AS three, public.rag_lexical_dl(''::tsvector) AS zero, public.rag_lexical_dl(public.rag_lexical_tsvector('w7')) AS one",
      );
      assert.deepEqual(r.rows[0], { three: 3, zero: 0, one: 1 });
      const meta = (
        await db.query<{ vol: string; secdef: boolean; cfg: string[] | null }>(
          "SELECT provolatile AS vol, prosecdef AS secdef, proconfig AS cfg FROM pg_proc WHERE oid = 'public.rag_lexical_dl(tsvector)'::regprocedure",
        )
      ).rows[0];
      assert.equal(meta?.vol, 'i');
      assert.equal(meta?.secdef, false);
      assert.deepEqual(meta?.cfg, ['search_path=""']);
      for (const role of ['anon', 'authenticated', 'public']) {
        const ok = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'public.rag_lexical_dl(tsvector)', 'EXECUTE') AS ok", [role]);
        assert.equal(ok.rows[0]?.ok, false, `${role} EXECUTE`);
      }
      const svc = await db.query<{ ok: boolean }>("SELECT has_function_privilege('service_role', 'public.rag_lexical_dl(tsvector)', 'EXECUTE') AS ok");
      assert.equal(svc.rows[0]?.ok, true);
    });

    test('applying 0900 twice changes nothing and raises nothing', async () => {
      assert.ok(await tableExists(db, 'rag_lexical_stats_state'));
      await db.query("INSERT INTO public.rag_lexical_stats_state (tenant_key) VALUES ('s:keep')");
      await applyMigrationFiles(db, [MIGRATION]);
      const kept = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_lexical_stats_state WHERE tenant_key = 's:keep'");
      assert.equal(kept.rows[0]?.n, 1);
      await db.query("DELETE FROM public.rag_lexical_stats_state WHERE tenant_key = 's:keep'");
    });
  });

  describe(`0900 precheck (${mode})`, () => {
    test('raises 55000 on a database without rag_assert_tenant_key', async () => {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATION)), `${MIGRATION} is missing`);
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        // The setup files fold 0403, so the missing prerequisite is simulated by dropping it.
        await fixture.db.exec('DROP FUNCTION IF EXISTS public.rag_assert_tenant_key(text) CASCADE');
        await rejectsWithCode(() => applyMigrationFiles(fixture.db, [MIGRATION]), '55000');
      } finally {
        await fixture.db.close();
      }
    });
  });
}
