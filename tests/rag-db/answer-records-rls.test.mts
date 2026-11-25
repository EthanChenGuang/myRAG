import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { startFakeEdge } from '../../eval/harness/fake-edge.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const FIXTURE_ANON_KEY = 'fixture-anon-key-placeholder';

type Role = 'anon' | 'authenticated' | 'service_role';

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function refused(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === '42501');
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function insertRecord(db: PGlite, userId: string, organizationId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO rag_answer_records (id, user_id, organization_id, rag_mode) VALUES ($1, $2, $3, 'strict')", [id, userId, organizationId]);
  return id;
}

async function visibleIds(db: PGlite, userId: string): Promise<string[]> {
  return asRole(db, 'authenticated', userId, async () =>
    (await db.query<{ id: string }>('SELECT id FROM rag_answer_records ORDER BY id')).rows.map((row) => row.id),
  );
}

for (const mode of MODES) {
  describe(`rag_answer_records access (${mode})`, () => {
    let db: PGlite;
    let userA: string;
    let userB: string;
    let organizationId: string | null = null;
    let recordsA: string[];
    let recordsB: string[];

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      userA = await createUser(db);
      userB = await createUser(db);
      if (mode === 'multi-tenant') {
        organizationId = crypto.randomUUID();
        await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [organizationId, 'Shared org', `shared-${organizationId.slice(0, 8)}`, userA]);
        await db.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member') ON CONFLICT DO NOTHING",
          [organizationId, userA, userB],
        );
      }
      recordsA = [await insertRecord(db, userA, organizationId), await insertRecord(db, userA, null)].sort();
      recordsB = [await insertRecord(db, userB, organizationId)].sort();
    });

    after(async () => {
      await db.close();
    });

    test('an authenticated user reads only their own records, even inside a shared organization', async () => {
      assert.deepEqual(await visibleIds(db, userA), recordsA);
      assert.deepEqual(await visibleIds(db, userB), recordsB);
    });

    test("a session user cannot read another user's record by id", async () => {
      const rows = await asRole(db, 'authenticated', userB, () => db.query('SELECT id FROM rag_answer_records WHERE id = $1', [recordsA[0]]));
      assert.equal(rows.rows.length, 0);
    });

    test('an authenticated session without a user id reads nothing', async () => {
      const rows = await asRole(db, 'authenticated', null, () => db.query('SELECT id FROM rag_answer_records'));
      assert.equal(rows.rows.length, 0);
    });

    test('authenticated cannot insert, update or delete', async () => {
      await refused(() =>
        asRole(db, 'authenticated', userA, () =>
          db.query("INSERT INTO rag_answer_records (id, user_id, rag_mode) VALUES ($1, $2, 'strict')", [crypto.randomUUID(), userA]),
        ),
      );
      await refused(() =>
        asRole(db, 'authenticated', userA, () =>
          db.query("UPDATE rag_answer_records SET feedback = '{\"rating\":\"up\"}'::jsonb WHERE id = $1", [recordsA[0]]),
        ),
      );
      await refused(() => asRole(db, 'authenticated', userA, () => db.query('DELETE FROM rag_answer_records WHERE id = $1', [recordsA[0]])));
      const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_answer_records')).rows[0]?.n;
      assert.equal(count, recordsA.length + recordsB.length);
    });

    test('anon is refused with 42501 on every statement', async () => {
      await refused(() => asRole(db, 'anon', null, () => db.query('SELECT id FROM rag_answer_records')));
      await refused(() => asRole(db, 'anon', userA, () => db.query('SELECT id FROM rag_answer_records')));
      await refused(() =>
        asRole(db, 'anon', null, () =>
          db.query("INSERT INTO rag_answer_records (id, user_id, rag_mode) VALUES ($1, $2, 'strict')", [crypto.randomUUID(), userA]),
        ),
      );
    });

    test('only service_role holds write privileges; anon, authenticated and PUBLIC hold none', async () => {
      const row = (
        await db.query<Record<string, boolean>>(
          `SELECT has_table_privilege('anon', 'public.rag_answer_records', 'SELECT') AS anon_select,
                  has_table_privilege('anon', 'public.rag_answer_records', 'INSERT') AS anon_insert,
                  has_table_privilege('authenticated', 'public.rag_answer_records', 'SELECT') AS auth_select,
                  has_table_privilege('authenticated', 'public.rag_answer_records', 'INSERT') AS auth_insert,
                  has_table_privilege('authenticated', 'public.rag_answer_records', 'UPDATE') AS auth_update,
                  has_table_privilege('authenticated', 'public.rag_answer_records', 'DELETE') AS auth_delete,
                  has_table_privilege('service_role', 'public.rag_answer_records', 'INSERT') AS service_insert,
                  has_table_privilege('service_role', 'public.rag_answer_records', 'UPDATE') AS service_update,
                  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_answer_records'::regclass) AS rls,
                  (SELECT coalesce(bool_or(acl.grantee = 0), false) FROM pg_class c, aclexplode(c.relacl) acl
                    WHERE c.oid = 'public.rag_answer_records'::regclass) AS public_grant`,
        )
      ).rows[0];
      assert.deepEqual(row, {
        anon_select: false,
        anon_insert: false,
        auth_select: true,
        auth_insert: false,
        auth_update: false,
        auth_delete: false,
        service_insert: true,
        service_update: true,
        rls: true,
        public_grant: false,
      });
    });

    test('the table has one SELECT policy for authenticated and no write policy', async () => {
      const policies = (
        await db.query<{ cmd: string; roles: string; qual: string }>("SELECT cmd, roles::text AS roles, qual FROM pg_policies WHERE tablename = 'rag_answer_records'")
      ).rows;
      assert.equal(policies.length, 1);
      assert.equal(policies[0]?.cmd, 'SELECT');
      assert.equal(policies[0]?.roles, '{authenticated}');
      assert.match(policies[0]?.qual ?? '', /user_id = auth\.uid\(\)/);
    });

    test('service_role inserts, updates and reads every record', async () => {
      const id = crypto.randomUUID();
      await asRole(db, 'service_role', null, async () => {
        await db.query("INSERT INTO rag_answer_records (id, user_id, rag_mode) VALUES ($1, $2, 'balanced')", [id, userB]);
        await db.query("UPDATE rag_answer_records SET feedback = '{\"rating\":\"down\"}'::jsonb, review_reasons = '{feedback_negative}' WHERE id = $1", [id]);
      });
      const all = await asRole(db, 'service_role', null, () => db.query<{ id: string }>('SELECT id FROM rag_answer_records'));
      assert.ok(all.rows.some((row) => row.id === id));
      assert.ok(recordsA.every((recordId) => all.rows.some((row) => row.id === recordId)));
      await db.query('DELETE FROM rag_answer_records WHERE id = $1', [id]);
    });

    test('the fake edge with the anon key returns an error and no row', async () => {
      const edge = await startFakeEdge({ db });
      try {
        const response = await fetch(`${edge.url}/rest/v1/rag_answer_records?select=id`, {
          headers: { apikey: FIXTURE_ANON_KEY, authorization: `Bearer ${FIXTURE_ANON_KEY}` },
        });
        const body = await response.text();
        assert.ok(response.status >= 400, `status ${response.status}`);
        for (const id of [...recordsA, ...recordsB]) assert.ok(!body.includes(id));
      } finally {
        await edge.close();
      }
    });
  });
}
