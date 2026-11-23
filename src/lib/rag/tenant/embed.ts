import type { MembershipDb } from './membership';
import type { TenantScope } from './scope';

export type TenantKey =
  | { kind: 'single' }
  | { kind: 'org'; organizationId: string }
  | { kind: 'personal'; userId: string };

export type EmbedScopeFailure =
  | { ok: false; status: 403 | 503; reason: string }
  | {
      ok: false;
      status: 'retrieval_error';
      reason: 'embed_tenant_unconfigured' | 'embed_tenant_unknown' | 'embed_tenant_invalid';
    };

export type EmbedScopeResult = { ok: true; scope: TenantScope } | EmbedScopeFailure;

export interface ResolveEmbedScopeInput {
  rawBody: unknown;
  configuredTenant?: string;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
  admin?: MembershipDb | null;
  signal: AbortSignal;
}

export function parseTenantKey(_value: unknown): TenantKey | null {
  return null;
}

export function resetEmbedTenantLogForTests(): void {}

export async function resolveEmbedScope(_input: ResolveEmbedScopeInput): Promise<EmbedScopeResult> {
  return { ok: false, status: 503, reason: 'not_implemented' };
}
