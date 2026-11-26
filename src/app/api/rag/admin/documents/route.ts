import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { DOCUMENT_VIEWS, listDocumentsWithScopes, type TaggedDocument } from '@/lib/rag';
import { OrganizationIdSchema, admission, invalidRequest, issues, jsonNoStore, scopeFailure, switchedOff } from '../scope-vocabulary/_lib';

export const runtime = 'nodejs';

const TAG = /^(region|legal_entity|department):[a-z0-9]+(?:-[a-z0-9]+)*$/;

const QuerySchema = z.object({
  organizationId: OrganizationIdSchema,
  scopes: z.array(z.string().max(80).regex(TAG, 'Expected dimension:value')).max(60),
  q: z.string().max(200).nullish(),
  filter: z.enum(DOCUMENT_VIEWS).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** An explicit allow-list: no document text, tenant key, fingerprint or uploader id leaves this route. */
function projectDocument(item: TaggedDocument) {
  return {
    id: item.documentId,
    file_name: item.filename,
    doc_type: item.docType,
    status: item.status,
    version: item.version,
    tags: item.scopes,
    suggestions: item.suggestions.map((suggestion) => ({ dimension: suggestion.dimension, value: suggestion.value, source: suggestion.source })),
    uploaded_at: item.uploadedAt,
  };
}

/** The Documents view of the tag panel (UI-SPEC 6.7): the workspace's current documents filtered by tag, view and file name. */
export async function GET(request: Request): Promise<Response> {
  const off = switchedOff();
  if (off) return off;
  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    organizationId: params.get('organizationId'),
    scopes: params.getAll('scopes').flatMap((value) => value.split(',')).filter((value) => value !== ''),
    q: params.get('q'),
    filter: params.get('filter') ?? undefined,
    limit: params.get('limit') ?? undefined,
    offset: params.get('offset') ?? undefined,
  });
  const admitted = admission(await checkAdminOrOrgAdmin(request, parsed.success ? parsed.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await listDocumentsWithScopes({
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
    scopes: parsed.data.scopes,
    query: parsed.data.q ?? null,
    view: parsed.data.filter,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
  if (!result.ok) return scopeFailure(result.reason);
  console.log('[RAG Admin] tagged documents listed', { count: result.items.length, total: result.total });
  return jsonNoStore({
    success: true,
    total: result.total,
    suggested_total: result.suggestedTotal,
    limit: result.limit,
    offset: result.offset,
    items: result.items.map(projectDocument),
  });
}
