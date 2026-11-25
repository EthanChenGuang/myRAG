import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isAdminUser, requireRagAdmin, type RagAdminDb, type RagAdminResult } from '@/lib/rag';

export const ADMIN_SESSION_COOKIE = 'admin_session';
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const KEY_LABEL = 'myrag-admin-session-v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signingKey(serviceKey: string | undefined): Buffer | null {
  let secret: string | undefined;
  try {
    secret = serviceKey ?? env.SUPABASE_SERVICE_ROLE_KEY;
  } catch {
    return null;
  }
  if (!secret) return null;
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function sign(key: Buffer, userId: string, expiry: number): string {
  return createHmac('sha256', key).update(`${userId}.${expiry}`).digest('base64url');
}

export function mintAdminSessionValue(
  userId: string,
  opts: { nowMs?: number; serviceKey?: string } = {},
): string | null {
  const key = signingKey(opts.serviceKey);
  if (!key || !UUID_RE.test(userId)) return null;
  const id = userId.toLowerCase();
  const expiry = Math.floor((opts.nowMs ?? Date.now()) / 1000) + ADMIN_SESSION_MAX_AGE_SECONDS;
  return `${id}.${expiry}.${sign(key, id, expiry)}`;
}

export function verifyAdminSessionValue(
  value: string | null | undefined,
  opts: { nowMs?: number; serviceKey?: string } = {},
): { userId: string } | null {
  if (!value) return null;
  const key = signingKey(opts.serviceKey);
  if (!key) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiryText, signature] = parts;
  if (!UUID_RE.test(userId) || !/^\d{1,12}$/.test(expiryText)) return null;
  const expiry = Number(expiryText);
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (expiry <= nowSeconds || expiry > nowSeconds + ADMIN_SESSION_MAX_AGE_SECONDS) return null;
  const expected = Buffer.from(sign(key, userId.toLowerCase(), expiry));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { userId: userId.toLowerCase() };
}

export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export interface AdminSessionCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

export function adminSessionCookieOptions(): AdminSessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  };
}

interface AdminCookieAuthInput {
  headers: Headers;
  admin?: RagAdminDb | null;
  signal: AbortSignal;
  nowMs?: number;
  serviceKey?: string;
  getCookieUser?: () => Promise<{ id: string } | null>;
}

async function currentSessionUser(): Promise<{ id: string } | null> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ? { id: data.user.id } : null;
}

/**
 * A valid signed admin_session cookie, presented together with a live Supabase session for the same user,
 * whose user is still in admin_users right now. The cookie alone is never enough, so signing out of Supabase
 * ends the admin capability at once. A missing, tampered or expired cookie gives 401, and so does a missing or
 * different session; the admin_users row is looked up on every call.
 */
export async function requireAdminCookie(input: AdminCookieAuthInput): Promise<RagAdminResult> {
  const verified = verifyAdminSessionValue(readCookie(input.headers, ADMIN_SESSION_COOKIE), input);
  if (!verified) return { ok: false, status: 401, reason: 'no_admin_session' };
  let sessionUser: { id: string } | null;
  try {
    sessionUser = await (input.getCookieUser ?? currentSessionUser)();
  } catch {
    return { ok: false, status: 503, reason: 'auth_unavailable' };
  }
  if (!sessionUser) return { ok: false, status: 401, reason: 'no_session' };
  if (String(sessionUser.id).toLowerCase() !== verified.userId) return { ok: false, status: 401, reason: 'session_mismatch' };
  const admin = input.admin === undefined ? (getSupabaseAdmin() as RagAdminDb | null) : input.admin;
  if (!admin) return { ok: false, status: 503, reason: 'admin_check_unavailable' };
  try {
    if (!(await isAdminUser(admin, verified.userId, input.signal))) {
      return { ok: false, status: 403, reason: 'not_admin' };
    }
  } catch {
    return { ok: false, status: 503, reason: 'admin_check_unavailable' };
  }
  return { ok: true, userId: verified.userId };
}

const COOKIE_NOT_USABLE = new Set(['no_admin_session', 'no_session', 'session_mismatch']);

/** requireRagAdmin, or a valid signed admin cookie plus a matching live session whose user is still an admin. */
export async function requireAdminRequest(input: AdminCookieAuthInput): Promise<RagAdminResult> {
  let userPromise: Promise<{ id: string } | null> | null = null;
  const getCookieUser = () => {
    userPromise ??= (input.getCookieUser ?? currentSessionUser)();
    return userPromise;
  };
  const viaCookie = await requireAdminCookie({ ...input, getCookieUser });
  if (viaCookie.ok || !COOKIE_NOT_USABLE.has(viaCookie.reason)) return viaCookie;
  return requireRagAdmin({
    headers: input.headers,
    getCookieUser,
    admin: input.admin,
    signal: input.signal,
  });
}
