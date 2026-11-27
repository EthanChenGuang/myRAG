import type { EmbeddingProfile } from '../embeddings/active-profile';
import type { TenantScope } from '../tenant/scope';
import type { ScopeGroupKind } from './centroids';

export type ScopeRebuildCounts = Record<ScopeGroupKind, { groups: number; chunks: number }>;

export interface ScopeRebuildResult {
  tenantKey: string;
  profileId: string;
  counts: ScopeRebuildCounts;
  examples: { reembedded: number; skipped: number; failed: number };
  durationMs: number;
}

export interface ScopeRebuildOptions {
  profile?: EmbeddingProfile;
  signal?: AbortSignal;
  reembedExamples?: boolean;
}

export async function rebuildScopeCentroids(_scope: TenantScope, _options: ScopeRebuildOptions = {}): Promise<ScopeRebuildResult> {
  const empty = { groups: 0, chunks: 0 };
  return { tenantKey: '', profileId: '', counts: { doc_type: empty, scope_tag: empty, tenant: empty }, examples: { reembedded: 0, skipped: 0, failed: 0 }, durationMs: 0 };
}
