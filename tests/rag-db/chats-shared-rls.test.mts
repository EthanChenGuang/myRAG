import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// NF-1: the chats SELECT policies must not expose shared = true rows to anon or other users through PostgREST.
// Shared links are served by the service-role page and route, which match one share_id.

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

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

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createOrganization(db: PGlite, ownerId: string, memberIds: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Fixture org', `org-${id.slice(0, 8)}`, ownerId]);
  for (const userId of [ownerId, ...memberIds]) {
    await db.query(
      'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [id, userId, userId === ownerId ? 'owner' : 'member'],
    );
  }
  return id;
}

interface ChatRow {
  id: string;
  shareId: string | null;
}

async function insertChat(db: PGlite, userId: string, organizationId: string | null, shared: boolean): Promise<ChatRow> {
  const id = crypto.randomUUID();
  const shareId = shared ? crypto.randomUUID() : null;
  await db.query(
    `INSERT INTO chats (id, user_id, organization_id, title, messages, shared, share_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [id, userId, organizationId, 'Fixture chat', JSON.stringify([{ role: 'user', content: 'Synthetic question text.' }]), shared, shareId],
  );
  return { id, shareId };
}

async function visibleIds(db: PGlite, role: Role, userId: string | null, where = 'true'): Promise<string[]> {
  return asRole(db, role, userId, async () =>
    (await db.query<{ id: string }>(`SELECT id FROM chats WHERE ${where} ORDER BY id`)).rows.map((row) => row.id),
  );
}

const sorted = (ids: string[]): string[] => [...ids].sort();

for (const mode of MODES) {
  describe(`chats shared RLS (${mode})`, () => {
    let db: PGlite;
    let userA: string;
    let userB: string;
    let userC: string;
    let ownA: string[];
    let ownB: string[];
    let sharedA: ChatRow;
    let sharedC: ChatRow;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      userA = await createUser(db);
      userB = await createUser(db);
      userC = await createUser(db);
      let orgAB: string | null = null;
      let orgC: string | null = null;
      if (mode === 'multi-tenant') {
        orgAB = await createOrganization(db, userA, [userB]);
        orgC = await createOrganization(db, userC, []);
      }
      sharedA = await insertChat(db, userA, null, true);
      const privateA = await insertChat(db, userA, null, false);
      const orgSharedA = await insertChat(db, userA, orgAB, true);
      ownA = sorted([sharedA.id, privateA.id, orgSharedA.id]);
      const privateB = await insertChat(db, userB, null, false);
      ownB = [privateB.id];
      sharedC = await insertChat(db, userC, orgC, true);
    });

    after(async () => {
      await db.close();
    });

    test('anon reads no chat, even with shared = true', async () => {
      assert.deepEqual(await visibleIds(db, 'anon', null, 'shared = true'), []);
      assert.deepEqual(await visibleIds(db, 'anon', null), []);
    });

    test('anon reads no chat by share_id either (shared links go through the service-role route)', async () => {
      assert.deepEqual(await visibleIds(db, 'anon', null, `share_id = '${sharedA.shareId}'`), []);
    });

    test("an authenticated user reads no other user's or tenant's shared chat", async () => {
      assert.deepEqual(await visibleIds(db, 'authenticated', userB, 'shared = true'), []);
      assert.deepEqual(await visibleIds(db, 'authenticated', userB), ownB);
      assert.deepEqual(await visibleIds(db, 'authenticated', userA, `share_id = '${sharedC.shareId}'`), []);
      assert.deepEqual(await visibleIds(db, 'authenticated', userC, 'shared = true'), [sharedC.id]);
    });

    test('a user still reads their own chats, shared or not', async () => {
      assert.deepEqual(await visibleIds(db, 'authenticated', userA), ownA);
    });

    test('the service role still reads one shared chat by share_id', async () => {
      const rows = await asRole(db, 'service_role', null, async () =>
        (await db.query<{ id: string }>('SELECT id FROM chats WHERE share_id = $1 AND shared = true', [sharedA.shareId])).rows,
      );
      assert.deepEqual(rows.map((row) => row.id), [sharedA.id]);
    });

    test('no chats policy mentions shared', async () => {
      const policies = await db.query<{ name: string; qual: string | null }>(
        "SELECT policyname AS name, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chats'",
      );
      assert.ok(policies.rows.length > 0, 'chats keeps its policies');
      assert.deepEqual(policies.rows.filter((row) => /shared/.test(row.qual ?? '')).map((row) => row.name), []);
    });
  });
}
