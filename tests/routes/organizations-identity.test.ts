import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const SECOND_OWNER = '00000000-0000-4000-8000-0000000000b2';
const MEMBER = '00000000-0000-4000-8000-0000000000c1';
const ORG = '00000000-0000-4000-8000-0000000000d1';

type Write = { op: string; table: string; payload?: unknown; filters: Record<string, unknown> };

let roles: Record<string, string>;
let writes: Write[];
let identity: { id: string; email?: string } | null;
let sessionCalls: number;

type ClientKind = 'user' | 'service';

// 'user' mimics the shipped RLS: organization_members rows are visible only to the organization owner
// (organizations.owner_id = OWNER) and to the member themselves, and there is no UPDATE policy at all.
// 'service' sees and writes everything.
function makeClient(kind: ClientKind = 'user') {
  const sees = (userId: unknown) => kind === 'service' || userId === identity?.id || identity?.id === OWNER;
  return {
    auth: {
      getUser: async () => ({ data: { user: identity } }),
      getSession: async () => {
        sessionCalls += 1;
        return { data: { session: identity ? { user: identity } : null } };
      },
      admin: { listUsers: async () => ({ data: { users: [] } }) },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = 'select';
      let head = false;
      let payload: unknown;
      const result = () => {
        if (op === 'update' && table === 'organization_members' && kind === 'user') {
          return { data: null, error: { message: 'no rows updated: no UPDATE policy' } };
        }
        if (op !== 'select') {
          writes.push({ op, table, payload, filters: { ...filters } });
          return { data: { ...(payload as object) }, error: null };
        }
        if (table === 'organization_members') {
          if (head) {
            const visible = Object.entries(roles).filter(([userId]) => sees(userId));
            const owners = visible.filter(([, role]) => role === 'owner').length;
            return { count: filters.role ? owners : visible.length, error: null };
          }
          const role = sees(filters.user_id) ? roles[filters.user_id as string] : undefined;
          return { data: role ? { role } : null, error: role ? null : { message: 'none' } };
        }
        if (table === 'organizations') return { data: { max_team_members: 50 }, error: null };
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: (_columns?: string, options?: { head?: boolean }) => {
          if (op === 'select') head = Boolean(options?.head);
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        update: (value: unknown) => {
          op = 'update';
          payload = value;
          return builder;
        },
        insert: (value: unknown) => {
          op = 'insert';
          payload = value;
          return builder;
        },
        delete: () => {
          op = 'delete';
          return builder;
        },
        single: () => Promise.resolve(result()),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

async function load<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({ requireMultiTenant: () => undefined }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ isPersonalOrganization: async () => false }));
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeClient('user') }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => makeClient('service') }));
  vi.doMock('next/headers', () => ({ cookies: () => undefined }));
  vi.doMock('@supabase/auth-helpers-nextjs', () => ({ createRouteHandlerClient: () => makeClient('user') }));
  return (await import(modulePath)) as T;
}

function json(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/test', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const orgParams = { params: Promise.resolve({ id: ORG }) };
const memberParams = (userId: string) => ({ params: Promise.resolve({ id: ORG, userId }) });

type Handler = (request: Request, context: never) => Promise<Response>;
interface MemberRoute {
  PATCH: Handler;
  DELETE: Handler;
}
interface MembersRoute {
  GET: Handler;
  POST: Handler;
}

beforeEach(() => {
  roles = { [OWNER]: 'owner', [ADMIN]: 'admin', [MEMBER]: 'member' };
  writes = [];
  identity = null;
  sessionCalls = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/deployment-mode');
  vi.doUnmock('@/lib/auth/organization-handler');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('next/headers');
  vi.doUnmock('@supabase/auth-helpers-nextjs');
});

describe('identity comes from getUser, never getSession', () => {
  const CASES: Array<{ name: string; path: string; method: string; context: unknown; body?: unknown }> = [
    { name: 'members GET', path: '@/app/api/organizations/[id]/members/route', method: 'GET', context: orgParams },
    { name: 'members POST', path: '@/app/api/organizations/[id]/members/route', method: 'POST', context: orgParams, body: { user_id: MEMBER, role: 'member' } },
    { name: 'member PATCH', path: '@/app/api/organizations/[id]/members/[userId]/route', method: 'PATCH', context: memberParams(MEMBER), body: { role: 'viewer' } },
    { name: 'member DELETE', path: '@/app/api/organizations/[id]/members/[userId]/route', method: 'DELETE', context: memberParams(MEMBER) },
    { name: 'invites GET', path: '@/app/api/organizations/[id]/invites/route', method: 'GET', context: orgParams },
    { name: 'invites POST', path: '@/app/api/organizations/[id]/invites/route', method: 'POST', context: orgParams, body: { email: 'invitee@example.invalid' } },
    { name: 'invites DELETE', path: '@/app/api/organizations/[id]/invites/route', method: 'DELETE', context: orgParams },
    { name: 'share POST', path: '@/app/api/organizations/[id]/share/route', method: 'POST', context: orgParams },
    { name: 'invite accept POST', path: '@/app/api/invites/[token]/route', method: 'POST', context: { params: Promise.resolve({ token: 'tok' }) } },
  ];

  it.each(CASES)('$name answers 401 when getUser finds no verified user', async ({ path, method, context, body }) => {
    const route = (await load<Record<string, Handler>>(path))[method];
    identity = null;
    const response = await route(json(method, body), context as never);
    expect(response.status).toBe(401);
    expect(writes).toEqual([]);
  });

  it.each(CASES)('$name does not consult getSession', async ({ path, method, context, body }) => {
    const route = (await load<Record<string, Handler>>(path))[method];
    identity = { id: ADMIN, email: 'admin@example.invalid' };
    await route(json(method, body), context as never);
    expect(sessionCalls).toBe(0);
  });
});

describe('owner role changes', () => {
  it('an admin cannot grant owner through PATCH', async () => {
    const { PATCH } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: ADMIN };
    const response = await PATCH(json('PATCH', { role: 'owner' }), memberParams(MEMBER) as never);
    expect(response.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an admin cannot promote themselves to owner', async () => {
    const { PATCH } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: ADMIN };
    const response = await PATCH(json('PATCH', { role: 'owner' }), memberParams(ADMIN) as never);
    expect(response.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an admin cannot change an existing owner', async () => {
    roles[SECOND_OWNER] = 'owner';
    const { PATCH } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: ADMIN };
    const response = await PATCH(json('PATCH', { role: 'member' }), memberParams(SECOND_OWNER) as never);
    expect(response.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an owner can grant owner', async () => {
    const { PATCH } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: OWNER };
    const response = await PATCH(json('PATCH', { role: 'owner' }), memberParams(MEMBER) as never);
    expect(response.status).toBe(200);
    expect(writes).toEqual([
      expect.objectContaining({ op: 'update', payload: { role: 'owner' }, filters: { organization_id: ORG, user_id: MEMBER } }),
    ]);
  });

  it('answers 404 for a user who is not a member, and refuses to demote the last owner', async () => {
    const { PATCH } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: OWNER };
    expect((await PATCH(json('PATCH', { role: 'viewer' }), memberParams(SECOND_OWNER) as never)).status).toBe(404);
    expect((await PATCH(json('PATCH', { role: 'admin' }), memberParams(OWNER) as never)).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an admin can still set non-owner roles', async () => {
    const { PATCH } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: ADMIN };
    const response = await PATCH(json('PATCH', { role: 'viewer' }), memberParams(MEMBER) as never);
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
  });

  it('an admin cannot add a member as owner', async () => {
    const { POST } = await load<MembersRoute>('@/app/api/organizations/[id]/members/route');
    identity = { id: ADMIN };
    const response = await POST(json('POST', { user_id: SECOND_OWNER, role: 'owner' }), orgParams as never);
    expect(response.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an owner can add a member as owner', async () => {
    const { POST } = await load<MembersRoute>('@/app/api/organizations/[id]/members/route');
    identity = { id: OWNER };
    const response = await POST(json('POST', { user_id: SECOND_OWNER, role: 'owner' }), orgParams as never);
    expect(response.status).toBe(201);
    expect(writes).toHaveLength(1);
  });

  it('an admin cannot remove an owner', async () => {
    roles[SECOND_OWNER] = 'owner';
    const { DELETE } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: ADMIN };
    const response = await DELETE(json('DELETE'), memberParams(SECOND_OWNER) as never);
    expect(response.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an owner can remove another owner and an admin can remove a member', async () => {
    roles[SECOND_OWNER] = 'owner';
    const { DELETE } = await load<MemberRoute>('@/app/api/organizations/[id]/members/[userId]/route');
    identity = { id: OWNER };
    expect((await DELETE(json('DELETE'), memberParams(SECOND_OWNER) as never)).status).toBe(200);
    identity = { id: ADMIN };
    expect((await DELETE(json('DELETE'), memberParams(MEMBER) as never)).status).toBe(200);
    expect(writes).toHaveLength(2);
  });
});
