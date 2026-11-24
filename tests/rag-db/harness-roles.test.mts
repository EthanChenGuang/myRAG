import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

type Role = 'anon' | 'authenticated' | 'service_role';

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function expectFunctionDenied(db: PGlite, role: Role, fnName: string): Promise<void> {
  await assert.rejects(
    () => asRole(db, role, () => db.query(`SELECT ${fnName}()`)),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
      return code === '42501' && message.includes(`for function ${fnName}`);
    },
  );
}

for (const mode of MODES) {
  describe(`PGlite harness roles (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('service_role bypasses RLS and sees every document_chunks row', async () => {
      const total = Number((await fixture.db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks')).rows[0].n);
      const asService = Number(
        (await asRole(fixture.db, 'service_role', () => fixture.db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks'))).rows[0].n,
      );
      assert.ok(total > 0);
      assert.equal(asService, total);
    });

    test('anon can read documents when table grants exist (RLS filters rows, not missing table privilege)', async () => {
      await asRole(fixture.db, 'anon', async () => {
        await fixture.db.query('SELECT 1 FROM documents LIMIT 1');
      });
    });

    test('a function revoked from PUBLIC and anon is refused under SET ROLE anon with SQLSTATE 42501', async () => {
      const fn = 'harness_role_only_fn';
      await fixture.db.exec(`
        CREATE OR REPLACE FUNCTION ${fn}() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
        REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION ${fn}() TO service_role;
      `);
      await expectFunctionDenied(fixture.db, 'anon', fn);
      const ok = await asRole(fixture.db, 'service_role', () => fixture.db.query<{ v: number }>(`SELECT ${fn}() AS v`));
      assert.equal(ok.rows[0]?.v, 1);
    });

    test('embedding_profiles stays revoked from anon after default privileges', async () => {
      const row = await fixture.db.query<{ anon: boolean }>(
        "SELECT has_table_privilege('anon', 'public.embedding_profiles', 'SELECT') AS anon",
      );
      assert.equal(row.rows[0]?.anon, false);
    });
  });
}