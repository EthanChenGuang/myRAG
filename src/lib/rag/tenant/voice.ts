import type { MembershipDb } from './membership';
import type { TenantScope } from './scope';

export const VOICE_SCOPE_HEADER = 'x-rag-scope-token';

export type VoiceScopeResult =
  | { ok: true; scope: TenantScope }
  | { ok: false; status: 401 | 403 | 503; reason: string };

export interface ResolveVoiceScopeInput {
  headers: { get(name: string): string | null };
  deploymentMode?: 'single-tenant' | 'multi-tenant';
  secret?: string;
  admin?: MembershipDb | null;
  signal: AbortSignal;
  now?: number;
}

export async function resolveVoiceScope(_input: ResolveVoiceScopeInput): Promise<VoiceScopeResult> {
  return { ok: false, status: 503, reason: 'not_implemented' };
}
