import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { listVectorSyncTargets, setVectorSyncTarget } from '@/lib/rag/sync/targets';
import { ADMIN_ID, harness, headersFor, loadRoute, resetHarness } from './route-harness';

/** D-24: the Config UI's sync-target switch. Admin only, zod/v3 validated, the admin's id as the audit actor. */

const ROUTE = 'http://localhost/api/rag/admin/vector-sync/targets';
const STATUS = {
  data: [
    { target: 'qdrant', enabled: true, pending: 4, leased: 0, dead: 0, oldest_pending_seconds: 9 },
    { target: 'weaviate', enabled: false, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null },
  ],
  error: null,
};

const load = () => loadRoute(() => import('@/app/api/rag/admin/vector-sync/targets/route'));
type Route = Awaited<ReturnType<typeof load>>;

const get = (route: Route, auth: Parameters<typeof headersFor>[0]) => route.GET(new Request(ROUTE, { headers: headersFor(auth) }));
const put = (route: Route, auth: Parameters<typeof headersFor>[0], body: unknown) =>
  route.PUT(
    new NextRequest(ROUTE, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headersFor(auth) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  resetHarness();
  harness.outcomes.rag_vector_sync_status = STATUS;
  harness.outcomes.rag_vector_sync_set_target = { data: 3, error: null };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('vector sync target helpers', () => {
  function stub(data: unknown, error: { code: string } | null = null) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rpc = {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        return { abortSignal: async () => ({ data, error }) };
      },
    } as unknown as RpcClient;
    return { rpc, calls };
  }

  test('listVectorSyncTargets lists both targets; a target with no row is disabled', async () => {
    const { rpc } = stub([{ target: 'qdrant', enabled: true, pending: 0, leased: 0, dead: 0, oldest_pending_seconds: null }]);
    expect(await listVectorSyncTargets(rpc)).toEqual([
      { target: 'weaviate', enabled: false },
      { target: 'qdrant', enabled: true },
    ]);
  });

  test('setVectorSyncTarget passes the actor and returns the enqueued count; errors carry the code only', async () => {
    const ok = stub(2);
    expect(await setVectorSyncTarget(ok.rpc, 'weaviate', true, ADMIN_ID)).toEqual({ target: 'weaviate', enabled: true, tenantsEnqueued: 2 });
    expect(ok.calls).toEqual([{ fn: 'rag_vector_sync_set_target', args: { p_target: 'weaviate', p_enabled: true, p_actor: ADMIN_ID } }]);
    await expect(setVectorSyncTarget(stub(null, { code: '22023' }).rpc, 'qdrant', false, ADMIN_ID)).rejects.toMatchObject({ code: '22023' });
    const none = stub(1);
    await expect(setVectorSyncTarget(none.rpc, 'qdrant', true, ' ')).rejects.toMatchObject({ code: 'actor_required' });
    await expect(setVectorSyncTarget(none.rpc, 'pinecone' as never, true, ADMIN_ID)).rejects.toMatchObject({ code: 'invalid_target' });
    expect(none.calls).toEqual([]);
  });
});

describe('/api/rag/admin/vector-sync/targets', () => {
  test('is a nodejs route', async () => {
    expect((await load()).runtime).toBe('nodejs');
  });

  test('non-admin callers get 401 or 403 on GET and PUT and nothing is called', async () => {
    const route = await load();
    expect((await get(route, 'none')).status).toBe(401);
    expect((await get(route, 'forged')).status).toBe(401);
    expect((await get(route, 'user')).status).toBe(403);
    expect((await put(route, 'none', { target: 'qdrant', enabled: true })).status).toBe(401);
    expect((await put(route, 'user', { target: 'qdrant', enabled: true })).status).toBe(403);
    harness.guardAvailable = false;
    expect((await put(route, 'admin', { target: 'qdrant', enabled: true })).status).toBe(503);
    expect(harness.rpcCalls).toEqual([]);
  });

  test('GET returns both targets with their enabled flag to an admin', async () => {
    const route = await load();
    const response = await get(route, 'admin');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      targets: [
        { target: 'weaviate', enabled: false },
        { target: 'qdrant', enabled: true },
      ],
    });
  });

  test('PUT enables a target with the admin id as actor and returns the enqueued tenant count', async () => {
    const route = await load();
    const response = await put(route, 'admin', { target: 'qdrant', enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, target: 'qdrant', enabled: true, tenantsEnqueued: 3 });
    expect(harness.rpcCalls).toEqual([{ fn: 'rag_vector_sync_set_target', args: { p_target: 'qdrant', p_enabled: true, p_actor: ADMIN_ID } }]);
  });

  test('PUT with an unknown target, a missing field, a wrong type, an extra key or bad JSON is 400 with details; nothing is called', async () => {
    const route = await load();
    for (const body of [
      { target: 'pgvector', enabled: true },
      { target: 'qdrant' },
      { enabled: false },
      { target: 'qdrant', enabled: 'true' },
      { target: 'qdrant', enabled: true, actor: 'someone-else' },
    ]) {
      const response = await put(route, 'admin', body);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(Array.isArray(json.details)).toBe(true);
    }
    expect((await put(route, 'admin', '{not json')).status).toBe(400);
    expect(harness.rpcCalls).toEqual([]);
  });

  test('an RPC error is 500 with a generic message and a [RAG Admin] log with the code only', async () => {
    harness.outcomes.rag_vector_sync_set_target = { data: null, error: { code: '42501', message: 'permission denied: detail text' } };
    harness.outcomes.rag_vector_sync_status = { data: null, error: { code: '42883', message: 'function missing: detail text' } };
    const route = await load();
    const set = await put(route, 'admin', { target: 'weaviate', enabled: false });
    expect(set.status).toBe(500);
    expect(await set.json()).toEqual({ success: false, error: 'vector_sync_targets_failed' });
    const read = await get(route, 'admin');
    expect(read.status).toBe(500);
    const lines = harness.logged.filter((line) => line.startsWith('[RAG Admin]'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('42501');
    expect(lines[1]).toContain('42883');
    expect(harness.logged.join('\n')).not.toContain('detail text');
  });

  test('the service-role client unavailable: 503 after the guard, nothing called', async () => {
    harness.rpcAvailable = false;
    const route = await load();
    expect((await get(route, 'admin')).status).toBe(503);
    expect((await put(route, 'admin', { target: 'qdrant', enabled: true })).status).toBe(503);
  });
});
