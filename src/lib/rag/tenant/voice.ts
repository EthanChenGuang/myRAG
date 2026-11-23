import { env } from '@/lib/env';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { getRagDeps } from '../deps';
import { parseTenantKey } from './embed';
import { isOrganizationMember, type MembershipDb } from './membership';
import { mintScope, type TenantScope } from './scope';
import { verifyVoiceToken } from './voice-token';

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
  /** Epoch milliseconds; defaults to the current time. */
  now?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(hasToken: boolean, status: 401 | 403 | 503, reason: string): VoiceScopeResult {
  console.warn('[RAG Tenant] voice scope refused', { hasToken, reason });
  return { ok: false, status, reason };
}

function normaliseId(value: string | null): string | null | undefined {
  if (value === null) return null;
  return UUID_RE.test(value) ? value.toLowerCase() : undefined;
}

/**
 * The only way a voice request obtains a scope: a server-signed, unexpired token from the
 * x-rag-scope-token header whose organization membership still holds. A bare userId never counts.
 */
export async function resolveVoiceScope(input: ResolveVoiceScopeInput): Promise<VoiceScopeResult> {
  const token = input.headers.get(VOICE_SCOPE_HEADER);
  if (!token) return refuse(false, 401, 'missing_token');

  const verified = verifyVoiceToken(token, { secret: input.secret ?? env.RAG_VOICE_TOKEN_SECRET, now: input.now });
  if (!verified.ok) return refuse(true, verified.status, verified.reason);
  const { payload } = verified;

  const key = parseTenantKey(payload.tk);
  const uid = normaliseId(payload.uid);
  const oid = normaliseId(payload.oid);
  if (!key || uid === undefined || oid === undefined) return refuse(true, 401, 'bad_scope');

  const mode = input.deploymentMode ?? getDeploymentMode();
  if ((mode === 'multi-tenant') === (key.kind === 'single')) return refuse(true, 401, 'mode_mismatch');

  if (key.kind === 'single') {
    if (oid !== null) return refuse(true, 401, 'bad_scope');
    return { ok: true, scope: mintScope('single', null, null) };
  }

  if (key.kind === 'personal') {
    if (oid !== null || uid !== key.userId) return refuse(true, 401, 'bad_scope');
    return { ok: true, scope: mintScope('personal', key.userId, null) };
  }

  if (oid !== key.organizationId || uid === null) return refuse(true, 401, 'bad_scope');
  const admin = input.admin === undefined ? getRagDeps().adminClient() : input.admin;
  if (!admin) return refuse(true, 503, 'membership_unavailable');
  let member: boolean;
  try {
    member = await isOrganizationMember(admin, key.organizationId, uid, input.signal);
  } catch {
    return refuse(true, 503, 'membership_unavailable');
  }
  if (!member) return refuse(true, 403, 'not_a_member');
  return { ok: true, scope: mintScope('org', uid, key.organizationId) };
}
