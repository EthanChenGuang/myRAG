/** Plan 03.3-23 stub (RED): layering and seeding are not built yet. */
import type { PGlite } from '@electric-sql/pglite';
import type { TenantScope } from '../../src/lib/rag/tenant/scope.ts';

export const PHASE33_PROCESS_SWITCHES: readonly string[] = [];

export function phase33BuildEnv(_runEnv: Record<string, string | undefined> | undefined): Record<string, string> {
  return {};
}

export function phase33ProcessEnv(_buildEnv: Record<string, string> | undefined): Record<string, string> {
  return {};
}

export function phase33SeedParts(_buildEnv: Record<string, string> | undefined): string[] {
  return [];
}

export async function seedTemplatedTenant(_options: {
  db: PGlite;
  scope: TenantScope;
  fixtureUserId: string;
  deploymentMode: 'single-tenant' | 'multi-tenant';
  buildEnv: Record<string, string> | undefined;
}): Promise<{ files: string[] }> {
  return { files: [] };
}
