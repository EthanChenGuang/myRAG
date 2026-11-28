import type { PGlite } from '@electric-sql/pglite';
import type { FakeEdge } from './fake-edge.mts';
import { withIsolatedTenant, type IsolatedFixtureTenant } from './q62-fixtures.mts';

type DeploymentMode = 'single-tenant' | 'multi-tenant';

export interface ScopeGateFixture {
  /** Tenants whose centroids were built, with their chunk counts per group kind. */
  built: { tenant: string; centroids: number }[];
  /** Loads the served tenant's snapshot into the in-process cache, so the gate scores the request instead of answering no_snapshot. */
  prime: (userId: string | null) => Promise<void>;
}

/**
 * Plan 06.2-26: with RAG_SCOPE_GATE effective, a fixture run builds the scope centroids of every fixture database (home, q62,
 * dominant-language) and primes the snapshot before each request. Every isolated tenant is a separate database behind the same tenant
 * key in single-tenant mode, so the cached snapshot of one would otherwise score the items of another. Off: nothing is built.
 */
export async function prepareScopeGateFixture(input: {
  edge: FakeEdge;
  homeDb: PGlite;
  deploymentMode: DeploymentMode;
  fixtureUserId: string;
  isolated: { name: string; tenant: IsolatedFixtureTenant; userId: string }[];
}): Promise<ScopeGateFixture | null> {
  const { loadRagConfig, scopeGateEnabledFor } = await import('../../src/lib/rag/config.ts');
  const { getRagDeps } = await import('../../src/lib/rag/deps.ts');
  const config = loadRagConfig(getRagDeps().ragEnv());
  if (config.pipeline !== 'v2' || !scopeGateEnabledFor(config, 'eval')) return null;
  const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
  const { rebuildScopeCentroids, scopeProfile } = await import('../../src/lib/rag/scope/build.ts');
  const { refreshCentroidSnapshot } = await import('../../src/lib/rag/scope/centroids.ts');
  const profile = await scopeProfile();
  const scopeFor = (userId: string | null) =>
    input.deploymentMode === 'multi-tenant' ? mintScope('personal', userId ?? input.fixtureUserId, null) : mintScope('single', null, null);
  const built: ScopeGateFixture['built'] = [];
  const build = async (name: string, userId: string) => {
    const result = await rebuildScopeCentroids(scopeFor(userId), { profile });
    built.push({ tenant: name, centroids: Object.values(result.counts).reduce((sum, entry) => sum + entry.groups, 0) });
  };
  await build('home', input.fixtureUserId);
  for (const entry of input.isolated) {
    await withIsolatedTenant(input.edge, input.homeDb, entry.tenant, () => build(entry.name, entry.userId));
  }
  return {
    built,
    prime: async (userId) => {
      await refreshCentroidSnapshot(scopeFor(userId), profile.id);
    },
  };
}
