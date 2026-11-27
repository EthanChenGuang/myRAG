import { z } from 'zod/v3';
import { documentAccessCounts, documentAudiences, listAccessDocuments } from '@/lib/rag';
import { requireAccessAdmin } from '../_auth';
import { audienceOf, failureOf, invalid, ok, serviceDeps } from '../_responses';

export const runtime = 'nodejs';

const IDS_MAX = 200;
const UUID = z.string().uuid();

const QuerySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    filter: z.enum(['restricted', 'uploader_only', 'everyone', 'all']).nullish(),
    q: z.string().max(200).nullish(),
    cursor: z.string().max(600).nullish(),
    ids: z
      .string()
      .max(IDS_MAX * 37)
      .transform((value) => value.split(',').map((id) => id.trim().toLowerCase()).filter((id) => id !== ''))
      .pipe(z.array(UUID).min(1).max(IDS_MAX))
      .nullish(),
  })
  .refine((value) => !value.ids || (!value.filter && !value.q && !value.cursor), {
    message: 'ids cannot be combined with filter, q or cursor',
    path: ['ids'],
  });

/**
 * D-28, UI-SPEC 6.4 and 6.8: the admin document view. Without ids: current documents of the workspace with their audience, filtered and
 * searched by file name, 50 per page, plus the four filter counts. With ids (up to 200): the audience of those documents only, for the
 * stored-documents table badge; ids of other workspaces or superseded versions are left out.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    organizationId: params.get('organizationId'),
    filter: params.get('filter') || null,
    q: params.get('q'),
    cursor: params.get('cursor'),
    ids: params.get('ids'),
  });
  const admin = await requireAccessAdmin(request, parsed.success ? (parsed.data.organizationId ?? null) : params.get('organizationId') || null, request.signal);
  if (!admin.ok) return admin.response;
  if (!parsed.success) return invalid(parsed.error);

  const deps = serviceDeps(request);
  const personal = admin.scope.kind === 'personal';
  try {
    if (parsed.data.ids) {
      const audiences = await documentAudiences(admin.scope, [...new Set(parsed.data.ids)], deps);
      return ok({ personal, audiences: audiences.map(audienceOf) });
    }
    const [page, counts] = await Promise.all([
      listAccessDocuments(admin.scope, { filter: parsed.data.filter ?? 'all', query: parsed.data.q ?? null, cursor: parsed.data.cursor ?? null }, deps),
      documentAccessCounts(admin.scope, { query: parsed.data.q ?? null }, deps),
    ]);
    return ok({ personal, documents: page.documents.map(audienceOf), nextCursor: page.nextCursor, counts });
  } catch (error) {
    return failureOf(error);
  }
}
