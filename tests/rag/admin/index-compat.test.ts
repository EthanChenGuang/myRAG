import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computeIndexCompat, envLoadedAt, type IndexCompatInput } from '@/lib/rag/backend/index-compat';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { createFakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { VectorStore } from '@/lib/rag/sync/stores/types';
import { harness, headersFor, loadRoute, resetHarness } from './route-harness';

/**
 * D-16 (ADM-01, RET-09): the server-computed index-compatibility warnings. Tenant keys and profile ids are synthetic placeholders.
 */

const PROFILE = { id: 'profile-alpha-1536', dims: 1536 };
const TENANT_A = 'u:00000000-0000-4000-8000-0000000015a1';
const TENANT_B = 'o:00000000-0000-4000-8000-0000000015b1';

type StatusRow = { target: string; enabled: boolean; pending: number; leased: number; dead: number; oldest_pending_seconds: number | null };
type CountRow = { target: string; profile_id: string; state: string; tenants: number };

function disabled(target: string): StatusRow {
  return { target, enabled: false, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null };
}

function fakeRpc(status: StatusRow[], counts: CountRow[] = [], errors: Record<string, string> = {}): RpcClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rpc(fn: string) {
      calls.push(fn);
      const data = fn === 'rag_vector_sync_status' ? status : fn === 'rag_backend_index_state_counts' ? counts : null;
      const error = errors[fn] ? { code: errors[fn], message: `${fn} failed for ${TENANT_A}` } : null;
      return { abortSignal: async () => ({ data: error ? null : data, error }) };
    },
  } as unknown as RpcClient & { calls: string[] };
}

async function storeWithCollection(target: 'qdrant' | 'weaviate', dims: number): Promise<VectorStore> {
  const store = createFakeVectorStore(target);
  await store.ensureCollection({ profileId: PROFILE.id, dims });
  await store.ensureTenant(PROFILE.id, TENANT_A);
  return store;
}

function input(overrides: Partial<IndexCompatInput> = {}): IndexCompatInput {
  return {
    config: { pipeline: 'v2', backend: { default: 'pgvector', voice: 'pgvector', maxLagSeconds: 300 } },
    rpc: fakeRpc([disabled('qdrant'), disabled('weaviate')]),
    stores: {},
    activeProfile: PROFILE,
    ...overrides,
  };
}

const qdrantConfig = (pipeline: 'legacy' | 'v2' = 'v2') => ({
  pipeline,
  backend: { default: 'qdrant' as const, voice: 'pgvector' as const, maxLagSeconds: 300 },
});

function codes(report: { warnings: Array<{ code: string }> }): string[] {
  return report.warnings.map((w) => w.code).sort();
}

describe('computeIndexCompat', () => {
  test('defaults (pgvector, no target enabled): no warnings and both targets listed with zero counts', async () => {
    let built = 0;
    const report = await computeIndexCompat(
      input({
        stores: {
          qdrant: async () => {
            built += 1;
            return createFakeVectorStore('qdrant');
          },
        },
      }),
    );
    expect(report.warnings).toEqual([]);
    expect(built).toBe(0);
    expect(report.backends.map((b) => b.target)).toEqual(['weaviate', 'qdrant']);
    for (const backend of report.backends) {
      expect(backend).toMatchObject({ enabled: false, pending: 0, leased: 0, dead: 0, oldestPendingSeconds: null, selected: false, profiles: [] });
    }
  });

  test('qdrant selected while its sync is disabled: sync_not_enabled', async () => {
    const report = await computeIndexCompat(
      input({ config: qdrantConfig(), stores: { qdrant: () => storeWithCollection('qdrant', 1536) } }),
    );
    expect(codes(report)).toEqual(['sync_not_enabled']);
    expect(report.warnings[0]).toMatchObject({ code: 'sync_not_enabled', backend: 'qdrant' });
  });

  test('enabled with one tenant stale: backend_not_ready with the state counts', async () => {
    const rpc = fakeRpc(
      [{ target: 'qdrant', enabled: true, pending: 2, leased: 1, dead: 0, oldest_pending_seconds: 17 }, disabled('weaviate')],
      [
        { target: 'qdrant', profile_id: PROFILE.id, state: 'ready', tenants: 4 },
        { target: 'qdrant', profile_id: PROFILE.id, state: 'stale', tenants: 1 },
        { target: 'qdrant', profile_id: 'profile-older-1024', state: 'ready', tenants: 5 },
      ],
    );
    const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores: { qdrant: () => storeWithCollection('qdrant', 1536) } }));
    expect(codes(report)).toEqual(['backend_not_ready']);
    expect(report.warnings[0]).toEqual({
      code: 'backend_not_ready',
      backend: 'qdrant',
      detail: { profileId: PROFILE.id, building: 0, stale: 1, failed: 0, ready: 4 },
    });
    const qdrant = report.backends.find((b) => b.target === 'qdrant');
    expect(qdrant).toMatchObject({ enabled: true, pending: 2, leased: 1, dead: 0, oldestPendingSeconds: 17, selected: true });
    expect(qdrant?.profiles).toEqual([
      { profileId: PROFILE.id, building: 0, ready: 4, stale: 1, failed: 0 },
      { profileId: 'profile-older-1024', building: 0, ready: 5, stale: 0, failed: 0 },
    ]);
  });

  test('building and failed tenants of the active profile also count as not ready; other profiles do not', async () => {
    for (const state of ['building', 'failed']) {
      const rpc = fakeRpc(
        [{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null }, disabled('weaviate')],
        [{ target: 'qdrant', profile_id: PROFILE.id, state, tenants: 2 }],
      );
      const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores: { qdrant: () => storeWithCollection('qdrant', 1536) } }));
      expect(codes(report)).toEqual(['backend_not_ready']);
      expect(report.warnings[0].detail[state]).toBe(2);
    }
    const rpc = fakeRpc(
      [{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null }, disabled('weaviate')],
      [
        { target: 'qdrant', profile_id: PROFILE.id, state: 'ready', tenants: 2 },
        { target: 'qdrant', profile_id: 'profile-older-1024', state: 'failed', tenants: 2 },
        { target: 'weaviate', profile_id: PROFILE.id, state: 'stale', tenants: 1 },
      ],
    );
    const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores: { qdrant: () => storeWithCollection('qdrant', 1536) } }));
    expect(report.warnings).toEqual([]);
  });

  test('collection dims 1024 against the active 1536: dimension_mismatch', async () => {
    const rpc = fakeRpc(
      [{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null }, disabled('weaviate')],
      [{ target: 'qdrant', profile_id: PROFILE.id, state: 'ready', tenants: 1 }],
    );
    const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores: { qdrant: () => storeWithCollection('qdrant', 1024) } }));
    expect(report.warnings).toEqual([
      { code: 'dimension_mismatch', backend: 'qdrant', detail: { profileId: PROFILE.id, profileDims: 1536, collectionDims: 1024 } },
    ]);
  });

  test('a missing collection is not a dimension mismatch', async () => {
    const rpc = fakeRpc([{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null }, disabled('weaviate')]);
    const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores: { qdrant: async () => createFakeVectorStore('qdrant') } }));
    expect(report.warnings).toEqual([]);
  });

  test('RAG_PIPELINE=legacy with qdrant selected: legacy_pipeline', async () => {
    const rpc = fakeRpc([{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null }, disabled('weaviate')]);
    const report = await computeIndexCompat(input({ config: qdrantConfig('legacy'), rpc, stores: { qdrant: () => storeWithCollection('qdrant', 1536) } }));
    expect(report.warnings).toEqual([{ code: 'legacy_pipeline', backend: 'qdrant', detail: { pipeline: 'legacy' } }]);
  });

  test('the voice backend counts as selected too', async () => {
    const report = await computeIndexCompat(
      input({
        config: { pipeline: 'v2', backend: { default: 'pgvector', voice: 'weaviate', maxLagSeconds: 300 } },
        stores: { weaviate: () => storeWithCollection('weaviate', 1536) },
      }),
    );
    expect(report.warnings).toEqual([{ code: 'sync_not_enabled', backend: 'weaviate', detail: {} }]);
    expect(report.backends.find((b) => b.target === 'weaviate')?.selected).toBe(true);
  });

  test('dead outbox rows on any target: dead_letters with the count, also while pgvector is selected', async () => {
    const rpc = fakeRpc([disabled('qdrant'), { target: 'weaviate', enabled: true, pending: 0, leased: 0, dead: 3, oldest_pending_seconds: null }]);
    const report = await computeIndexCompat(input({ rpc }));
    expect(report.warnings).toEqual([{ code: 'dead_letters', backend: 'weaviate', detail: { dead: 3 } }]);
  });

  test('a store health failure gives backend_unreachable and keeps the other warnings and fields', async () => {
    const rpc = fakeRpc([{ target: 'qdrant', enabled: true, pending: 1, leased: 0, dead: 2, oldest_pending_seconds: 5 }, disabled('weaviate')]);
    const unhealthy = async (): Promise<VectorStore> => {
      const store = createFakeVectorStore('qdrant');
      return { ...store, health: async () => ({ ok: false, detail: `https://user:pass@qdrant.example/${TENANT_A}` }) };
    };
    const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores: { qdrant: unhealthy } }));
    expect(codes(report)).toEqual(['backend_unreachable', 'dead_letters']);
    expect(report.warnings.find((w) => w.code === 'backend_unreachable')).toEqual({
      code: 'backend_unreachable',
      backend: 'qdrant',
      detail: { stage: 'health', reason: 'unhealthy' },
    });
    expect(report.backends.find((b) => b.target === 'qdrant')).toMatchObject({ pending: 1, dead: 2 });
    expect(JSON.stringify(report)).not.toContain('qdrant.example');
  });

  test('a throwing health check, a client that cannot be built, a missing factory and a hanging call are all backend_unreachable', async () => {
    const rpc = fakeRpc([{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null }, disabled('weaviate')]);
    const cases: Array<[IndexCompatInput['stores'], Record<string, string>]> = [
      [{ qdrant: async () => ({ ...createFakeVectorStore('qdrant'), health: async () => Promise.reject(new Error(`down ${TENANT_B}`)) }) }, { stage: 'health', reason: 'error' }],
      [{ qdrant: async () => Promise.reject(new Error('QDRANT_URL is not set: https://secret.example')) }, { stage: 'client', reason: 'error' }],
      [{}, { stage: 'client', reason: 'error' }],
      [{ qdrant: async () => ({ ...createFakeVectorStore('qdrant'), describeCollection: () => new Promise(() => undefined) }) }, { stage: 'describe', reason: 'timeout' }],
    ];
    for (const [stores, detail] of cases) {
      const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores, storeTimeoutMs: 20 }));
      expect(report.warnings).toEqual([{ code: 'backend_unreachable', backend: 'qdrant', detail }]);
      const text = JSON.stringify(report);
      expect(text).not.toContain('secret.example');
      expect(text).not.toContain(TENANT_B);
    }
  });

  test('the report never carries a tenant key; database read errors throw a code-only error', async () => {
    const rpc = fakeRpc(
      [{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 1, oldest_pending_seconds: null }, disabled('weaviate')],
      [{ target: 'qdrant', profile_id: PROFILE.id, state: 'stale', tenants: 1 }],
    );
    const report = await computeIndexCompat(input({ config: qdrantConfig(), rpc, stores: { qdrant: () => storeWithCollection('qdrant', 1536) } }));
    const text = JSON.stringify(report);
    for (const key of [TENANT_A, TENANT_B]) expect(text).not.toContain(key);
    expect(rpc.calls.sort()).toEqual(['rag_backend_index_state_counts', 'rag_vector_sync_status']);

    for (const fn of ['rag_vector_sync_status', 'rag_backend_index_state_counts']) {
      const failing = fakeRpc([disabled('qdrant'), disabled('weaviate')], [], { [fn]: '42883' });
      const error = await computeIndexCompat(input({ rpc: failing })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(TENANT_A);
    }
  });

  test('envLoadedAt is the process start time, at or before now', () => {
    const at = Date.parse(envLoadedAt());
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - at).toBeGreaterThanOrEqual(Math.floor(process.uptime() * 1000) - 2000);
  });
});

describe('GET /api/rag/admin/index-compat', () => {
  const load = () => loadRoute(() => import('@/app/api/rag/admin/index-compat/route'));
  const get = (route: Awaited<ReturnType<typeof load>>, auth: Parameters<typeof headersFor>[0]) =>
    route.GET(new Request('http://localhost/api/rag/admin/index-compat', { headers: headersFor(auth) }));
  const statusRows = (rows: StatusRow[]) => ({ data: rows, error: null });

  beforeEach(() => {
    resetHarness();
    harness.outcomes.rag_vector_sync_status = statusRows([disabled('qdrant'), disabled('weaviate')]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('is a nodejs route', async () => {
    const route = await load();
    expect(route.runtime).toBe('nodejs');
  });

  test('no admin session or bearer: 401; a non-admin: 403; guard unavailable: 503; nothing is read before the guard', async () => {
    const route = await load();
    for (const auth of ['none', 'forged'] as const) {
      const response = await get(route, auth);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await get(route, 'user')).status).toBe(403);
    harness.guardAvailable = false;
    expect((await get(route, 'admin')).status).toBe(503);
    harness.guardAvailable = true;
    harness.sessionThrows = true;
    expect((await get(route, 'none')).status).toBe(503);
    expect(harness.rpcCalls).toEqual([]);
  });

  test('defaults: 200 with no warnings, both targets and envLoadedAt', async () => {
    const route = await load();
    const response = await get(route, 'admin');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(body.backends.map((b: { target: string }) => b.target)).toEqual(['weaviate', 'qdrant']);
    expect(Number.isFinite(Date.parse(body.envLoadedAt))).toBe(true);
  });

  test('qdrant selected without a URL: sync_not_enabled and backend_unreachable, 200, no tenant key or URL in the body', async () => {
    harness.env = { RAG_PIPELINE: 'v2', RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SUPPORTED_LANGUAGES: 'en', RAG_PRIMARY_LANGUAGE: 'en' };
    harness.outcomes.rag_backend_index_state_counts = { data: [{ target: 'qdrant', profile_id: 'openai-3-small-1536', state: 'stale', tenants: 1 }], error: null };
    const route = await load();
    const response = await get(route, 'admin');
    expect(response.status).toBe(200);
    const body = await response.json();
    const found = body.warnings.map((w: { code: string }) => w.code).sort();
    expect(found).toContain('sync_not_enabled');
    expect(found).toContain('backend_unreachable');
    const text = JSON.stringify(body);
    expect(text).not.toContain(TENANT_A);
    expect(text).not.toMatch(/https?:\/\//);
  });

  test('the service-role client unavailable or a status read error: 503 with a generic error and a code-only log', async () => {
    harness.rpcAvailable = false;
    let route = await load();
    let response = await get(route, 'admin');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'index_compat_unavailable' });

    harness.rpcAvailable = true;
    harness.outcomes.rag_vector_sync_status = { data: null, error: { code: '42883', message: `missing for ${TENANT_A}` } };
    route = await load();
    response = await get(route, 'admin');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'index_compat_unavailable' });
    const line = harness.logged.find((l) => l.startsWith('[RAG Admin]'));
    expect(line).toContain('42883');
    expect(harness.logged.join('\n')).not.toContain(TENANT_A);
  });
});
