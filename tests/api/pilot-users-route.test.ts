import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { pgliteClient } from '../helpers/pglite-rest-client';

const ADMIN = '00000000-0000-4000-8000-0000000032ad';
const ORG_A = '00000000-0000-4000-8000-0000000032a0';
const ORG_B = '00000000-0000-4000-8000-0000000032b0';
const MEMBER_A = '00000000-0000-4000-8000-0000000032a1';
const MEMBER_A2 = '00000000-0000-4000-8000-0000000032a2';
const MEMBER_B = '00000000-0000-4000-8000-0000000032b1';
const EMAIL_A = 'member.alpha@example.invalid';
const EMAIL_A2 = 'second.alpha@example.invalid';
const EMAIL_B = 'member.bravo@example.invalid';

type Guard =
  | { ok: true; userId: string; via: 'deployment_admin' | 'organization_admin'; tenantKey: string; organizationId: string | null }
  | { ok: false; status: number; reason: string };

const state: { mode: DeploymentMode; guard: Guard; calls: string[]; logs: string[] } = {
  mode: 'multi-tenant',
  guard: { ok: false, status: 401, reason: 'no_session' },
  calls: [],
  logs: [],
};
const dbs: Partial<Record<DeploymentMode, PGlite>> = {};

async function seed(db: PGlite, mode: DeploymentMode): Promise<void> {
  for (const [id, email] of [
    [ADMIN, 'operator@example.invalid'],
    [MEMBER_A, EMAIL_A],
    [MEMBER_A2, EMAIL_A2],
    [MEMBER_B, EMAIL_B],
  ]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, email]);
  }
  if (mode !== 'multi-tenant') return;
  for (const [org, slug] of [
    [ORG_A, 'pilot-alpha'],
    [ORG_B, 'pilot-bravo'],
  ]) {
    await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $2, $3)', [org, slug, ADMIN]);
  }
  for (const [org, user] of [
    [ORG_A, MEMBER_A],
    [ORG_A, MEMBER_A2],
    [ORG_B, MEMBER_B],
  ]) {
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, user]);
  }
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin-route-auth')>()),
    checkAdminOrOrgAdmin: async () => state.guard,
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => pgliteClient(dbs[state.mode] as PGlite, { role: 'service_role', label: 'admin', calls: state.calls }),
    getSupabase: () => ({}),
  }));
  return import('@/app/api/rag/admin/pilot-users/route');
}

const BASE = 'http://localhost/api/rag/admin/pilot-users';

function req(query: string, method = 'GET', body?: unknown): Request {
  return new Request(`${BASE}${query}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function orgAdmin(org: string): Guard {
  return { ok: true, userId: ADMIN, via: 'organization_admin', tenantKey: `o:${org}`, organizationId: org };
}

async function pilots(tenantKey: string): Promise<string[]> {
  const db = dbs[state.mode] as PGlite;
  const rows = await db.query<{ user_id: string }>('SELECT user_id::text FROM rag_pilot_users WHERE tenant_key = $1 ORDER BY user_id', [tenantKey]);
  return rows.rows.map((row) => row.user_id);
}

beforeAll(async () => {
  for (const mode of ['multi-tenant', 'single-tenant'] as const) {
    const { db } = await createEmptyFixtureDatabase({ deploymentMode: mode });
    await seed(db, mode);
    dbs[mode] = db;
  }
}, 240_000);

afterAll(async () => {
  for (const db of Object.values(dbs)) await db?.close();
});

beforeEach(async () => {
  state.mode = 'multi-tenant';
  state.guard = { ok: false, status: 401, reason: 'no_session' };
  state.calls.length = 0;
  state.logs.length = 0;
  for (const db of Object.values(dbs)) await db?.query('DELETE FROM rag_pilot_users');
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      state.logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maskEmail', () => {
  it('keeps the first character of the local part and of the domain and the top-level domain only', async () => {
    const { maskEmail } = await import('@/lib/rag/monitor/pilot-users');
    expect(maskEmail('member.alpha@example.com')).toBe('m•••@e••••••.com');
    expect(maskEmail('A@mail.example.co.uk')).toBe('A•••@m••••••.uk');
    expect(maskEmail('Member.Alpha@Example.COM')).toBe('M•••@E••••••.com');
    expect(maskEmail('not-an-address')).toBeNull();
    expect(maskEmail('a@localhost')).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });
});

describe('pilot users route (multi-tenant)', () => {
  it('adds a member of the workspace by e-mail (201), refuses a repeat (409) and lists the user masked', async () => {
    const route = await load();
    state.guard = orgAdmin(ORG_A);
    const created = await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user: EMAIL_A.toUpperCase() }));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ success: true, user: { user_id: MEMBER_A, masked_email: 'm•••@e••••••.invalid' } });
    expect(JSON.stringify(createdBody)).not.toContain(EMAIL_A);
    expect(await pilots(`o:${ORG_A}`)).toEqual([MEMBER_A]);

    const again = await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user: MEMBER_A }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ success: false, error: 'already_pilot' });

    const listed = await route.GET(req(`?organizationId=${ORG_A}`));
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.users).toEqual([{ user_id: MEMBER_A, masked_email: 'm•••@e••••••.invalid', added_at: expect.any(String) }]);
    expect(body.weight).toBe(5);
    expect(body.cap_share).toBe(0.4);
    expect(body.next_cursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain('member.alpha');
    expect(state.logs.join('\n')).not.toMatch(/member\.alpha|example\.invalid/);
  });

  it('answers the same 404 user_not_found for an unknown user and for a member of another workspace', async () => {
    const route = await load();
    state.guard = orgAdmin(ORG_A);
    for (const user of [EMAIL_B, MEMBER_B, 'nobody@example.invalid', crypto.randomUUID()]) {
      const res = await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, error: 'user_not_found' });
    }
    expect(await pilots(`o:${ORG_A}`)).toEqual([]);
    expect(await pilots(`o:${ORG_B}`)).toEqual([]);
  });

  it('ignores a tenant key sent by the browser: the workspace comes from the guard only', async () => {
    const route = await load();
    state.guard = orgAdmin(ORG_A);
    const res = await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user: EMAIL_A, tenantKey: `o:${ORG_B}` }));
    expect(res.status).toBe(400);
    expect(await pilots(`o:${ORG_B}`)).toEqual([]);
  });

  it('lists newest first, at most 50 per page, with a cursor', async () => {
    const db = dbs['multi-tenant'] as PGlite;
    const extra: string[] = [];
    for (let i = 0; i < 52; i += 1) {
      const id = crypto.randomUUID();
      extra.push(id);
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `paged-${i}@example.invalid`]);
      await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG_A, id]);
      await db.query("INSERT INTO rag_pilot_users (tenant_key, user_id, added_at) VALUES ($1, $2, '2026-11-01T00:00:00Z'::timestamptz + make_interval(mins => $3))", [
        `o:${ORG_A}`,
        id,
        i,
      ]);
    }
    const route = await load();
    state.guard = orgAdmin(ORG_A);
    const first = await (await route.GET(req(`?organizationId=${ORG_A}`))).json();
    expect(first.users).toHaveLength(50);
    expect(first.users[0].user_id).toBe(extra[51]);
    expect(typeof first.next_cursor).toBe('string');
    const second = await (await route.GET(req(`?organizationId=${ORG_A}&cursor=${encodeURIComponent(first.next_cursor)}`))).json();
    expect(second.users.map((u: { user_id: string }) => u.user_id)).toEqual([extra[1], extra[0]]);
    expect(second.next_cursor).toBeNull();
    const bad = await route.GET(req(`?organizationId=${ORG_A}&cursor=not-a-cursor`));
    expect(bad.status).toBe(400);
  });

  it('removes a pilot user (200), then answers 404 for the same user', async () => {
    const route = await load();
    state.guard = orgAdmin(ORG_A);
    expect((await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user: MEMBER_A2 }))).status).toBe(201);
    const removed = await route.DELETE(req(`?organizationId=${ORG_A}&user_id=${MEMBER_A2}`, 'DELETE'));
    expect(removed.status).toBe(200);
    expect(await pilots(`o:${ORG_A}`)).toEqual([]);
    const again = await route.DELETE(req(`?organizationId=${ORG_A}&user_id=${MEMBER_A2}`, 'DELETE'));
    expect(again.status).toBe(404);
    const invalid = await route.DELETE(req(`?organizationId=${ORG_A}&user_id=nope`, 'DELETE'));
    expect(invalid.status).toBe(400);
  });

  it("an admin of workspace A cannot remove or list workspace B's pilot users", async () => {
    const db = dbs['multi-tenant'] as PGlite;
    await db.query('INSERT INTO rag_pilot_users (tenant_key, user_id) VALUES ($1, $2)', [`o:${ORG_B}`, MEMBER_B]);
    const route = await load();
    state.guard = orgAdmin(ORG_A);
    expect((await route.DELETE(req(`?organizationId=${ORG_A}&user_id=${MEMBER_B}`, 'DELETE'))).status).toBe(404);
    expect((await (await route.GET(req(`?organizationId=${ORG_A}`))).json()).users).toEqual([]);
    expect(await pilots(`o:${ORG_B}`)).toEqual([MEMBER_B]);
  });

  it('passes the guard denial through: 401 without a session, 403 for a foreign workspace, and touches no table', async () => {
    const route = await load();
    state.guard = { ok: false, status: 401, reason: 'no_session' };
    expect((await route.GET(req(`?organizationId=${ORG_A}`))).status).toBe(401);
    expect((await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user: EMAIL_A }))).status).toBe(401);
    state.guard = { ok: false, status: 403, reason: 'not_admin' };
    expect((await route.POST(req(`?organizationId=${ORG_B}`, 'POST', { user: EMAIL_B }))).status).toBe(403);
    expect((await route.DELETE(req(`?organizationId=${ORG_B}&user_id=${MEMBER_B}`, 'DELETE'))).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it('validates the body', async () => {
    const route = await load();
    state.guard = orgAdmin(ORG_A);
    expect((await route.POST(req(`?organizationId=${ORG_A}`, 'POST', {}))).status).toBe(400);
    expect((await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user: '' }))).status).toBe(400);
    expect((await route.POST(req(`?organizationId=${ORG_A}`, 'POST', { user: 'x'.repeat(400) }))).status).toBe(400);
  });
});

describe('pilot users route (single-tenant)', () => {
  it('adds any existing user of the deployment under s:default', async () => {
    state.mode = 'single-tenant';
    const route = await load();
    state.mode = 'single-tenant';
    state.guard = { ok: true, userId: ADMIN, via: 'deployment_admin', tenantKey: 's:default', organizationId: null };
    expect((await route.POST(req('', 'POST', { user: EMAIL_B }))).status).toBe(201);
    expect((await route.POST(req('', 'POST', { user: 'nobody@example.invalid' }))).status).toBe(404);
    expect(await pilots('s:default')).toEqual([MEMBER_B]);
  });
});
