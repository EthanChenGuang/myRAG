import { z } from 'zod/v3';
import { releaseUploaderHold } from '@/lib/rag/security/security-admin';
import { admitSecurityActor, invalidRequest, jsonNoStore, securityFailure, zodDetails } from '../../../_responses';

export const runtime = 'nodejs';

const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const BodySchema = z.object({ tenantKey: z.string().regex(TENANT_KEY) }).strict();
const IdSchema = z.string().uuid();

/** D-46: releases a hold in any hold mode. Held uploads keep waiting for approval; the response says so. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admission = await admitSecurityActor(request);
  if (!admission.ok) return admission.response;

  const { id } = await context.params;
  const userId = IdSchema.safeParse(id);
  if (!userId.success) return invalidRequest([{ path: 'id', message: 'Invalid uploader id' }]);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'Invalid JSON body' }]);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return invalidRequest(zodDetails(parsed.error.errors));

  const result = await releaseUploaderHold(admission.db, admission.actor, { tenantKey: parsed.data.tenantKey, userId: userId.data });
  if (!result.ok) return securityFailure(result.reason);
  return jsonNoStore({
    success: true,
    user_id: result.state.userId,
    tenant_key: result.state.tenantKey,
    held: false,
    held_since: null,
    held_uploads: 'pending_approval',
  });
}
