import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../eval/harness/two-tenant.mts';

const QUERY = 'two tenant isolation canary phrase';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

describe('two-tenant retrieval through resolved scopes and the real SQL', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let supabaseModule: typeof import('@/lib/supabase');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    scopeModule = await import('@/lib/rag/tenant/scope');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  const resolve = (userId: string | null, organizationId: string | null) =>
    resolver.resolveTenantScope({
      requestedOrganizationId: organizationId,
      deploymentMode: 'multi-tenant',
      getUser: async () => (userId ? { id: userId } : null),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });

  const retrieve = async (scope: Awaited<ReturnType<typeof resolve>>) => {
    assert.ok(scope.ok, 'scope must resolve');
    return rag.runRetrieval({
      scope: scope.scope,
      query: QUERY,
      profile: 'eval',
      options: OPTIONS,
      signal: new AbortController().signal,
    });
  };

  const chunkIds = (result: Awaited<ReturnType<typeof retrieve>>) => result.candidates.map((candidate) => candidate.chunk_id).sort();

  test('user A in personal scope retrieves only A personal chunk', async () => {
    const resolved = await resolve(TWO_TENANT_IDS.userA, null);
    assert.ok(resolved.ok && resolved.scope);
    assert.equal(scopeModule.scopeKey(resolved.scope), `u:${TWO_TENANT_IDS.userA}`);
    const result = await retrieve(resolved);
    assert.deepEqual(chunkIds(result), [TWO_TENANT_IDS.chunkA]);
  });

  test('user A in organization O retrieves only the organization chunk', async () => {
    const resolved = await resolve(TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO);
    assert.ok(resolved.ok && resolved.scope);
    assert.equal(scopeModule.scopeKey(resolved.scope), `o:${TWO_TENANT_IDS.orgO}`);
    const result = await retrieve(resolved);
    assert.deepEqual(chunkIds(result), [TWO_TENANT_IDS.chunkO]);
  });

  test('an uppercase organization id resolves to the same organization chunk', async () => {
    const resolved = await resolve(TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO.toUpperCase());
    assert.ok(resolved.ok && resolved.scope);
    assert.equal(scopeModule.scopeKey(resolved.scope), `o:${TWO_TENANT_IDS.orgO}`);
    const result = await retrieve(resolved);
    assert.deepEqual(chunkIds(result), [TWO_TENANT_IDS.chunkO]);
  });

  test('user B in personal scope retrieves only B personal chunk', async () => {
    const resolved = await resolve(TWO_TENANT_IDS.userB, null);
    assert.ok(resolved.ok && resolved.scope);
    const result = await retrieve(resolved);
    assert.deepEqual(chunkIds(result), [TWO_TENANT_IDS.chunkB]);
  });

  test('user B can never obtain the scope of organization O', async () => {
    const calls = edge.calls.length;
    const resolved = await resolve(TWO_TENANT_IDS.userB, TWO_TENANT_IDS.orgO);
    assert.deepEqual(resolved, { ok: false, status: 403, reason: 'not_a_member' });
    assert.equal(edge.calls.length - calls, 1);
  });

  test('no session gives no scope and retrieval issues no RPC', async () => {
    const resolved = await resolve(null, TWO_TENANT_IDS.orgO);
    assert.deepEqual(resolved, { ok: true, scope: null, reason: 'no_tenant' });
    const calls = edge.calls.length;
    const result = await rag.runRetrieval({ scope: null, query: QUERY, profile: 'eval', signal: new AbortController().signal });
    assert.equal(result.status, 'empty');
    assert.equal(result.reason, 'no_tenant');
    assert.equal(edge.calls.length, calls);
    assert.deepEqual(edge.errors, []);
  });
});
