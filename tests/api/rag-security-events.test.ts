import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import {
  LinkPreviewStatusSchema,
  SecurityAlertViewSchema,
  SecurityEventViewSchema,
  SecurityUploaderViewSchema,
} from '@/lib/rag-eval/contracts.generated';
import { securityRoutes, seedSecurityTenants, type SecurityFixture } from '../helpers/security-events-fixture';

const VIEW_KEYS = {
  event: Object.keys(SecurityEventViewSchema.shape),
  alert: Object.keys(SecurityAlertViewSchema.shape),
  uploader: Object.keys(SecurityUploaderViewSchema.shape),
};

let db: PGlite;
let fx: SecurityFixture;
const session: { userId: string | null } = { userId: null };
const preview: { hosts: string[] | null } = { hosts: null };

const get = (url: string) => new NextRequest(`http://localhost${url}`);
const post = (url: string, body?: unknown, raw?: string) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function routes() {
  return securityRoutes(db, session, preview, fx.names);
}

function expectViewKeys(items: Array<Record<string, unknown>>, keys: string[]) {
  for (const item of items) for (const key of Object.keys(item)) expect(keys).toContain(key);
}

beforeAll(async () => {
  db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseFunctionDefaults: true })).db;
  fx = await seedSecurityTenants(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  session.userId = null;
  preview.hosts = null;
  vi.stubEnv('RAG_SECURITY_EVENTS', 'true');
  vi.stubEnv('RAG_UPLOADER_HOLD', 'manual');
  vi.stubEnv('RAG_UPLOADER_ALERT_THRESHOLD', '2');
  vi.stubEnv('RAG_UPLOADER_ALERT_WINDOW_HOURS', '24');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('security-events admission', () => {
  it('answers 401 without a session and 403 for a user who administers no tenant, on every route', async () => {
    const r = await routes();
    const calls = () => [
      r.events.GET(get('/api/rag/admin/security-events')),
      r.alerts.GET(get('/api/rag/admin/security-events/alerts')),
      r.uploaders.GET(get('/api/rag/admin/security-events/uploaders')),
      r.linkPreviews.GET(get('/api/rag/admin/security-events/link-previews')),
      r.hold.POST(post(`/api/rag/admin/security-events/uploaders/${fx.uploaderA1}/hold`, { tenantKey: fx.tenantA }), params(fx.uploaderA1)),
      r.release.POST(post(`/api/rag/admin/security-events/uploaders/${fx.uploaderA1}/release`, { tenantKey: fx.tenantA }), params(fx.uploaderA1)),
      r.acknowledge.POST(post(`/api/rag/admin/security-events/alerts/${fx.alertA}/acknowledge`), params(fx.alertA)),
    ];
    for (const res of await Promise.all(calls())) expect(res.status).toBe(401);
    session.userId = fx.member;
    for (const res of await Promise.all(calls())) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: 'Admin access required' });
    }
  });
});

describe('GET /api/rag/admin/security-events', () => {
  it('gives a deployment admin every tenant, newest first, with the uploader e-mail and view fields only', async () => {
    session.userId = fx.admin;
    const res = await (await routes()).events.GET(get('/api/rag/admin/security-events'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.events_recorded).toBe(true);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(50);
    expect(body.next_cursor).toBe('50');
    for (const item of items) SecurityEventViewSchema.parse(item);
    expectViewKeys(items, VIEW_KEYS.event);
    const times = items.map((item) => Date.parse(item.created_at as string));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const rest = await (await (await routes()).events.GET(get('/api/rag/admin/security-events?cursor=50'))).json();
    const all = [...items, ...rest.items];
    expect(new Set(all.map((item) => item.tenant_key))).toEqual(new Set([fx.tenantA, fx.tenantB]));
    expect(rest.next_cursor).toBeNull();
    const withDocument = all.find((item) => item.document_id === fx.docA1);
    expect(withDocument).toMatchObject({ file_name: 'document-a1.pdf', uploader_id: fx.uploaderA1, uploader_name: 'Uploader One', workspace_name: 'Workspace A' });
    expect(withDocument?.uploader_email).toBe(fx.emailOf(fx.uploaderA1));
  });

  it("gives an organization admin and a domain expert only their tenant's events, without e-mail", async () => {
    for (const user of [fx.orgAdminA, fx.expertA]) {
      session.userId = user;
      const r = await routes();
      const first = await (await r.events.GET(get('/api/rag/admin/security-events'))).json();
      const second = first.next_cursor ? await (await r.events.GET(get(`/api/rag/admin/security-events?cursor=${first.next_cursor}`))).json() : { items: [] };
      const items = [...first.items, ...second.items] as Array<Record<string, unknown>>;
      expect(items.length).toBe(fx.eventCountA);
      expect(items.every((item) => item.tenant_key === fx.tenantA)).toBe(true);
      expect(items.every((item) => item.uploader_email === null)).toBe(true);
      expect(items.some((item) => item.uploader_name === 'Uploader One')).toBe(true);
    }
  });

  it('filters by source, uploader and start time', async () => {
    session.userId = fx.orgAdminA;
    const r = await routes();
    const bySource = await (await r.events.GET(get('/api/rag/admin/security-events?source=ingest_injection'))).json();
    expect(bySource.items.length).toBeGreaterThan(0);
    expect(bySource.items.every((item: { source: string }) => item.source === 'ingest_injection')).toBe(true);
    const byUploader = await (await r.events.GET(get(`/api/rag/admin/security-events?uploader=${fx.uploaderA2}`))).json();
    expect(byUploader.items.length).toBe(fx.eventCountA2);
    expect(byUploader.items.every((item: { uploader_id: string }) => item.uploader_id === fx.uploaderA2)).toBe(true);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const bySince = await (await r.events.GET(get(`/api/rag/admin/security-events?since=${encodeURIComponent(future)}`))).json();
    expect(bySince.items).toEqual([]);
  });

  it('answers 400 with details for an invalid query', async () => {
    session.userId = fx.admin;
    const r = await routes();
    for (const query of ['source=unknown_source', 'uploader=not-a-uuid', 'since=yesterday', 'cursor=-1', 'extra=1']) {
      const res = await r.events.GET(get(`/api/rag/admin/security-events?${query}`));
      expect(res.status, query).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.details.length).toBeGreaterThan(0);
    }
  });

  it('reports events_recorded false while RAG_SECURITY_EVENTS is off and still lists stored rows', async () => {
    vi.stubEnv('RAG_SECURITY_EVENTS', 'false');
    session.userId = fx.orgAdminA;
    const body = await (await (await routes()).events.GET(get('/api/rag/admin/security-events'))).json();
    expect(body.events_recorded).toBe(false);
    expect(body.items.length).toBeGreaterThan(0);
  });
});

describe('GET alerts and uploaders', () => {
  it('lists alerts with the uploader view, workspace, counts, window, threshold, status, held and the effective settings', async () => {
    session.userId = fx.admin;
    const res = await (await routes()).alerts.GET(get('/api/rag/admin/security-events/alerts'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, hold_mode: 'manual', alert_level: 2, window_hours: 24, events_recorded: true });
    expect(body.open_count).toBe(body.items.filter((item: { status: string }) => item.status === 'open').length);
    for (const item of body.items) SecurityAlertViewSchema.parse(item);
    expectViewKeys(body.items, VIEW_KEYS.alert);
    const alert = body.items.find((item: { id: string }) => item.id === fx.alertA);
    expect(alert).toMatchObject({
      tenant_key: fx.tenantA,
      workspace_name: 'Workspace A',
      uploader_id: fx.uploaderA1,
      uploader_name: 'Uploader One',
      uploader_email: fx.emailOf(fx.uploaderA1),
      window_hours: 24,
      threshold: 2,
      status: 'open',
      held: false,
    });
    expect(alert.event_count).toBeGreaterThanOrEqual(3);
  });

  it("lists only the organization admin's alerts, without e-mail", async () => {
    session.userId = fx.orgAdminA;
    const body = await (await (await routes()).alerts.GET(get('/api/rag/admin/security-events/alerts'))).json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item: { tenant_key: string; uploader_email: unknown }) => item.tenant_key === fx.tenantA && item.uploader_email === null)).toBe(true);
  });

  it('lists uploaders per workspace with event count, last event and hold state', async () => {
    session.userId = fx.orgAdminA;
    const res = await (await routes()).uploaders.GET(get('/api/rag/admin/security-events/uploaders'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, hold_mode: 'manual', window_hours: 24 });
    for (const item of body.items) SecurityUploaderViewSchema.parse(item);
    expectViewKeys(body.items, VIEW_KEYS.uploader);
    const one = body.items.find((item: { user_id: string }) => item.user_id === fx.uploaderA1);
    expect(one).toMatchObject({ tenant_key: fx.tenantA, display_name: 'Uploader One', email: null, held: false, held_since: null });
    expect(one.event_count).toBeGreaterThan(0);
    expect(typeof one.last_event_at).toBe('string');
    expect(body.items.every((item: { tenant_key: string }) => item.tenant_key === fx.tenantA)).toBe(true);
  });
});

describe('hold, release and acknowledge', () => {
  it('holds an uploader, refuses a second hold, then releases once and says held uploads still wait for approval', async () => {
    session.userId = fx.orgAdminA;
    const r = await routes();
    const url = `/api/rag/admin/security-events/uploaders/${fx.uploaderA2}`;

    const held = await r.hold.POST(post(`${url}/hold`, { tenantKey: fx.tenantA, reason: 'A synthetic reason' }), params(fx.uploaderA2));
    expect(held.status).toBe(200);
    const heldBody = await held.json();
    expect(heldBody).toMatchObject({ success: true, user_id: fx.uploaderA2, tenant_key: fx.tenantA, held: true });
    expect(typeof heldBody.held_since).toBe('string');

    const again = await r.hold.POST(post(`${url}/hold`, { tenantKey: fx.tenantA }), params(fx.uploaderA2));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('already_held');

    const listed = await (await r.uploaders.GET(get('/api/rag/admin/security-events/uploaders'))).json();
    expect(listed.items.find((item: { user_id: string }) => item.user_id === fx.uploaderA2)).toMatchObject({ held: true });

    const released = await r.release.POST(post(`${url}/release`, { tenantKey: fx.tenantA }), params(fx.uploaderA2));
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({
      success: true,
      user_id: fx.uploaderA2,
      tenant_key: fx.tenantA,
      held: false,
      held_since: null,
      held_uploads: 'pending_approval',
    });
    const twice = await r.release.POST(post(`${url}/release`, { tenantKey: fx.tenantA }), params(fx.uploaderA2));
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe('not_held');
  });

  it('answers 409 hold_disabled with hold mode off and writes no hold', async () => {
    vi.stubEnv('RAG_UPLOADER_HOLD', 'off');
    session.userId = fx.admin;
    const res = await (await routes()).hold.POST(post(`/api/rag/admin/security-events/uploaders/${fx.uploaderA1}/hold`, { tenantKey: fx.tenantA }), params(fx.uploaderA1));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('hold_disabled');
    const rows = await db.query('SELECT 1 FROM rag_uploader_holds WHERE user_id = $1 AND released_at IS NULL', [fx.uploaderA1]);
    expect(rows.rows).toHaveLength(0);
  });

  it('answers 400 with details for a reason over 200 characters, a malformed body or a bad id', async () => {
    session.userId = fx.admin;
    const r = await routes();
    const url = `/api/rag/admin/security-events/uploaders/${fx.uploaderA1}/hold`;
    const long = await r.hold.POST(post(url, { tenantKey: fx.tenantA, reason: 'x'.repeat(201) }), params(fx.uploaderA1));
    expect(long.status).toBe(400);
    expect((await long.json()).details[0].path).toBe('reason');
    expect((await r.hold.POST(post(url, undefined, '{not json'), params(fx.uploaderA1))).status).toBe(400);
    expect((await r.hold.POST(post(url, { tenantKey: fx.tenantA, extra: true }), params(fx.uploaderA1))).status).toBe(400);
    expect((await r.hold.POST(post(url, { tenantKey: 'bad' }), params(fx.uploaderA1))).status).toBe(400);
    expect((await r.hold.POST(post('/x', { tenantKey: fx.tenantA }), params('not-a-uuid'))).status).toBe(400);
  });

  it("answers 404 for an uploader of another tenant or of no tenant, never 403", async () => {
    session.userId = fx.orgAdminA;
    const r = await routes();
    const other = await r.hold.POST(post('/x', { tenantKey: fx.tenantB }), params(fx.uploaderB));
    expect(other.status).toBe(404);
    const otherInA = await r.hold.POST(post('/x', { tenantKey: fx.tenantA }), params(fx.uploaderB));
    expect(otherInA.status).toBe(404);
    const release = await r.release.POST(post('/x', { tenantKey: fx.tenantB }), params(fx.uploaderB));
    expect(release.status).toBe(404);
    expect((await db.query('SELECT 1 FROM rag_uploader_holds WHERE user_id = $1', [fx.uploaderB])).rows).toHaveLength(0);
  });

  it('acknowledges once, then 409; an alert of another tenant is 404', async () => {
    session.userId = fx.orgAdminA;
    const r = await routes();
    const url = (id: string) => `/api/rag/admin/security-events/alerts/${id}/acknowledge`;
    const foreign = await r.acknowledge.POST(post(url(fx.alertB)), params(fx.alertB));
    expect(foreign.status).toBe(404);
    const ok = await r.acknowledge.POST(post(url(fx.alertA)), params(fx.alertA));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true, id: fx.alertA, tenant_key: fx.tenantA, status: 'acknowledged' });
    const again = await r.acknowledge.POST(post(url(fx.alertA)), params(fx.alertA));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('already_acknowledged');
    expect((await r.acknowledge.POST(post(url('not-a-uuid')), params('not-a-uuid'))).status).toBe(404);
    const status = await db.query<{ status: string }>('SELECT status FROM rag_security_alerts WHERE id = $1', [fx.alertB]);
    expect(status.rows[0]?.status).toBe('open');
  });
});

describe('GET link-previews', () => {
  it('reports unknown, none, subset and mismatch with host names only', async () => {
    session.userId = fx.admin;
    vi.stubEnv('RAG_OUTPUT_LINK_ALLOWLIST', 'allowed.example');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example');
    const r = await routes();
    const status = async () => {
      const res = await r.linkPreviews.GET(get('/api/rag/admin/security-events/link-previews'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['hosts_not_allowlisted', 'preview_hosts', 'state', 'success']);
      const { success: _success, ...view } = body;
      return LinkPreviewStatusSchema.parse(view);
    };
    preview.hosts = null;
    expect(await status()).toEqual({ state: 'unknown', preview_hosts: [], hosts_not_allowlisted: [] });
    preview.hosts = [];
    expect(await status()).toEqual({ state: 'none', preview_hosts: [], hosts_not_allowlisted: [] });
    preview.hosts = ['allowed.example', 'cdn.allowed.example', 'app.example'];
    expect(await status()).toEqual({ state: 'subset', preview_hosts: ['allowed.example', 'cdn.allowed.example', 'app.example'], hosts_not_allowlisted: [] });
    preview.hosts = ['allowed.example', 'notallowed.example', 'evilallowed.example'];
    expect(await status()).toEqual({
      state: 'mismatch',
      preview_hosts: ['allowed.example', 'notallowed.example', 'evilallowed.example'],
      hosts_not_allowlisted: ['notallowed.example', 'evilallowed.example'],
    });
  });

  it('is for deployment admins only', async () => {
    session.userId = fx.orgAdminA;
    const res = await (await routes()).linkPreviews.GET(get('/api/rag/admin/security-events/link-previews'));
    expect(res.status).toBe(403);
  });

  it('keeps only valid host names from the service', async () => {
    session.userId = fx.admin;
    vi.stubEnv('RAG_OUTPUT_LINK_ALLOWLIST', '');
    preview.hosts = ['Host.Example.', '<img src=x>', 'javascript:alert(1)'];
    const body = await (await (await routes()).linkPreviews.GET(get('/api/rag/admin/security-events/link-previews'))).json();
    for (const host of [...body.preview_hosts, ...body.hosts_not_allowlisted]) expect(host).toMatch(/^[a-z0-9.-]+$/);
    expect(body.preview_hosts).toContain('host.example');
  });
});

