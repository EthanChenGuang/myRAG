import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-0000000000b1';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000c1';
const VIEWER = '00000000-0000-4000-8000-0000000000c2';
const OUTSIDER = '00000000-0000-4000-8000-0000000000e1';
const NEWCOMER = '00000000-0000-4000-8000-0000000000f1';
const GHOST = '00000000-0000-4000-8000-0000000000f9';
const ORG = '00000000-0000-4000-8000-0000000000d1';

type Row = { id: string; organization_id: string; user_id: string; role: string; created_at: string };
type Write = { op: string; client: ClientKind; payload?: unknown };
type ClientKind = 'user' | 'service';

let rows: Row[];
let writes: Write[];
let identity: { id: string } | null;
let knownUsers: Set<string>;
let maxTeamMembers: number;
let insertError: { code?: string; message: string } | null;

// 'user' mimics the shipped RLS on organization_members: SELECT only for the organization owner (OWNER) and for
// the member's own row, INSERT and DELETE owner-only. 'service' bypasses RLS.
function makeClient(kind: ClientKind) {
  const isOwner = () => identity?.id === OWNER;
  const visible = () => rows.filter((r) => kind === 'service' || isOwner() || r.user_id === identity?.id);
  return {
    auth: {
      getUser: async () => ({ data: { user: identity } }),
      admin: {
        getUserById: async (id: string) =>
          knownUsers.has(id)
            ? { data: { user: { id, email: `${id.slice(-2)}@example.invalid`, user_metadata: { full_name: `Name ${id.slice(-2)}` } } }, error: null }
            : { data: { user: null }, error: { message: 'User not found' } },
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = 'select';
      let head = false;
      let payload: Record<string, unknown> | undefined;
      const run = (single: boolean) => {
        if (table === 'organizations') return { data: { max_team_members: maxTeamMembers }, error: null };
        if (table !== 'organization_members') return { data: null, error: null };
        if (op === 'insert') {
          if (kind === 'user' && !isOwner()) return { data: null, error: { message: 'new row violates row-level security policy' } };
          writes.push({ op, client: kind, payload });
          if (insertError) return { data: null, error: insertError };
          const row = { id: `row-${rows.length + 1}`, created_at: '2026-01-01T00:00:00Z', ...(payload as object) } as Row;
          rows.push(row);
          return { data: row, error: null };
        }
        const matched = visible().filter((r) => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v));
        if (head) return { count: matched.length, error: null };
        if (single) {
          return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: 'no rows' } };
        }
        return { data: matched, error: null };
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
        insert: (value: Record<string, unknown>) => {
          op = 'insert';
          payload = value;
          return builder;
        },
        single: () => Promise.resolve(run(true)),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(run(false)).then(resolve, reject),
      };
      return builder;
    },
  };
}

type Handler = (request: Request, context: never) => Promise<Response>;
interface MembersRoute {
  GET: Handler;
  POST: Handler;
}

async function load(): Promise<MembersRoute> {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({ requireMultiTenant: () => undefined }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ isPersonalOrganization: async () => false }));
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeClient('user') }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => makeClient('service') }));
  return (await import('@/app/api/organizations/[id]/members/route')) as MembersRoute;
}

const params = { params: Promise.resolve({ id: ORG }) };
const post = (body: unknown) =>
  new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = () => new Request('http://localhost/api/test');

beforeEach(() => {
  const row = (user_id: string, role: string): Row => ({
    id: `m-${user_id.slice(-2)}`,
    organization_id: ORG,
    user_id,
    role,
    created_at: '2026-01-01T00:00:00Z',
  });
  rows = [row(OWNER, 'owner'), row(ADMIN, 'admin'), row(MEMBER, 'member'), row(VIEWER, 'viewer')];
  writes = [];
  identity = null;
  knownUsers = new Set([OWNER, ADMIN, MEMBER, VIEWER, OUTSIDER, NEWCOMER]);
  maxTeamMembers = 50;
  insertError = null;
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
});

describe('GET /api/organizations/[id]/members', () => {
  it('answers 401 without a verified user', async () => {
    const { GET } = await load();
    expect((await GET(get(), params as never)).status).toBe(401);
  });

  it('shows a non-owner member the full member list', async () => {
    const { GET } = await load();
    identity = { id: MEMBER };
    const response = await GET(get(), params as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<Record<string, unknown>>;
    expect(body.map((m) => m.user_id).sort()).toEqual([OWNER, ADMIN, MEMBER, VIEWER].sort());
    expect(Object.keys(body[0]).sort()).toEqual(['created_at', 'email', 'id', 'name', 'role', 'user_id']);
    expect(body.find((m) => m.user_id === ADMIN)).toMatchObject({ role: 'admin', email: 'a1@example.invalid', name: 'Name a1' });
  });

  it('shows the owner the full member list', async () => {
    const { GET } = await load();
    identity = { id: OWNER };
    const body = (await (await GET(get(), params as never)).json()) as unknown[];
    expect(body).toHaveLength(4);
  });

  it('answers 404 for a user who is not a member and leaks no members', async () => {
    const { GET } = await load();
    identity = { id: OUTSIDER };
    const response = await GET(get(), params as never);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('example.invalid');
  });
});

describe('POST /api/organizations/[id]/members', () => {
  it('answers 401 without a verified user', async () => {
    const { POST } = await load();
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(401);
    expect(writes).toEqual([]);
  });

  it('lets an admin add a member through the service role', async () => {
    const { POST } = await load();
    identity = { id: ADMIN };
    const response = await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never);
    expect(response.status).toBe(201);
    expect(writes).toEqual([
      { op: 'insert', client: 'service', payload: { organization_id: ORG, user_id: NEWCOMER, role: 'member' } },
    ]);
    expect(rows.some((r) => r.user_id === NEWCOMER && r.role === 'member')).toBe(true);
  });

  it('lets an admin add another admin', async () => {
    const { POST } = await load();
    identity = { id: ADMIN };
    expect((await POST(post({ user_id: NEWCOMER, role: 'admin' }), params as never)).status).toBe(201);
  });

  it('lets an owner add an owner, but never an admin', async () => {
    const { POST } = await load();
    identity = { id: OWNER };
    expect((await POST(post({ user_id: NEWCOMER, role: 'owner' }), params as never)).status).toBe(201);
    writes = [];
    identity = { id: ADMIN };
    expect((await POST(post({ user_id: OUTSIDER, role: 'owner' }), params as never)).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('refuses an admin granting owner', async () => {
    const { POST } = await load();
    identity = { id: ADMIN };
    expect((await POST(post({ user_id: NEWCOMER, role: 'owner' }), params as never)).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('refuses a plain member and a viewer', async () => {
    const { POST } = await load();
    identity = { id: MEMBER };
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(403);
    identity = { id: VIEWER };
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(403);
    identity = { id: OUTSIDER };
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('answers 409 for a user who is already a member', async () => {
    const { POST } = await load();
    identity = { id: ADMIN };
    expect((await POST(post({ user_id: MEMBER, role: 'member' }), params as never)).status).toBe(409);
    expect(writes).toEqual([]);
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(201);
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(409);
  });

  it('answers 409 when the insert loses a unique-constraint race', async () => {
    const { POST } = await load();
    identity = { id: ADMIN };
    insertError = { code: '23505', message: 'duplicate key' };
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(409);
  });

  it('rejects a target user id that is not a real user', async () => {
    const { POST } = await load();
    identity = { id: ADMIN };
    expect((await POST(post({ user_id: GHOST, role: 'member' }), params as never)).status).toBe(404);
    expect((await POST(post({ user_id: 'not-a-uuid', role: 'member' }), params as never)).status).toBe(400);
    expect((await POST(post({ role: 'member' }), params as never)).status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('counts the whole team against the member limit, not only the rows the caller can see', async () => {
    const { POST } = await load();
    identity = { id: ADMIN };
    maxTeamMembers = 4;
    expect((await POST(post({ user_id: NEWCOMER, role: 'member' }), params as never)).status).toBe(403);
    expect(writes).toEqual([]);
  });
});
