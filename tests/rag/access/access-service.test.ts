import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../../helpers/pglite-admin';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope } from '@/lib/rag/tenant/scope';
import { AccessGroupsError, accessReasonOf, addMember, createGroup, listGroups, myGroups, renameGroup } from '@/lib/rag';

// Phase 4.3 plan 21 (SEC-12, DATA-22): the typed access services over the 0922, 0924 and 0925 functions, on a single-tenant PGlite fixture.
// Fixtures are neutral synthetic sentences and placeholder addresses.

const CORPUS_DIR = path.resolve(import.meta.dirname, '../../../eval/fixtures/corpus');
const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const ADMIN = id('9211', 1);
const MEMBER_A = id('9211', 2);
const MEMBER_B = id('9211', 3);

type Admin = ReturnType<typeof createPgliteAdmin>;

/** The PGlite admin answers rpc() with a promise; the services also call abortSignal() on the request. */
function rpcClient(admin: Admin): RpcClient {
  return {
    rpc(fn, args) {
      const request = Promise.resolve(admin.rpc(fn, args)) as Promise<RpcResponse> & { abortSignal: (signal: AbortSignal) => typeof request };
      request.abortSignal = () => request;
      return request;
    },
  };
}

function fakeClient(response: RpcResponse, calls: Array<{ fn: string; args: Record<string, unknown> }> = []): RpcClient {
  return {
    rpc(fn, args) {
      calls.push({ fn, args });
      const request = Promise.resolve(response) as Promise<RpcResponse> & { abortSignal: (signal: AbortSignal) => typeof request };
      request.abortSignal = () => request;
      return request;
    },
  };
}

async function reason(run: () => Promise<unknown>): Promise<AccessGroupsError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessGroupsError);
    return error as AccessGroupsError;
  }
  throw new Error('expected an AccessGroupsError');
}

describe('access services (single-tenant PGlite)', () => {
  let db: PGlite;
  let deps: { db: () => RpcClient; signal: AbortSignal };
  const scope = mintScope('single', null, null);
  let groupA = '';

  beforeAll(async () => {
    ({ db } = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true }));
    await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz');
    for (const [user, email] of [
      [ADMIN, 'admin-person@example.invalid'],
      [MEMBER_A, 'member-alpha@example.invalid'],
      [MEMBER_B, 'member-beta@example.invalid'],
    ]) {
      await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING', [user, email]);
    }
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
    const client = rpcClient(createPgliteAdmin(db));
    deps = { db: () => client, signal: new AbortController().signal };
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('groups and members (Task 1)', () => {
    it('creates a group, adds a member and reads it back as that member\'s own and assignable group', async () => {
      const created = await createGroup(scope, { key: 'group-a', name: '  Group alpha ', actorId: ADMIN }, deps);
      expect(created).toMatchObject({ key: 'group-a', name: 'Group alpha', source: 'manual' });
      groupA = created.id;

      const member = await addMember(scope, { groupId: groupA, userId: MEMBER_A, actorId: ADMIN }, deps);
      expect(member).toMatchObject({ groupId: groupA, userId: MEMBER_A });

      const mine = await myGroups(scope, { userId: MEMBER_A }, deps);
      expect(mine.isAdmin).toBe(false);
      expect(mine.ownGroups).toEqual([{ id: groupA, name: 'Group alpha' }]);
      expect(mine.assignableGroups).toEqual([{ id: groupA, name: 'Group alpha' }]);

      const admin = await myGroups(scope, { userId: ADMIN }, deps);
      expect(admin.isAdmin).toBe(true);
      expect(admin.assignableGroups.map((group) => group.id)).toContain(groupA);
    });

    it('maps a taken key to group_exists and a second member add to member_exists', async () => {
      expect((await reason(() => createGroup(scope, { key: 'group-a', name: 'Again', actorId: ADMIN }, deps))).reason).toBe('group_exists');
      expect((await reason(() => addMember(scope, { groupId: groupA, userId: MEMBER_A, actorId: ADMIN }, deps))).reason).toBe('member_exists');
    });

    it('lists groups with counts and renames one', async () => {
      const page = await listGroups(scope, {}, deps);
      expect(page.groups).toEqual([expect.objectContaining({ id: groupA, key: 'group-a', memberCount: 1, documentCount: 0 })]);
      expect(page.nextCursor).toBeNull();
      const renamed = await renameGroup(scope, { groupId: groupA, name: 'Group alpha one', actorId: ADMIN }, deps);
      expect(renamed.name).toBe('Group alpha one');
    });

    it('refuses an invalid or reserved key before any database call', async () => {
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const fake = { db: () => fakeClient({ data: [], error: null }, calls), signal: new AbortController().signal };
      expect((await reason(() => createGroup(scope, { key: 'Bad Key', name: 'x', actorId: ADMIN }, fake))).reason).toBe('invalid_key');
      expect((await reason(() => createGroup(scope, { key: '-lead', name: 'x', actorId: ADMIN }, fake))).reason).toBe('invalid_key');
      expect((await reason(() => createGroup(scope, { key: 'all', name: 'x', actorId: ADMIN }, fake))).reason).toBe('reserved_key');
      expect((await reason(() => createGroup(scope, { key: 'group-z', name: 'x', actorId: 'not-a-uuid' }, fake))).reason).toBe('actor_required');
      expect(calls).toEqual([]);
    });

    it('never carries the database message: an unknown message gives reason null', async () => {
      const secret = 'duplicate key value violates "rag_access_groups_key" detail: key=(group-secret-input)';
      const fake = { db: () => fakeClient({ data: null, error: { code: 'XX000', message: secret } }), signal: new AbortController().signal };
      const error = await reason(() => createGroup(scope, { key: 'group-q', name: 'Group q', actorId: ADMIN }, fake));
      expect(error.reason).toBeNull();
      expect(error.code).toBe('XX000');
      expect(error.message).not.toContain('group-secret-input');
      expect(error.message).not.toContain('duplicate');
    });

    it('takes only the leading word of a known reason, and folds not-found words', () => {
      expect(accessReasonOf('group_exists')).toBe('group_exists');
      expect(accessReasonOf('count_required: 3')).toBe('count_required');
      expect(accessReasonOf('mapping_not_found')).toBe('not_found');
      expect(accessReasonOf('some other failure')).toBeNull();
      expect(accessReasonOf(undefined)).toBeNull();
    });

    it('takes the tenant from the scope only', async () => {
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const fake = { db: () => fakeClient({ data: [], error: null }, calls), signal: new AbortController().signal };
      const org = mintScope('org', MEMBER_A, id('9212', 1));
      await listGroups(org, { cursor: null }, fake);
      expect(calls[0]?.args.p_tenant_key).toBe(`o:${id('9212', 1)}`);
    });
  });
});
