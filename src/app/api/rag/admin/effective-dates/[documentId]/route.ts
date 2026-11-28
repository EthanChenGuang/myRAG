import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { applyEffectiveDates } from '@/lib/rag';
import { EffectiveDateSchema, IdSchema, OrganizationIdSchema, VersionLabelSchema, admission, datesFailure, invalidRequest, issues, jsonNoStore } from '../_lib';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ documentId: IdSchema });
const QuerySchema = z.object({ organizationId: OrganizationIdSchema });
const BodySchema = z
  .object({ from: EffectiveDateSchema, to: EffectiveDateSchema, versionLabel: VersionLabelSchema })
  .strict()
  .refine((body) => body.from === null || body.to === null || body.from <= body.to, { message: 'invalid_window', path: ['to'] });

/**
 * Sets, changes or clears a document's effective window (D-43). Applying an extracted proposal is this call with the proposed dates.
 * The actor is the verified user and the origin is always admin; neither comes from the body. An optional versionLabel (D-49) is saved
 * with the dates for the document's tenant; without it the label is unchanged and the answer carries no version_label.
 */
export async function PUT(request: Request, context: { params: Promise<{ documentId: string }> }): Promise<Response> {
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!query.success) return invalidRequest(issues(query.error));

  const parsedParams = ParamsSchema.safeParse(await context.params);
  if (!parsedParams.success) return invalidRequest(issues(parsedParams.error));
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) return invalidRequest(issues(body.error));

  const result = await applyEffectiveDates({
    documentId: parsedParams.data.documentId,
    from: body.data.from,
    to: body.data.to,
    ...(body.data.versionLabel !== undefined ? { versionLabel: body.data.versionLabel } : {}),
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
  });
  if (!result.ok) return datesFailure(result.reason);
  return jsonNoStore({
    success: true,
    id: result.documentId,
    effective_from: result.effectiveFrom,
    effective_to: result.effectiveTo,
    origin: result.origin,
    ...(result.versionLabel !== undefined ? { version_label: result.versionLabel } : {}),
  });
}
