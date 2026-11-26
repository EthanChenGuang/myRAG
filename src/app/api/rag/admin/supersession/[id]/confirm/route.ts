import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { confirmSupersession } from '@/lib/rag';
import { IdSchema, OrganizationIdSchema, admission, invalidRequest, issues, jsonNoStore, supersessionFailure } from '../../_lib';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: IdSchema });
const QuerySchema = z.object({ organizationId: OrganizationIdSchema });
/** Only the older document may be named, and only for a candidate without a direction; the actor is the verified user, never the body. */
const BodySchema = z.object({ olderDocumentId: IdSchema.optional() }).strict();

async function bodyOf(request: Request): Promise<{ ok: true; olderDocumentId: string | undefined } | { ok: false; response: Response }> {
  const raw = await request.text();
  if (raw.trim() === '') return { ok: true, olderDocumentId: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: invalidRequest([{ path: '', message: 'Body is not valid JSON' }]) };
  }
  const checked = BodySchema.safeParse(parsed);
  return checked.success ? { ok: true, olderDocumentId: checked.data.olderDocumentId } : { ok: false, response: invalidRequest(issues(checked.error)) };
}

/** Confirms one candidate: the older document leaves retrieval in one transaction; the cache follows from the is_current triggers. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!query.success) return invalidRequest(issues(query.error));

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  const body = await bodyOf(request);
  if (!body.ok) return body.response;

  const result = await confirmSupersession({
    candidateId: parsed.data.id,
    olderDocumentId: body.olderDocumentId ?? null,
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
  });
  if (!result.ok) return supersessionFailure(result.reason);
  console.log('[RAG Admin] supersession confirmed', {
    candidateId: result.candidateId,
    olderDocumentId: result.olderDocumentId,
    newerDocumentId: result.newerDocumentId,
  });
  return jsonNoStore({
    success: true,
    id: result.candidateId,
    outcome: 'confirmed',
    older_document_id: result.olderDocumentId,
    newer_document_id: result.newerDocumentId,
  });
}
