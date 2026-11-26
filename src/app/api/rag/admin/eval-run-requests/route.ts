import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import {
  EVAL_RUN_CLAIM_MAX,
  EVAL_RUN_PAGE_MAX,
  adminTenantKeys,
  claimEvalRunRequests,
  decodeEvalRunCursor,
  listEvalRunRequests,
} from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fail, invalid, jsonNoStore, projectRequest, unavailable } from './_lib';

export const runtime = 'nodejs';

const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(EVAL_RUN_PAGE_MAX).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

const ClaimBodySchema = z.object({ action: z.literal('claim'), limit: z.number().int().min(1).max(EVAL_RUN_CLAIM_MAX).optional() }).strict();

function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

/**
 * D-19, UI-SPEC 6.4: the tenant nightly requests of the tenants this admin administers (rag_admin_tenant_keys, resolved in SQL),
 * newest first, at most 20 per page.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const parsed = ListQuerySchema.safeParse(queryOf(new URL(request.url)));
  if (!parsed.success) return invalid(parsed.error);
  const cursor = parsed.data.cursor === undefined ? null : decodeEvalRunCursor(parsed.data.cursor);
  if (parsed.data.cursor !== undefined && cursor === null) return fail(400, 'Invalid cursor');

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const keys = await adminTenantKeys(admin, guard.userId);
    if (keys === null) return unavailable();
    const result = await listEvalRunRequests(admin, { tenantKeys: keys, limit: parsed.data.limit, cursor });
    if (!result.ok) return unavailable();
    console.log('[Config Gate] eval run requests listed', { count: result.requests.length, tenants: keys.length });
    return jsonNoStore({ requests: result.requests.map(projectRequest), next_cursor: result.nextCursor });
  } catch {
    console.error('[Config Gate] eval run requests read failed');
    return unavailable();
  }
}

/** The drain's claim: moves up to `limit` pending requests of the admin's tenants to running and returns them. */
export async function POST(request: Request): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const parsed = ClaimBodySchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const keys = await adminTenantKeys(admin, guard.userId);
    if (keys === null) return unavailable();
    const result = await claimEvalRunRequests(admin, { tenantKeys: keys, limit: parsed.data.limit });
    if (!result.ok) return unavailable();
    console.log('[Config Gate] eval run requests claimed', { count: result.requests.length });
    return jsonNoStore({ requests: result.requests.map(projectRequest) });
  } catch {
    console.error('[Config Gate] eval run request claim failed');
    return unavailable();
  }
}
