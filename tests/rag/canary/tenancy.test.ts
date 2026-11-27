import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId, type RankedHit } from '@/lib/rag/backend/types';
import { CANARY_SENTENCE, LEGACY_PROFILE, canaryBackends, createCanaryEnv, foreignMarkers, isExternalBackend, leaked, type CanaryEnv, type CanaryLabel } from './factory';

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 180_000;

function silenceLogs(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function withMarker(hits: RankedHit[], marker: string): RankedHit[] {
  return hits.filter((hit) => hit.content.includes(marker));
}

/** The owner's own canary is on both legs (so an empty answer can never pass as isolation) and was served by the backend under test. */
async function expectOwnCanary(env: CanaryEnv, label: CanaryLabel): Promise<void> {
  const tenant = env.tenants[label]!;
  const result = await env.search(tenant.scope, CANARY_SENTENCE);
  expect(result.selection.backend, `${label}: served by ${env.backend}`).toBe(env.backend);
  expect(result.selection.fallbackReason).toBeNull();
  expect(withMarker(result.legs.dense, tenant.marker).length, `${label}: own canary on the dense leg`).toBeGreaterThan(0);
  expect(withMarker(result.legs.lexical, tenant.marker).length, `${label}: own canary on the lexical leg`).toBeGreaterThan(0);
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  describe.runIf(ENABLED.includes(backend))(`cross-tenant canary, multi-tenant (${backend})`, () => {
    let env: CanaryEnv;

    beforeAll(async () => {
      env = await createCanaryEnv(backend, 'multi-tenant');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await env?.close();
    });

    beforeEach(silenceLogs);

    it('personal versus organization: each scope sees only its own canary on both legs, for the shared sentence and for every marker', async () => {
      for (const label of ['a', 'b', 'o'] as const) await expectOwnCanary(env, label);
      for (const label of ['a', 'b', 'o', 'm'] as const) {
        const tenant = env.tenants[label]!;
        const foreign = foreignMarkers(env, label);
        const foreignChunks = Object.values(env.tenants)
          .filter((other) => other && other.label !== label)
          .flatMap((other) => other!.chunkIds);
        for (const query of [CANARY_SENTENCE, ...foreign.map((marker) => `${CANARY_SENTENCE} ${marker}`), ...foreign]) {
          const result = await env.search(tenant.scope, query);
          expect(leaked(result.legs.dense, foreign, foreignChunks), `${label} dense leg, query "${query}"`).toEqual([]);
          expect(leaked(result.legs.lexical, foreign, foreignChunks), `${label} lexical leg, query "${query}"`).toEqual([]);
        }
      }
    });

    it('null organization: a personal document with organization_id null is visible only to its owner', async () => {
      const a = env.tenants.a!;
      const rows = await env.sql<{ organization_id: string | null; user_id: string }>('SELECT organization_id, user_id FROM public.documents WHERE id = $1', [a.documentId]);
      expect(rows).toEqual([{ organization_id: null, user_id: env.ids.userA }]);
      await expectOwnCanary(env, 'a');
      for (const label of ['b', 'o', 'm'] as const) {
        const result = await env.search(env.tenants[label]!.scope, `${CANARY_SENTENCE} ${a.marker}`);
        expect(leaked(result.hits, [a.marker], a.chunkIds), `${label} never sees a's personal document`).toEqual([]);
      }
    });

    it('a scope whose tenant has no data yet is served by pgvector with degraded backend_not_ready', async () => {
      const result = await env.search(env.tenants.m!.scope, CANARY_SENTENCE);
      expect(result.hits).toEqual([]);
      if (isExternalBackend(backend)) {
        expect(result.selection).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_not_ready', degraded: true });
      } else {
        expect(result.selection).toMatchObject({ backend: 'pgvector', fallbackReason: null, degraded: false });
      }
    });

    it.runIf(backend === 'weaviate')('Weaviate rejects an untenanted raw query against the multi-tenant collection', async () => {
      const { weaviateCollectionName } = await import('@/lib/rag/backend/tenant-key');
      const base = (process.env.WEAVIATE_URL ?? '').replace(/\/+$/, '');
      const readKey = process.env.WEAVIATE_READ_API_KEY ?? '';
      const collection = weaviateCollectionName(LEGACY_PROFILE);
      const untenanted = await fetch(`${base}/v1/objects?class=${encodeURIComponent(collection)}&limit=5`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      const body = await untenanted.text();
      expect(untenanted.status, body).toBeGreaterThanOrEqual(400);
      expect(body.toLowerCase()).toContain('tenant');
      const graph = await fetch(`${base}/v1/graphql`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${readKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ Get { ${collection}(limit: 5) { _additional { id } } } }` }),
      });
      const answer = (await graph.json()) as { data?: Record<string, Record<string, unknown[] | null>>; errors?: Array<{ message: string }> };
      expect(answer.errors?.length ?? 0, 'the GraphQL Get without a tenant is an error').toBeGreaterThan(0);
      expect(JSON.stringify(answer.errors).toLowerCase()).toContain('tenant');
      expect(answer.data?.Get?.[collection] ?? null).toBeNull();
    });

    // Last in the file: it removes M from the organization.
    it('removed member: after removal M can no longer mint the organization scope, and M personal scope never returns the organization canary', async () => {
      const { resolveTenantScope } = await import('@/lib/rag/tenant/resolve-chat');
      const { createClient } = await import('@supabase/supabase-js');
      const { fixtureProcessEnv } = await import('../../../eval/harness/fake-edge.mts');
      const admin = createClient(env.edge.url, fixtureProcessEnv(env.edge.url).SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const mint = () =>
        resolveTenantScope({
          deploymentMode: 'multi-tenant',
          getUser: async () => ({ id: env.ids.userM }),
          requestedOrganizationId: env.ids.orgO,
          admin,
          signal: new AbortController().signal,
        });
      const o = env.tenants.o!;

      const before = await mint();
      expect(before).toMatchObject({ ok: true });
      expect(before.ok && before.scope).toEqual(o.scope);
      await expectOwnCanary(env, 'o');

      await env.sql('DELETE FROM public.organization_members WHERE organization_id = $1 AND user_id = $2', [env.ids.orgO, env.ids.userM]);
      const after = await mint();
      expect(after).toMatchObject({ ok: false, reason: 'not_a_member' });

      for (const query of [CANARY_SENTENCE, `${CANARY_SENTENCE} ${o.marker}`, o.marker]) {
        const result = await env.search(env.tenants.m!.scope, query);
        expect(leaked(result.hits, [o.marker], o.chunkIds), `M personal scope, query "${query}"`).toEqual([]);
      }
    });
  });

  describe.runIf(ENABLED.includes(backend))(`cross-tenant canary, single-tenant (${backend})`, () => {
    let env: CanaryEnv;

    beforeAll(async () => {
      env = await createCanaryEnv(backend, 'single-tenant');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await env?.close();
    });

    beforeEach(silenceLogs);

    it('s:default sees its documents on both legs through the backend under test', async () => {
      const s = env.tenants.s!;
      expect(s.tenantKey).toBe('s:default');
      await expectOwnCanary(env, 's');
      if (env.store) expect(await env.store.count(LEGACY_PROFILE, 's:default')).toBe(s.chunkIds.length);
    });

    it.runIf(backend === 'weaviate')('on Weaviate the single tenant is s_default', async () => {
      const { weaviateTenantName, weaviateCollectionName } = await import('@/lib/rag/backend/tenant-key');
      expect(weaviateTenantName('s:default')).toBe('s_default');
      const base = (process.env.WEAVIATE_URL ?? '').replace(/\/+$/, '');
      const response = await fetch(`${base}/v1/schema/${encodeURIComponent(weaviateCollectionName(LEGACY_PROFILE))}/tenants`, {
        headers: { Authorization: `Bearer ${process.env.WEAVIATE_API_KEY ?? ''}` },
      });
      expect(response.status).toBe(200);
      const names = ((await response.json()) as Array<{ name: string }>).map((tenant) => tenant.name);
      expect(names).toContain('s_default');
      expect(names).not.toContain('s:default');
    });
  });
}
