import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 03.3 verification G8 (security F-2, T-03.3-1504): on INSERT, the 1006 stamp trigger copied metadata.attribute_header_stamp into
 * document_chunks.attribute_header_stamp for any role, and the 1001 guard covers UPDATE only. Migration 1011 clears the column on INSERT
 * unless the role is service_role (or postgres / supabase_admin). A signed-in owner inserting a chunk of their own document gets either a
 * refusal (42501, once direct client inserts are blocked) or a row without a stamp; the service-role writer keeps its stamp.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/1011_attribute_header_stamp_insert_guard.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ZERO_VECTOR = `[${new Array(1536).fill(0).join(',')}]`;
const OWNER = '00000000-0000-4000-8000-000010110a01';
const DOC = '00000000-0000-4000-8000-000010110d01';
const CLIENT_META_CHUNK = '00000000-0000-4000-8000-000010110c01';
const CLIENT_COLUMN_CHUNK = '00000000-0000-4000-8000-000010110c02';
const SERVICE_CHUNK = '00000000-0000-4000-8000-000010110c03';
const FORGED = 't7.0123456789ab';
const SERVICE_STAMP = 't3.abcdefabcdef';

async function asOwner<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [OWNER]);
  await db.exec('SET ROLE authenticated');
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}

async function attempt(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : String(error);
  }
}

async function stampOf(db: PGlite, id: string): Promise<{ found: boolean; stamp: string | null }> {
  const result = await db.query<{ stamp: string | null }>('SELECT attribute_header_stamp AS stamp FROM document_chunks WHERE id = $1', [id]);
  return { found: result.rows.length === 1, stamp: result.rows[0]?.stamp ?? null };
}

for (const mode of MODES) {
  describe(`attribute header stamp insert guard (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseFunctionDefaults: true })).db;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [OWNER, 'owner@example.invalid']);
      // 0991 (UF-1): client roles cannot insert documents; the owner's document is written by the service role, as the app does.
      await db.exec('SET ROLE service_role');
      try {
        await db.query('INSERT INTO documents (id, filename, content, user_id) VALUES ($1, $2, $3, $4)', [DOC, 'owned.md', 'body', OWNER]);
      } finally {
        await db.exec('RESET ROLE');
      }
    });

    after(async () => {
      await db.close();
    });

    test('an authenticated INSERT cannot choose the stamp, through the metadata key or the column', async () => {
      const viaMetadata = await asOwner(db, () =>
        attempt(() =>
          db.query('INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata) VALUES ($1, $2, $3, $4, 0, $5::jsonb)', [
            CLIENT_META_CHUNK,
            DOC,
            'neutral chunk body',
            ZERO_VECTOR,
            JSON.stringify({ attribute_header_stamp: FORGED }),
          ]),
        ),
      );
      const viaColumn = await asOwner(db, () =>
        attempt(() =>
          db.query(
            'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, attribute_header_stamp) VALUES ($1, $2, $3, $4, 1, $5)',
            [CLIENT_COLUMN_CHUNK, DOC, 'neutral chunk body two', ZERO_VECTOR, FORGED],
          ),
        ),
      );
      for (const [label, code, id] of [
        ['metadata', viaMetadata, CLIENT_META_CHUNK],
        ['column', viaColumn, CLIENT_COLUMN_CHUNK],
      ] as const) {
        // 0991 (UF-1): a client INSERT into document_chunks is refused, so no row and no forged stamp exist.
        assert.equal(code, '42501', `${label}: refused with 42501, got ${code}`);
        const stored = await stampOf(db, id);
        assert.equal(stored.found, false, `${label}: no row inserted`);
        assert.equal(stored.stamp, null, `${label}: no forged stamp`);
      }
    });

    test('the service role keeps the stamp it writes through the metadata key', async () => {
      await db.exec('SET ROLE service_role');
      try {
        await db.query('INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata) VALUES ($1, $2, $3, $4, 2, $5::jsonb)', [
          SERVICE_CHUNK,
          DOC,
          'neutral chunk body three',
          ZERO_VECTOR,
          JSON.stringify({ attribute_header_stamp: SERVICE_STAMP }),
        ]);
      } finally {
        await db.exec('RESET ROLE');
      }
      assert.deepEqual(await stampOf(db, SERVICE_CHUNK), { found: true, stamp: SERVICE_STAMP });
    });

    test('1011 catalog: INVOKER, empty search_path, service_role only, trigger after the 1006 stamp trigger, idempotent', async () => {
      const fn = (
        await db.query<Record<string, unknown>>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                  EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') AS public
           FROM pg_proc p WHERE p.oid = to_regprocedure('public.rag_chunk_attribute_header_stamp_insert_guard()')`,
        )
      ).rows[0];
      assert.ok(fn, 'guard function exists');
      assert.equal(fn.definer, false);
      assert.ok((fn.config as string[]).some((entry) => /^search_path=("")?$/.test(entry)));
      assert.deepEqual([fn.anon, fn.authenticated, fn.public, fn.service_role], [false, false, false, true]);
      const order = async () =>
        (
          await db.query<{ tgname: string }>(
            `SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid = 'public.document_chunks'::regclass AND NOT t.tgisinternal
               AND t.tgname LIKE 'rag_chunk_attribute_header_stamp%' ORDER BY t.tgname COLLATE "C"`,
          )
        ).rows.map((row) => row.tgname);
      const before = await order();
      assert.deepEqual(before, ['rag_chunk_attribute_header_stamp', 'rag_chunk_attribute_header_stamp_x_insert_guard']);
      const def = async () =>
        (await db.query<{ def: string }>("SELECT pg_get_functiondef('public.rag_chunk_attribute_header_stamp_insert_guard()'::regprocedure) AS def")).rows[0]?.def;
      const first = await def();
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      assert.equal(await def(), first);
      assert.deepEqual(await order(), before);
    });
  });
}
