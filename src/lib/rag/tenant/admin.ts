import type { SupabaseClient } from '@supabase/supabase-js';
import { getRagDeps } from '../deps';

export type RagAdminDb = Pick<SupabaseClient, 'from' | 'auth'>;

export type RagAdminResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403 | 503; reason: string };

export interface RequireRagAdminInput {
  headers: Headers;
  getCookieUser?: () => Promise<{ id: string } | null>;
  admin?: RagAdminDb | null;
  signal: AbortSignal;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_RE = /^Bearer\s+(\S+)$/i;

function refuse(status: 401 | 403 | 503, reason: string): RagAdminResult {
  console.warn('[RAG Admin] admin request refused', { reason });
  return { ok: false, status, reason };
}

async function sessionUser(): Promise<{ id: string } | null> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ? { id: data.user.id } : null;
}

/**
 * Looks the user up in admin_users on every call; nothing is cached, so removing a row revokes access at once.
 * Returns false for a non-member and throws on a query failure.
 */
export async function isAdminUser(admin: RagAdminDb, userId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const { data, error } = await admin
    .from('admin_users')
    .select('id')
    .eq('id', userId)
    .abortSignal(signal)
    .maybeSingle();
  signal.throwIfAborted();
  if (error) throw new Error('[RAG Admin] admin_users query failed');
  return data !== null && data !== undefined;
}

/**
 * Fail-closed admin guard. The caller is a verified Supabase user (SSR cookie session, or a Bearer access
 * token validated by auth.getUser) whose id is in admin_users. A cookie or token value is never read as a user id.
 */
export async function requireRagAdmin(input: RequireRagAdminInput): Promise<RagAdminResult> {
  const admin = input.admin === undefined ? getRagDeps().adminClient() : input.admin;

  let userId: string;
  const authorization = input.headers.get('authorization');
  if (authorization !== null) {
    const match = BEARER_RE.exec(authorization.trim());
    if (!match || match[1] === 'admin') return refuse(401, 'invalid_session');
    if (!admin) return refuse(503, 'admin_check_unavailable');
    try {
      const { data, error } = await admin.auth.getUser(match[1]);
      if (error || !data?.user?.id) return refuse(401, 'invalid_session');
      userId = data.user.id;
    } catch {
      return refuse(503, 'auth_unavailable');
    }
  } else {
    let user: { id: string } | null;
    try {
      user = await (input.getCookieUser ?? sessionUser)();
    } catch {
      return refuse(503, 'auth_unavailable');
    }
    if (!user) return refuse(401, 'no_session');
    userId = user.id;
  }

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return refuse(401, 'invalid_session');
  userId = userId.toLowerCase();

  if (!admin) return refuse(503, 'admin_check_unavailable');
  let member: boolean;
  try {
    member = await isAdminUser(admin, userId, input.signal);
  } catch {
    return refuse(503, 'admin_check_unavailable');
  }
  if (!member) return refuse(403, 'not_admin');
  return { ok: true, userId };
}
