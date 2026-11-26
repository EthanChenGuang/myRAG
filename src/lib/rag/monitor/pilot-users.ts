import type { SupabaseClient } from '@supabase/supabase-js';
import rawMonitorAlerts from '../../../../eval/config/monitor-alerts.json';

/**
 * Pilot users of one tenant (D-52): their production questions are sampled at a higher weight. The tenant key always comes from the
 * caller's server-side admission; the user is resolved inside that tenant by rag_pilot_user_resolve (0977) before rag_pilot_user_add
 * (0970) runs, so a user of another workspace is indistinguishable from an unknown one. E-mail addresses leave this module masked only.
 */

export type PilotUsersDb = Pick<SupabaseClient, 'rpc'>;

export interface PilotUserEntry {
  user_id: string;
  masked_email: string | null;
  added_at: string;
}

export interface PilotUserPage {
  users: PilotUserEntry[];
  next_cursor: string | null;
}

export type AddPilotUserResult = { ok: true; user: PilotUserEntry } | { ok: false; reason: 'user_not_found' | 'already_pilot' };

export interface PilotSamplingParams {
  weight: number;
  cap_share: number;
}

export class PilotUsersError extends Error {
  constructor(readonly code: string) {
    super(`[Monitor] pilot users failed (${code})`);
    this.name = 'PilotUsersError';
  }
}

export const PILOT_PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODE_RE = /^[A-Za-z0-9_]{1,32}$/;
const MASK_LOCAL = '•••';
const MASK_DOMAIN = '••••••';

function fail(error: { code?: unknown } | null | undefined): PilotUsersError {
  const code = typeof error?.code === 'string' && ERROR_CODE_RE.test(error.code) ? error.code : 'unknown';
  return new PilotUsersError(code);
}

/**
 * The first character of the local part and of the domain, then the top-level domain; fixed-length masks, so the length of the
 * address is not shown either. Anything that is not an address with a dotted domain gives null.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => label === '')) return null;
  const tld = (labels[labels.length - 1] as string).toLowerCase();
  if (!/^[a-z0-9-]{2,63}$/.test(tld)) return null;
  return `${Array.from(local)[0]}${MASK_LOCAL}@${Array.from(domain)[0]}${MASK_DOMAIN}.${tld}`;
}

/** The pilot weight multiplier and cap share of eval/config/monitor-alerts.json, or null when the block does not hold them. */
export function pilotSamplingParams(raw: unknown = rawMonitorAlerts): PilotSamplingParams | null {
  const sampling = (raw as { sampling?: Record<string, unknown> } | null)?.sampling;
  const weight = sampling?.pilot_multiplier;
  const share = sampling?.pilot_cap_share;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 1) return null;
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) return null;
  return { weight, cap_share: share };
}

function encodeCursor(entry: { added_at: string; user_id: string }): string {
  return Buffer.from(`${entry.added_at}|${entry.user_id}`, 'utf8').toString('base64url');
}

/** The (added_at, user_id) of a cursor this module issued, or null for anything else. */
export function decodePilotCursor(cursor: string): { addedAt: string; userId: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const [addedAt, userId, ...rest] = text.split('|');
  if (rest.length > 0 || !addedAt || !userId || !UUID_RE.test(userId) || Number.isNaN(Date.parse(addedAt))) return null;
  return { addedAt, userId: userId.toLowerCase() };
}

function asEntry(row: Record<string, unknown>): PilotUserEntry {
  return {
    user_id: String(row.user_id),
    masked_email: maskEmail(typeof row.email === 'string' ? row.email : null),
    added_at: String(row.added_at),
  };
}

/** Newest first, PILOT_PAGE_SIZE per page; `cursor` is the next_cursor of the previous page. */
export async function listPilotUsers(admin: PilotUsersDb, tenantKey: string, cursor?: { addedAt: string; userId: string } | null): Promise<PilotUserPage> {
  const { data, error } = await admin.rpc('rag_pilot_users_list', {
    p_tenant_key: tenantKey,
    p_limit: PILOT_PAGE_SIZE + 1,
    p_before_added_at: cursor?.addedAt ?? null,
    p_before_user_id: cursor?.userId ?? null,
  });
  if (error) throw fail(error);
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  const users = rows.slice(0, PILOT_PAGE_SIZE).map(asEntry);
  const last = rows.length > PILOT_PAGE_SIZE ? (rows[PILOT_PAGE_SIZE - 1] as Record<string, unknown>) : null;
  return { users, next_cursor: last ? encodeCursor({ added_at: String(last.added_at), user_id: String(last.user_id) }) : null };
}

async function entryOf(admin: PilotUsersDb, tenantKey: string, userId: string): Promise<PilotUserEntry> {
  let cursor: { addedAt: string; userId: string } | null = null;
  for (;;) {
    const page = await listPilotUsers(admin, tenantKey, cursor);
    const hit = page.users.find((entry) => entry.user_id === userId);
    if (hit) return hit;
    const next = page.next_cursor ? decodePilotCursor(page.next_cursor) : null;
    if (!next) return { user_id: userId, masked_email: null, added_at: new Date().toISOString() };
    cursor = next;
  }
}

/** Resolves `user` (an e-mail address or a user id) inside the tenant, then adds it. */
export async function addPilotUser(
  admin: PilotUsersDb,
  input: { tenantKey: string; user: string; actorUserId: string | null },
): Promise<AddPilotUserResult> {
  const resolved = await admin.rpc('rag_pilot_user_resolve', { p_tenant_key: input.tenantKey, p_user: input.user });
  if (resolved.error) throw fail(resolved.error);
  const userId = typeof resolved.data === 'string' && UUID_RE.test(resolved.data) ? resolved.data.toLowerCase() : null;
  if (!userId) return { ok: false, reason: 'user_not_found' };
  const added = await admin.rpc('rag_pilot_user_add', { p_tenant_key: input.tenantKey, p_user_id: userId, p_actor: input.actorUserId });
  if (added.error) throw fail(added.error);
  if (added.data !== true) return { ok: false, reason: 'already_pilot' };
  return { ok: true, user: await entryOf(admin, input.tenantKey, userId) };
}

/** True when the tenant had that pilot user. */
export async function removePilotUser(admin: PilotUsersDb, input: { tenantKey: string; userId: string }): Promise<boolean> {
  if (!UUID_RE.test(input.userId)) return false;
  const { data, error } = await admin.rpc('rag_pilot_user_remove', { p_tenant_key: input.tenantKey, p_user_id: input.userId.toLowerCase() });
  if (error) throw fail(error);
  return data === true;
}
