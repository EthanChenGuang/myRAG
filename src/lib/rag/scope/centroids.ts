import type { TenantScope } from '../tenant/scope';

export const SCOPE_CENTROID_CACHE_TTL_MS = 60_000;

export type ScopeGroupKind = 'doc_type' | 'scope_tag' | 'tenant';

export interface ScopeCentroid {
  kind: ScopeGroupKind;
  key: string;
  memberCount: number;
  vector: Float32Array;
}

export interface CentroidSnapshot {
  tenantKey: string;
  profileId: string;
  dims: number;
  centroids: readonly ScopeCentroid[];
  examples: readonly Float32Array[];
  unsupported: boolean;
  loadedAt: number;
}

export function getCentroidSnapshot(_scope: TenantScope, _profileId: string): CentroidSnapshot | null {
  return null;
}

export function invalidateCentroidCache(_scope: TenantScope): void {}

export async function centroidRefreshesSettledForTests(): Promise<void> {}

export function resetCentroidCacheForTests(): void {}
