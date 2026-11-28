import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeGraph, type FakeGraph } from '../helpers/fake-graph';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';

type Row = Record<string, unknown>;

const state = {
  session: null as { id: string } | null,
  rows: [] as Row[],
  proxyCalls: [] as Array<{ providerConfigKey: string; connectionId: string; endpoint: string }>,
  graph: undefined as FakeGraph | undefined,
};

function admin() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const run = () => ({
        data: table === 'nango_connections' ? state.rows.filter((row) => filters.every(([c, v]) => row[c] === v)) : [],
        error: null,
      });
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

function proxy() {
  return async (config: { providerConfigKey: string; connectionId: string; endpoint: string }) => {
    state.proxyCalls.push({ providerConfigKey: config.providerConfigKey, connectionId: config.connectionId, endpoint: config.endpoint });
    const response = await state.graph!.transport()({ endpoint: config.endpoint });
    if (response.status >= 200 && response.status < 300) return response;
    throw Object.assign(new Error(`Request failed with status code ${response.status}`), { response });
  };
}

async function load(kind: 'sites' | 'drives' | 'folders') {
  vi.resetModules();
  vi.doMock('@/lib/nango/client', () => ({
    isNangoEnabled: () => true,
    getNango: () => ({ proxy: proxy() }),
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session }, error: null }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin() }));
  if (kind === 'sites') return import('@/app/api/nango/sharepoint/sites/route');
  if (kind === 'drives') return import('@/app/api/nango/sharepoint/drives/route');
  return import('@/app/api/nango/sharepoint/folders/route');
}

function get(kind: string, query: string): NextRequest {
  return new NextRequest(`http://localhost/api/nango/sharepoint/${kind}${query ? `?${query}` : ''}`);
}

async function call(kind: 'sites' | 'drives' | 'folders', query = '') {
  const route = await load(kind);
  const response = await route.GET(get(kind, query));
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown>, headers: response.headers };
}

function expectNoGraphLeak(text: string) {
  expect(text).not.toContain('graph.microsoft.com');
  expect(text).not.toContain('@odata');
  expect(text.toLowerCase()).not.toContain('deltalink');
  expect(text).not.toContain('skiptoken');
  expect(text.toLowerCase()).not.toMatch(/access_token|bearer|"token"/);
}

beforeEach(async () => {
  process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED = 'true';
  delete process.env.NANGO_SHAREPOINT_INTEGRATION_KEY;
  delete process.env.NANGO_ONEDRIVE_INTEGRATION_KEY;
  state.session = { id: USER_A };
  state.rows = [
    { id: 'row-a-sp', user_id: USER_A, provider: 'sharepoint-online', connection_id: 'conn-a-sp', status: 'connected' },
    { id: 'row-a-od', user_id: USER_A, provider: 'one-drive', connection_id: 'conn-a-od', status: 'connected' },
    { id: 'row-b-sp', user_id: USER_B, provider: 'sharepoint-online', connection_id: 'conn-b-sp', status: 'connected' },
  ];
  state.proxyCalls = [];
  state.graph = await startFakeGraph('picker-lists');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED;
  await state.graph?.close();
  state.graph = undefined;
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/nango/client');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
});

describe('GET /api/nango/sharepoint/drives', () => {
  it('lists the libraries of a site from the session user\'s own connection', async () => {
    const result = await call('drives', 'site_id=site-a');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      items: [
        { id: 'drive-a', name: 'Library 1', has_children: true },
        { id: 'drive-b', name: 'Library 2', has_children: true },
      ],
      cursor: null,
    });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(state.proxyCalls).toEqual([
      { providerConfigKey: 'sharepoint-online', connectionId: 'conn-a-sp', endpoint: '/v1.0/sites/site-a/drives?$select=id,name' },
    ]);
    expectNoGraphLeak(result.text);
  });

  it('lists the OneDrive libraries through /me/drives with the OneDrive connection', async () => {
    const result = await call('drives', 'provider=one-drive');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [{ id: 'drive-o', name: 'Library 1', has_children: true }], cursor: null });
    expect(state.proxyCalls[0]).toMatchObject({ providerConfigKey: 'one-drive', connectionId: 'conn-a-od', endpoint: '/v1.0/me/drives?$select=id,name' });
  });

  it('never takes the connection from the request', async () => {
    const result = await call('drives', 'site_id=site-a&connection_id=conn-b-sp&connectionId=conn-b-sp');
    expect(result.status).toBe(200);
    expect(state.proxyCalls.map((c) => c.connectionId)).toEqual(['conn-a-sp']);
  });

  it('answers 401 without a session and calls nothing', async () => {
    state.session = null;
    const result = await call('drives', 'site_id=site-a');
    expect(result.status).toBe(401);
    expect(state.proxyCalls).toEqual([]);
  });

  it('answers 404 when the user has no connected connection of the provider', async () => {
    state.rows = state.rows.filter((row) => row.user_id !== USER_A);
    const result = await call('drives', 'site_id=site-a');
    expect(result.status).toBe(404);
    expect(state.proxyCalls).toEqual([]);
  });

  it('refuses a site id that is not a Graph id shape', async () => {
    for (const bad of ['..', '../me', 'site-a/drives', 'site%3Fx', 'a b', '']) {
      const result = await call('drives', `site_id=${encodeURIComponent(bad)}`);
      expect(result.status, bad).toBe(400);
    }
    const missing = await call('drives', '');
    expect(missing.status).toBe(400);
    expect(state.proxyCalls).toEqual([]);
  });
});

describe('GET /api/nango/sharepoint/sites', () => {
  it('lists sites for an empty query and pages with an opaque cursor', async () => {
    const first = await call('sites', 'query=');
    expect(first.status).toBe(200);
    expect(first.body.items).toEqual([{ id: 'site-a', name: 'Site A', has_children: true }]);
    expect(typeof first.body.cursor).toBe('string');
    expectNoGraphLeak(first.text);
    expect(String(first.body.cursor)).not.toContain('/v1.0');

    const second = await call('sites', `cursor=${encodeURIComponent(String(first.body.cursor))}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ items: [{ id: 'site-b', name: 'Site B', has_children: true }], cursor: null });
    expect(state.proxyCalls.map((c) => c.endpoint)).toEqual([
      '/v1.0/sites?$select=id,name,displayName',
      '/v1.0/sites?$select=id,name,displayName&$skiptoken=page2',
    ]);
  });

  it('uses the search form for a query', async () => {
    const result = await call('sites', 'query=ab');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [{ id: 'site-c', name: 'Site C', has_children: true }], cursor: null });
    expect(state.proxyCalls[0].endpoint).toBe('/v1.0/sites?search=ab&$select=id,name,displayName');
  });

  it('refuses a forged cursor, a cursor of another route and a raw link', async () => {
    const forged = [
      'https://graph.microsoft.com/v1.0/me/drives',
      '/v1.0/sites?$skiptoken=x',
      `spc1.${Buffer.from('/v1.0/me/drives?$select=id').toString('base64url')}`,
      `spc1.${Buffer.from('/v1.0/sites/../me/drives').toString('base64url')}`,
      `spc1.${Buffer.from('//evil.example/v1.0/sites').toString('base64url')}`,
      'spc1.!!!',
    ];
    for (const cursor of forged) {
      const result = await call('sites', `cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
    }
    expect(state.proxyCalls).toEqual([]);
  });

  it('is SharePoint only', async () => {
    const result = await call('sites', 'provider=one-drive');
    expect(result.status).toBe(400);
  });

  it('maps a Graph 429 to 429 throttled without waiting out a long Retry-After', async () => {
    state.graph!.respondOnce('/v1.0/sites?$select=id,name,displayName', { status: 429, headers: { 'retry-after': '120' }, body: { error: { code: 'TooManyRequests' } } });
    const started = Date.now();
    const result = await call('sites');
    expect(result.status).toBe(429);
    expect(result.body).toEqual({ error: 'throttled' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('maps any other Graph failure to 502 with a fixed word', async () => {
    state.graph!.respondOnce('/v1.0/sites?$select=id,name,displayName', {
      status: 500,
      body: { error: { code: 'generalException', message: 'see https://graph.microsoft.com/v1.0/sites' } },
    });
    const result = await call('sites');
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: 'upstream_failed' });
    expectNoGraphLeak(result.text);
  });
});

describe('GET /api/nango/sharepoint/folders', () => {
  it('returns only folders, with has_children from childCount, and pages', async () => {
    const first = await call('folders', 'drive_id=drive-a');
    expect(first.status).toBe(200);
    expect(first.body.items).toEqual([
      { id: 'item-folder-1', name: 'Folder 1', has_children: true },
      { id: 'item-folder-2', name: 'Folder 2', has_children: false },
    ]);
    expect(typeof first.body.cursor).toBe('string');
    expectNoGraphLeak(first.text);

    const second = await call('folders', `drive_id=drive-a&cursor=${encodeURIComponent(String(first.body.cursor))}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ items: [{ id: 'item-folder-3', name: 'Folder 3', has_children: true }], cursor: null });
  });

  it('lists the sub-folders of a folder', async () => {
    const result = await call('folders', 'drive_id=drive-a&item_id=item-folder-1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [{ id: 'item-folder-4', name: 'Folder 4', has_children: false }], cursor: null });
    expect(state.proxyCalls[0].endpoint).toBe('/v1.0/drives/drive-a/items/item-folder-1/children?$select=id,name,folder,file&$top=200');
  });

  it('refuses a cursor issued for another drive or folder', async () => {
    const first = await call('folders', 'drive_id=drive-a');
    const cursor = encodeURIComponent(String(first.body.cursor));
    state.proxyCalls = [];
    const otherDrive = await call('folders', `drive_id=drive-b&cursor=${cursor}`);
    expect(otherDrive.status).toBe(400);
    const otherFolder = await call('folders', `drive_id=drive-a&item_id=item-folder-1&cursor=${cursor}`);
    expect(otherFolder.status).toBe(400);
    expect(state.proxyCalls).toEqual([]);
  });

  it('refuses a malformed drive or item id', async () => {
    for (const query of ['', 'drive_id=drive-a%2F..', 'drive_id=drive-a&item_id=..', 'drive_id=drive-a&item_id=x%3Fy%3Dz']) {
      const result = await call('folders', query);
      expect(result.status, query).toBe(400);
    }
    expect(state.proxyCalls).toEqual([]);
  });

  it('answers 502 when Graph returns a next link on another host', async () => {
    state.graph!.respondOnce('/v1.0/drives/drive-a/items/item-folder-2/children?$select=id,name,folder,file&$top=200', {
      status: 200,
      body: { value: [], '@odata.nextLink': 'https://evil.example/v1.0/drives/drive-a/root/children' },
    });
    const result = await call('folders', 'drive_id=drive-a&item_id=item-folder-2');
    expect(result.status).toBe(502);
    expect(result.text).not.toContain('evil.example');
  });
});
