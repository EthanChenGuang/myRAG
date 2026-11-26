import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdmin, type FakeAdmin } from '../helpers/monitor-drift-fake';

const TENANT = 'o:00000000-0000-4000-8000-0000000033a0';
const OTHER_TENANT = 'o:00000000-0000-4000-8000-0000000033a1';
const ADMIN_ID = '00000000-0000-4000-8000-0000000033f0';

type Guard = { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; reason: string };

const state = {
  guard: { ok: true, userId: ADMIN_ID } as Guard,
  guardCalls: 0,
  admin: null as FakeAdmin | null,
  embedded: [] as string[],
  logs: [] as string[],
};

function vectorFor(text: string): number[] {
  if (text.includes('alpha')) return [1, 0.05, 0];
  if (text.includes('beta')) return [0.05, 1, 0];
  return [0, 0, 1];
}

function seed(withSet = true): FakeAdmin {
  const admin = fakeAdmin({
    rag_query_cluster_sets: withSet
      ? [
          { id: 'set-a', tenant_key: TENANT, status: 'current', embedder: 'profile:p-1', dimension: 3, fitted_at: '2026-11-01T00:00:00.000Z', distance_threshold: 0.3 },
          { id: 'set-b', tenant_key: OTHER_TENANT, status: 'current', embedder: 'profile:p-1', dimension: 3, fitted_at: '2026-11-01T00:00:00.000Z', distance_threshold: 0.3 },
        ]
      : [],
    rag_query_clusters: [
      { tenant_key: TENANT, set_id: 'set-a', cluster_id: 'c-01', centroid: [1, 0, 0] },
      { tenant_key: TENANT, set_id: 'set-a', cluster_id: 'c-02', centroid: [0, 1, 0] },
      { tenant_key: OTHER_TENANT, set_id: 'set-b', cluster_id: 'c-09', centroid: [0, 0, 1] },
    ],
  });
  admin.rpcs.rag_admin_tenant_keys = () => ({ data: [TENANT], error: null });
  return admin;
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin-route-auth')>()),
    checkAdmin: async () => {
      state.guardCalls += 1;
      return state.guard;
    },
  }));
  vi.doMock('@/lib/deployment-mode', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/deployment-mode')>()),
    getDeploymentMode: () => 'multi-tenant',
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.admin?.client ?? null, getSupabase: () => ({}) }));
  vi.doMock('@/lib/rag/embeddings/query-embedding', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rag/embeddings/query-embedding')>()),
    embedQueries: async (texts: string[]) => {
      state.embedded.push(...texts);
      return texts.map((text) => ({ vector: vectorFor(text), profile: { id: 'p-1' } }));
    },
  }));
  return import('@/app/api/rag/admin/monitor/assign-clusters/route');
}

const post = (body: unknown) =>
  new Request('http://localhost/api/rag/admin/monitor/assign-clusters', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const ITEMS = [
  { item_id: 'item-1', question: 'How does the alpha step start?' },
  { item_id: 'item-2', question: 'Which beta form applies?' },
  { item_id: 'item-3', question: 'Something far from every group' },
];

beforeEach(() => {
  state.guard = { ok: true, userId: ADMIN_ID };
  state.guardCalls = 0;
  state.admin = seed();
  state.embedded = [];
  state.logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      state.logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const id of ['@/lib/admin-route-auth', '@/lib/deployment-mode', '@/lib/supabase', '@/lib/rag/embeddings/query-embedding']) vi.doUnmock(id);
});

describe('POST /api/rag/admin/monitor/assign-clusters (D-42)', () => {
  it('answers 404 while RAG_REPRESENTATIVE_SAMPLE is off, before the admin guard', async () => {
    for (const value of [undefined, 'false', 'on']) {
      vi.unstubAllEnvs();
      if (value !== undefined) vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', value);
      const route = await loadRoute();
      expect((await route.POST(post({ tenant: TENANT, items: ITEMS }))).status).toBe(404);
    }
    expect(state.guardCalls).toBe(0);
    expect(state.embedded).toEqual([]);
  });

  it("passes the guard's denial through without a read", async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    state.guard = { ok: false, status: 401, reason: 'no_session' };
    expect((await route.POST(post({ tenant: TENANT, items: ITEMS }))).status).toBe(401);
    expect(state.admin?.calls).toEqual([]);
    expect(state.embedded).toEqual([]);
  });

  it('assigns each item to the nearest cluster of the tenant set, novel when far, and echoes no question', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    const response = await route.POST(post({ tenant: TENANT, items: ITEMS }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    for (const item of ITEMS) expect(text).not.toContain(item.question);
    expect(JSON.parse(text)).toEqual({
      success: true,
      set_id: 'set-a',
      embedder: 'profile:p-1',
      assignments: [
        { item_id: 'item-1', cluster_id: 'c-01' },
        { item_id: 'item-2', cluster_id: 'c-02' },
        { item_id: 'item-3', cluster_id: 'novel' },
      ],
    });
    expect(state.admin?.rpcCalls.map((call) => call.name)).toEqual(['rag_admin_tenant_keys']);
    for (const call of state.admin?.calls ?? []) {
      expect(call.filters).toContainEqual({ op: 'eq', column: 'tenant_key', value: TENANT });
    }
    for (const line of state.logs) for (const item of ITEMS) expect(line).not.toContain(item.question);
  });

  it('embeds the masked question, not the raw one', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    const response = await route.POST(post({ tenant: TENANT, items: [{ item_id: 'item-9', question: 'Write to someone@example.com about alpha' }] }));
    expect(response.status).toBe(200);
    expect(state.embedded).toHaveLength(1);
    expect(state.embedded[0]).not.toContain('someone@example.com');
    expect(state.embedded[0]).toContain('[EMAIL]');
  });

  it('answers 409 no_cluster_set when the tenant has no current set', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    state.admin = seed(false);
    const route = await loadRoute();
    const response = await route.POST(post({ tenant: TENANT, items: ITEMS }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'no_cluster_set' });
    expect(state.embedded).toEqual([]);
  });

  it('answers 400 for more than 500 items, a question over 2000 characters, extra keys or a bad body', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    const many = Array.from({ length: 501 }, (_, i) => ({ item_id: `item-${i}`, question: 'alpha' }));
    const bodies: unknown[] = [
      { tenant: TENANT, items: many },
      { tenant: TENANT, items: [{ item_id: 'item-1', question: 'a'.repeat(2001) }] },
      { tenant: TENANT, items: ITEMS, extra: true },
      { tenant: TENANT, items: [] },
      { tenant: TENANT, items: [ITEMS[0], ITEMS[0]] },
      { tenant: 'not-a-key', items: ITEMS },
      '{not json',
    ];
    for (const body of bodies) {
      const response = await route.POST(post(body));
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(Array.isArray(json.details)).toBe(true);
    }
    expect(state.embedded).toEqual([]);
  });

  it('answers 403 for a tenant the admin does not administer, without reading its clusters', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    const response = await route.POST(post({ tenant: OTHER_TENANT, items: ITEMS }));
    expect(response.status).toBe(403);
    expect(state.admin?.calls).toEqual([]);
    expect(state.embedded).toEqual([]);
  });
});
