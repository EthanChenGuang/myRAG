import { z } from 'zod/v3';
import { setDocumentsAccess, type DocumentsAccessInput } from '@/lib/rag';
import { requireAccessAdmin } from '../../_auth';
import { TAG, audienceOf, failureOf, guardWorkspace, invalid, ok, readJson, requestedWorkspace, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

const UUID = z.string().uuid();

const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    documentIds: z.array(UUID).min(1).max(500),
    everyone: z.literal(true).optional(),
    groupIds: z.array(UUID).min(1).max(50).optional(),
  })
  .strict()
  .refine((value) => (value.everyone === true) !== (value.groupIds !== undefined), {
    message: 'Give exactly one of everyone and groupIds',
    path: ['groupIds'],
  });

/**
 * D-17, D-06: replaces the access of one or many documents with everyone or a list of groups named by id (never keys). Connector-managed
 * documents are skipped and counted; one connector document alone answers 409 access_managed_by_connector. The actor is the admin the
 * guard verified. Audit, propagation to every store, the tenant cache invalidation and the external sync enqueue run in the database
 * triggers of the setter (D-24, D-14).
 */
export async function PUT(request: Request): Promise<Response> {
  const read = await readJson(request);
  const workspace = read.ok ? requestedWorkspace(request, read.body) : null;
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace) ?? (new URL(request.url).searchParams.get('organizationId') || null), request.signal);
  if (!admin.ok) return admin.response;
  if (!read.ok) return read.response;
  if (workspace && !workspace.ok) return workspace.response;

  const parsed = BodySchema.safeParse(read.body);
  if (!parsed.success) return invalid(parsed.error);

  const documentIds = [...new Set(parsed.data.documentIds.map((id) => id.toLowerCase()))];
  const input: DocumentsAccessInput = parsed.data.everyone
    ? { documentIds, everyone: true }
    : { documentIds, groupIds: [...new Set((parsed.data.groupIds ?? []).map((id) => id.toLowerCase()))] };
  try {
    const result = await setDocumentsAccess(admin.scope, input, admin.actorId, serviceDeps(request));
    console.log(`${TAG} document access changed`, {
      action: 'access_documents_set',
      requested: documentIds.length,
      changed: result.changed,
      skipped: result.skipped,
      via: admin.via,
    });
    return ok({ changed: result.changed, skipped: result.skipped, notFound: result.notFound, audiences: result.audiences.map(audienceOf) });
  } catch (error) {
    return failureOf(error);
  }
}
