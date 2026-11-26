import { z } from 'zod/v3';
import { holdUploader, readSecuritySettings } from '@/lib/rag';
import { admitSecurityActor, invalidRequest, jsonNoStore, securityFailure, zodDetails } from '../../../_responses';

export const runtime = 'nodejs';

const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const BodySchema = z
  .object({
    tenantKey: z.string().regex(TENANT_KEY),
    reason: z
      .string()
      .max(200)
      .regex(/^[^\p{Cc}]*$/u, 'Reason must not contain control characters')
      .nullable()
      .optional(),
  })
  .strict();

const IdSchema = z.string().uuid();

/** D-46: holds the uploads of an uploader of one administered tenant (UI-SPEC 8.2 status words). */
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

  const result = await holdUploader(
    admission.db,
    admission.actor,
    { tenantKey: parsed.data.tenantKey, userId: userId.data, reason: parsed.data.reason ?? null },
    readSecuritySettings(),
  );
  if (!result.ok) return securityFailure(result.reason);
  return jsonNoStore({
    success: true,
    user_id: result.state.userId,
    tenant_key: result.state.tenantKey,
    held: result.state.held,
    held_since: result.state.heldSince,
  });
}
