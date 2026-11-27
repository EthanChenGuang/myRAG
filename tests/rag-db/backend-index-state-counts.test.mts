import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

/** 0709 rag_backend_index_state_counts (D-16): tenants per (target, profile, state), counts only, service role only. */

const MIGRATION = 'supabase/migrations/0709_backend_index_state_counts.sql';
const KEYS = [
  'u:00000000-0000-4000-8000-0000000015c1',
  'u:00000000-0000-4000-8000-0000000015c2',
  'o:00000000-0000-4000-8000-0000000015c3',
];

async function errorCode(db: PGlite, sql: string): Promise<string | undefined> {
  try {
    await db.query(sql);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describe('0709 rag_backend_index_state_counts (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    const rows: Array<[string, string, string, string]> = [
      ['qdrant', 'profile-a', KEYS[0], 'ready'],
      ['qdrant', 'profile-a', KEYS[1], 'ready'],
      ['qdrant', 'profile-a', KEYS[2], 'stale'],
      ['qdrant', 'profile-b', KEYS[0], 'building'],
      ['weaviate', 'profile-a', KEYS[1], 'failed'],
    ];
    for (const [target, profile, key, state] of rows) {
      await db.query('INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ($1, $2, $3, $4)', [target, profile, key, state]);
    }
  });

  after(async () => {
    await db?.close();
  });

  test('is SECURITY INVOKER with an empty search_path and executable by service_role only', async () => {
    const rows = (
      await db.query<{ prosecdef: boolean; proconfig: string[] | null; public_exec: boolean; anon_exec: boolean; auth_exec: boolean; service_exec: boolean }>(
        `SELECT p.prosecdef, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_backend_index_state_counts'`,
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prosecdef, false);
    assert.ok((rows[0].proconfig ?? []).includes('search_path=""'));
    assert.deepEqual([rows[0].public_exec, rows[0].anon_exec, rows[0].auth_exec, rows[0].service_exec], [false, false, false, true]);
  });

  test('anon and authenticated get 42501; service_role reads grouped counts with no tenant key', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      try {
        assert.equal(await errorCode(db, 'SELECT * FROM public.rag_backend_index_state_counts()'), '42501', role);
      } finally {
        await db.exec('RESET ROLE');
      }
    }
    await db.exec('SET ROLE service_role');
    try {
      const result = await db.query<{ target: string; profile_id: string; state: string; tenants: string | number }>(
        'SELECT * FROM public.rag_backend_index_state_counts()',
      );
      assert.deepEqual(
        result.fields.map((f) => f.name),
        ['target', 'profile_id', 'state', 'tenants'],
      );
      assert.deepEqual(
        result.rows.map((r) => [r.target, r.profile_id, r.state, Number(r.tenants)]),
        [
          ['qdrant', 'profile-a', 'ready', 2],
          ['qdrant', 'profile-a', 'stale', 1],
          ['qdrant', 'profile-b', 'building', 1],
          ['weaviate', 'profile-a', 'failed', 1],
        ],
      );
      const text = JSON.stringify(result.rows);
      for (const key of KEYS) assert.ok(!text.includes(key), 'no tenant key in the result');
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  test('re-applying the migration is idempotent', async () => {
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    const again = await db.query('SELECT * FROM public.rag_backend_index_state_counts()');
    assert.equal(again.rows.length, 4);
  });
});
