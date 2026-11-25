import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { MAX_DOCUMENT_SCOPES, setDocumentScopes } from '@/lib/rag';
import {
  OrganizationIdSchema,
  admission,
  invalidRequest,
  issues,
  jsonBody,
  jsonNoStore,
  scopeFailure,
  switchedOff,
} from '../../../scope-vocabulary/_lib';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({ organizationId: OrganizationIdSchema });
const TAG = /^(region|legal_entity|department):[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The complete tag list of the document; an empty list clears it. The actor is the verified user, never the body. */
const BodySchema = z
  .object({
    scopes: z.array(z.string().max(80).regex(TAG, 'Expected dimension:value')).max(MAX_DOCUMENT_SCOPES),
  })
  .strict();

/** Sets a document's tags (DATA-18): document and chunks in one transaction, no re-embed; the filter changes at once. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const off = switchedOff();
  if (off) return off;
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!query.success) return invalidRequest(issues(query.error));

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const body = BodySchema.safeParse(read.body);
  if (!body.success) {
    const tooMany = body.error.errors.some((issue) => issue.code === 'too_big' && issue.path.join('.') === 'scopes');
    return tooMany ? scopeFailure('too_many_scopes') : invalidRequest(issues(body.error));
  }

  const result = await setDocumentScopes({
    documentId: parsed.data.id,
    scopes: body.data.scopes,
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
  });
  if (!result.ok) return scopeFailure(result.reason);
  console.log('[RAG Admin] document tags set', { documentId: result.documentId, tags: result.scopes.length, chunks: result.chunksUpdated });
  return jsonNoStore({ success: true, id: result.documentId, scopes: result.scopes });
}
