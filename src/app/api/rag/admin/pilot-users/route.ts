import { z } from 'zod/v3';
import { addPilotUser, decodePilotCursor, listPilotUsers, pilotSamplingParams, removePilotUser } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';
import { admit, invalidRequest, issues, jsonBody, jsonNoStore } from '../_tenant-data/lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PostSchema = z.object({ organizationId: z.string().max(64).nullish(), user: z.string().trim().min(1).max(320) }).strict();

function unavailable() {
  return jsonNoStore({ success: false, error: 'Pilot users are unavailable' }, 503);
}

function failed(operation: string) {
  console.error('[Monitor] pilot users route failed', { operation });
  return unavailable();
}

/**
 * D-52, UI-SPEC 6.10.2: the pilot users of the admin's workspace, newest first, 50 per page, each as a masked e-mail or the user id.
 * The tenant comes only from the server-side admission of organizationId; no tenant key is accepted from the browser.
 */
export async function GET(request: Request): Promise<Response> {
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const rawCursor = new URL(request.url).searchParams.get('cursor');
  const cursor = rawCursor ? decodePilotCursor(rawCursor) : null;
  if (rawCursor && !cursor) return invalidRequest([{ path: 'cursor', message: 'not a cursor of this list' }]);

  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();
  try {
    const page = await listPilotUsers(admin, admitted.tenantKey, cursor);
    const params = pilotSamplingParams();
    return jsonNoStore({
      success: true,
      users: page.users,
      ...(params ? { weight: params.weight, cap_share: params.cap_share } : {}),
      next_cursor: page.next_cursor,
    });
  } catch {
    return failed('list');
  }
}

/** Adds a user of the workspace by e-mail address or user id: 201, 404 user_not_found (unknown or another workspace), 409 already_pilot. */
export async function POST(request: Request): Promise<Response> {
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const body = await jsonBody(request);
  if (!body.ok) return body.response;
  const parsed = PostSchema.safeParse(body.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();
  try {
    const result = await addPilotUser(admin, { tenantKey: admitted.tenantKey, user: parsed.data.user, actorUserId: admitted.actorUserId });
    if (!result.ok) {
      return jsonNoStore({ success: false, error: result.reason }, result.reason === 'user_not_found' ? 404 : 409);
    }
    console.log('[Monitor] pilot user added', { added: 1 });
    return jsonNoStore({ success: true, user: result.user }, 201);
  } catch {
    return failed('add');
  }
}

/** Removes `?user_id=` from the workspace's pilot users: 200, or 404 when it is not one of them. */
export async function DELETE(request: Request): Promise<Response> {
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const userId = new URL(request.url).searchParams.get('user_id') ?? '';
  if (!UUID_RE.test(userId)) return invalidRequest([{ path: 'user_id', message: 'a user id' }]);

  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();
  try {
    const removed = await removePilotUser(admin, { tenantKey: admitted.tenantKey, userId });
    if (!removed) return jsonNoStore({ success: false, error: 'not_found' }, 404);
    console.log('[Monitor] pilot user removed', { removed: 1 });
    return jsonNoStore({ success: true });
  } catch {
    return failed('remove');
  }
}
