import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';

/** The 0943 readers of rag_uploader_holds; service role only, the tenant key is asserted in SQL. */
export const UPLOADER_HOLD_ACTIVE_RPC = 'rag_uploader_hold_active';
export const ACTIVE_UPLOADER_HOLDS_RPC = 'rag_active_uploader_holds';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[A-Za-z0-9_]{1,32}$/;
const MAX_USERS = 500;

export interface UploaderHoldOptions {
  /** Defaults to the admin client. */
  client?: RpcClient | null;
  signal?: AbortSignal;
  /** Called once when the check could not be answered; the caller records it on its trace. */
  onFailure?: (code: string) => void;
}

function uuidOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lowered = value.trim().toLowerCase();
  return UUID.test(lowered) ? lowered : null;
}

function clientOf(options: UploaderHoldOptions | undefined): RpcClient | null {
  if (options && 'client' in options) return options.client ?? null;
  try {
    return getRagDeps().adminClient() as unknown as RpcClient | null;
  } catch {
    return null;
  }
}

function codeOf(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }).code ?? (error as { name?: unknown }).name : null;
  return typeof code === 'string' && CODE.test(code) ? code : 'unknown';
}

async function rows(fn: string, args: Record<string, unknown>, options: UploaderHoldOptions | undefined): Promise<unknown[] | null> {
  const client = clientOf(options);
  const fail = (code: string, tenant: unknown) => {
    console.warn('[RAG Security] uploader hold check failed; treating as not held', { rpc: fn, tenant, code });
    options?.onFailure?.(code);
    return null;
  };
  if (!client) return fail('no_admin_client', args.p_tenant_key);
  try {
    let request = client.rpc(fn, args);
    if (options?.signal) request = request.abortSignal(options.signal);
    const response = await request;
    if (response.error) return fail(codeOf(response.error), args.p_tenant_key);
    return rpcRows(response.data);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    return fail(codeOf(error), args.p_tenant_key);
  }
}

/**
 * D-46: whether the user has an active hold in the tenant. No user (Pitfall 20) is never held and asks nothing. A check that cannot be
 * answered is not held, with one log line and onFailure, so a broken lookup never stops every upload.
 */
export async function uploaderHoldActive(tenantKey: string, userId: string | null | undefined, options?: UploaderHoldOptions): Promise<boolean> {
  const user = uuidOf(userId);
  if (user === null) return false;
  const answer = await rows(UPLOADER_HOLD_ACTIVE_RPC, { p_tenant_key: tenantKey, p_user_id: user }, options);
  if (answer === null) return false;
  const first = answer[0];
  if (typeof first === 'boolean') return first;
  if (first && typeof first === 'object') return (first as Record<string, unknown>)[UPLOADER_HOLD_ACTIVE_RPC] === true;
  return false;
}

/** D-46: the users among userIds with an active hold in the tenant, in one call; empty on a failure (logged once). */
export async function activeUploaderHolds(
  tenantKey: string,
  userIds: ReadonlyArray<string | null | undefined>,
  options?: UploaderHoldOptions,
): Promise<Set<string>> {
  const users = [...new Set(userIds.map(uuidOf).filter((id): id is string => id !== null))].slice(0, MAX_USERS);
  if (users.length === 0) return new Set();
  const answer = await rows(ACTIVE_UPLOADER_HOLDS_RPC, { p_tenant_key: tenantKey, p_user_ids: users }, options);
  const held = new Set<string>();
  for (const row of answer ?? []) {
    const id = uuidOf(row && typeof row === 'object' ? (row as Record<string, unknown>)[ACTIVE_UPLOADER_HOLDS_RPC] : row);
    if (id !== null && users.includes(id)) held.add(id);
  }
  return held;
}
