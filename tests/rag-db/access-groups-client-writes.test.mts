import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0921 (Phase 4.3) adds access_groups CHECK constraints to documents and document_chunks. RLS still lets an owner write those rows as
 * `authenticated`, so the constraints must be evaluable by that role: they state the rule inline instead of calling the service_role-only
 * rag_access_keys_valid. Default arrays pass, invalid keys still violate the constraint, and the function itself stays service_role only.
 */
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ZERO_VECTOR = `[${new Array(1536).fill(0).join(',')}]`;
const OWNER = '00000000-0000-4000-8000-000009210a01';
const DOC = '00000000-0000-4000-8000-000009210d01';
const CHUNK = '00000000-0000-4000-8000-000009210c01';
const GROUP_KEY = 'g:00000000-0000-4000-8000-000009210f01';

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

async function violatesCheck(run: () => Promise<unknown>, constraint: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.match(error instanceof Error ? error.message : String(error), new RegExp(constraint));
    return true;
  });
}

for (const mode of MODES) {
  describe(`access_groups CHECK constraints for client writes (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseFunctionDefaults: true })).db;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [OWNER, 'owner@example.invalid']);
    });

    after(async () => {
      await db.close();
    });

    test('the constraints call no function the client roles cannot execute, and rag_access_keys_valid stays service_role only', async () => {
      const defs = await db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname IN ('documents_access_groups_check', 'document_chunks_access_groups_check') ORDER BY conname`,
      );
      assert.equal(defs.rows.length, 2);
      for (const row of defs.rows) assert.doesNotMatch(row.def, /rag_access_keys_valid/);
      const grants = await db.query<{ role: string; allowed: boolean }>(
        `SELECT r.role, has_function_privilege(r.role, 'public.rag_access_keys_valid(text[])', 'EXECUTE') AS allowed
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role) ORDER BY r.role`,
      );
      assert.deepEqual(grants.rows, [
        { role: 'anon', allowed: false },
        { role: 'authenticated', allowed: false },
        { role: 'service_role', allowed: true },
      ]);
    });

    test('an owner inserts and updates a document and its chunk with the default access groups', async () => {
      await asOwner(db, async () => {
        await db.query('INSERT INTO documents (id, filename, content, user_id) VALUES ($1, $2, $3, $4)', [DOC, 'owned.md', 'body', OWNER]);
        await db.query('INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index) VALUES ($1, $2, $3, $4, 0)', [
          CHUNK,
          DOC,
          'chunk body',
          ZERO_VECTOR,
        ]);
        const doc = await db.query('UPDATE documents SET filename = $2 WHERE id = $1 RETURNING id', [DOC, 'renamed.md']);
        assert.equal(doc.rows.length, 1, 'the owner policy allows the document update');
        await db.query('UPDATE document_chunks SET content = $2 WHERE id = $1', [CHUNK, 'edited chunk body']);
      });
      const stored = await db.query<{ doc: string[]; chunk: string[] }>(
        'SELECT d.access_groups AS doc, c.access_groups AS chunk FROM documents d JOIN document_chunks c ON c.document_id = d.id WHERE d.id = $1',
        [DOC],
      );
      assert.deepEqual(stored.rows, [{ doc: ['all'], chunk: ['all'] }]);
    });

    test('an owner sets a valid group key; invalid keys still violate the constraint', async () => {
      await asOwner(db, async () => {
        await db.query('UPDATE documents SET access_groups = $2 WHERE id = $1', [DOC, [GROUP_KEY]]);
        for (const invalid of [[], ['everyone'], ['all', GROUP_KEY], ['G:00000000-0000-4000-8000-000009210f01'], [`${GROUP_KEY},all`]]) {
          await violatesCheck(() => db.query('UPDATE documents SET access_groups = $2 WHERE id = $1', [DOC, invalid]), 'documents_access_groups_check');
        }
        await violatesCheck(
          () => db.query("UPDATE documents SET access_groups = ARRAY['all', NULL]::text[] WHERE id = $1", [DOC]),
          'documents_access_groups_check',
        );
      });
      // A chunk always takes its document's array (the 0921 trigger), so its constraint is checked through the shared rule text.
      const keys = await db.query<{ doc: string[]; chunk: string[] }>(
        'SELECT d.access_groups AS doc, c.access_groups AS chunk FROM documents d JOIN document_chunks c ON c.document_id = d.id WHERE d.id = $1',
        [DOC],
      );
      assert.deepEqual(keys.rows, [{ doc: [GROUP_KEY], chunk: ['all'] }]);
      await db.query('UPDATE document_chunks SET access_groups = $2 WHERE id = $1', [CHUNK, ['nobody']]);
      const chunk = await db.query<{ k: string[] }>('SELECT access_groups AS k FROM document_chunks WHERE id = $1', [CHUNK]);
      assert.deepEqual(chunk.rows, [{ k: [GROUP_KEY] }], 'the trigger replaces the written array with the document one');
      const defs = await db.query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('documents_access_groups_check', 'document_chunks_access_groups_check')",
      );
      assert.equal(new Set(defs.rows.map((row) => row.def)).size, 1, 'both tables check the same rule');
    });

    test('the inline rule and rag_access_keys_valid agree', async () => {
      const cases: (string | null)[][] = [['all'], [GROUP_KEY], [GROUP_KEY, 'u:00000000-0000-4000-8000-000009210a01'], [], ['all', 'all'], ['x'], [null]];
      for (const keys of cases) {
        const fn = await db.query<{ ok: boolean }>('SELECT public.rag_access_keys_valid($1::text[]) AS ok', [keys]);
        const inline = await db.query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM (SELECT $1::text[] AS access_groups) t
             WHERE ${(await db.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'documents_access_groups_check'")).rows[0]!.def.replace(/^CHECK /, '')}) AS ok`,
          [keys],
        );
        assert.equal(inline.rows[0]!.ok, fn.rows[0]!.ok, JSON.stringify(keys));
      }
    });
  });
}
