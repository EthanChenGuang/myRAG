import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0970_rag_pilot_users.sql';
const ORG_B = '00000000-0000-4000-8000-0000000009c1';

type Role = 'anon' | 'authenticated' | 'service_role';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function add(db: PGlite, tenantKey: string | null, userId: string, actor: string | null): Promise<boolean> {
  const result = await db.query<{ ok: boolean }>('SELECT public.rag_pilot_user_add($1, $2, $3) AS ok', [tenantKey, userId, actor]);
  return result.rows[0]!.ok;
}

async function remove(db: PGlite, tenantKey: string | null, userId: string): Promise<boolean> {
  const result = await db.query<{ ok: boolean }>('SELECT public.rag_pilot_user_remove($1, $2) AS ok', [tenantKey, userId]);
  return result.rows[0]!.ok;
}

async function pilotsOf(db: PGlite, tenantKey: string): Promise<string[]> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ user_id: string }>('SELECT user_id FROM public.rag_pilot_users WHERE tenant_key = $1 ORDER BY user_id', [tenantKey]),
  );
  return result.rows.map((row) => row.user_id);
}

for (const mode of MODES) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = `o:${ORG_B}`;
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`rag_pilot_users (${mode})`, () => {
    let db: PGlite;
    let user1: string;
    let user2: string;
    let actor: string;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      user1 = await createUser(db);
      user2 = await createUser(db);
      actor = await createUser(db);
    });

    after(async () => {
      await db?.close();
    });

    test('RLS is on with no policy', async () => {
      const rls = await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_pilot_users'::regclass");
      assert.equal(rls.rows[0]?.relrowsecurity, true);
      const policies = await db.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rag_pilot_users'");
      assert.equal(policies.rows.length, 0);
    });

    test('add returns true then false; remove returns true then false', async () => {
      assert.equal(await asRole(db, 'service_role', () => add(db, tenantA, user1, actor)), true);
      assert.equal(await asRole(db, 'service_role', () => add(db, tenantA, user1, actor)), false);
      assert.deepEqual(await pilotsOf(db, tenantA), [user1]);
      const row = await asRole(db, 'service_role', () =>
        db.query<{ added_by: string; added_at: Date }>('SELECT added_by, added_at FROM public.rag_pilot_users WHERE tenant_key = $1 AND user_id = $2', [tenantA, user1]),
      );
      assert.equal(row.rows[0]?.added_by, actor);
      assert.ok(row.rows[0]?.added_at);
      assert.equal(await asRole(db, 'service_role', () => remove(db, tenantA, user1)), true);
      assert.equal(await asRole(db, 'service_role', () => remove(db, tenantA, user1)), false);
      assert.deepEqual(await pilotsOf(db, tenantA), []);
    });

    test('a NULL actor is accepted (local operator)', async () => {
      assert.equal(await asRole(db, 'service_role', () => add(db, tenantA, user2, null)), true);
      assert.equal(await asRole(db, 'service_role', () => remove(db, tenantA, user2)), true);
    });

    if (mode === 'multi-tenant') {
      test('a pilot user of tenant A is not returned for tenant B, and removing under B leaves A intact', async () => {
        assert.equal(await asRole(db, 'service_role', () => add(db, tenantA, user1, actor)), true);
        assert.equal(await asRole(db, 'service_role', () => add(db, tenantB, user2, actor)), true);
        assert.deepEqual(await pilotsOf(db, tenantA), [user1]);
        assert.deepEqual(await pilotsOf(db, tenantB), [user2]);
        assert.equal(await asRole(db, 'service_role', () => remove(db, tenantB, user1)), false);
        assert.deepEqual(await pilotsOf(db, tenantA), [user1]);
        assert.equal(await asRole(db, 'service_role', () => remove(db, tenantA, user1)), true);
        assert.equal(await asRole(db, 'service_role', () => remove(db, tenantB, user2)), true);
      });
    }

    test('an unknown user is rejected by the foreign key', async () => {
      await assert.rejects(
        () => asRole(db, 'service_role', () => add(db, tenantA, crypto.randomUUID(), actor)),
        (error: unknown) => sqlState(error) === '23503',
      );
    });

    test('a malformed tenant key is rejected by the table CHECK', async () => {
      await assert.rejects(
        () => asRole(db, 'service_role', () => db.query("INSERT INTO public.rag_pilot_users (tenant_key, user_id) VALUES ('x:1', $1)", [user1])),
        (error: unknown) => sqlState(error) === '23514',
      );
    });

    for (const [label, key] of [
      ['NULL', null],
      ['x:1', 'x:1'],
      ['an upper-case uuid', `u:${FIXTURE_USER_ID.toUpperCase()}`],
      ['the other mode key', wrongModeKey],
    ] as const) {
      test(`${label} key raises 22023 on add and remove`, async () => {
        await assert.rejects(() => asRole(db, 'service_role', () => add(db, key, user1, actor)), (error: unknown) => sqlState(error) === '22023');
        await assert.rejects(() => asRole(db, 'service_role', () => remove(db, key, user1)), (error: unknown) => sqlState(error) === '22023');
      });
    }

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on the table and both functions`, async () => {
        const refused = (run: () => Promise<unknown>) => assert.rejects(() => asRole(db, role, run), (error: unknown) => sqlState(error) === '42501');
        await refused(() => add(db, tenantA, user1, actor));
        await refused(() => remove(db, tenantA, user1));
        await refused(() => db.query('SELECT user_id FROM public.rag_pilot_users'));
        await refused(() => db.query('INSERT INTO public.rag_pilot_users (tenant_key, user_id) VALUES ($1, $2)', [tenantA, user1]));
        await refused(() => db.query('UPDATE public.rag_pilot_users SET added_by = NULL'));
        await refused(() => db.query('DELETE FROM public.rag_pilot_users'));
      });
    }

    for (const signature of ['public.rag_pilot_user_add(text, uuid, uuid)', 'public.rag_pilot_user_remove(text, uuid)']) {
      test(`${signature} is SECURITY INVOKER with an empty search_path, executable by service_role only`, async () => {
        const proc = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
          'SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure',
          [signature],
        );
        assert.equal(proc.rows[0]?.prosecdef, false);
        assert.ok((proc.rows[0]?.proconfig ?? []).some((entry) => entry === 'search_path=""' || entry === 'search_path='));
        const grants = await db.query<{ role: string; allowed: boolean }>(
          `SELECT r AS role, has_function_privilege(r, $1, 'EXECUTE') AS allowed FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
          [signature],
        );
        assert.deepEqual(Object.fromEntries(grants.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true });
        const publicGrant = await db.query(
          'SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0',
          [signature],
        );
        assert.equal(publicGrant.rows.length, 0);
      });
    }

    test('deleting the auth user removes the pilot row; deleting the actor keeps it', async () => {
      const pilot = await createUser(db);
      const adder = await createUser(db);
      assert.equal(await asRole(db, 'service_role', () => add(db, tenantA, pilot, adder)), true);
      await db.query('DELETE FROM auth.users WHERE id = $1', [adder]);
      const kept = await asRole(db, 'service_role', () =>
        db.query<{ added_by: string | null }>('SELECT added_by FROM public.rag_pilot_users WHERE user_id = $1', [pilot]),
      );
      assert.equal(kept.rows.length, 1);
      assert.equal(kept.rows[0]?.added_by, null);
      await db.query('DELETE FROM auth.users WHERE id = $1', [pilot]);
      assert.equal((await pilotsOf(db, tenantA)).includes(pilot), false);
    });

    test('applying the file a second time raises no error and keeps the rows', async () => {
      assert.equal(await asRole(db, 'service_role', () => add(db, tenantA, user2, actor)), true);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      assert.deepEqual(await pilotsOf(db, tenantA), [user2]);
      assert.equal(await asRole(db, 'service_role', () => add(db, tenantA, user2, actor)), false);
    });
  });
}
