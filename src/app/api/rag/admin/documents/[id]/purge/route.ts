import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { PURGE_ADMIN_REASON_CODES, purgeDocumentAsAdmin } from '@/lib/rag';
import { checkBody, invalidRequest, jsonNoStore, purgeFailure } from '../../../purges/_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z
  .object({
    reason_code: z.enum(PURGE_ADMIN_REASON_CODES),
    reason_note: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((body) => body.reason_code !== 'other' || (typeof body.reason_note === 'string' && body.reason_note.trim() !== ''), {
    path: ['reason_note'],
    message: 'A note is required for reason other',
  });

type Issue = { path: (string | number)[]; message: string };
const detailsOf = (issues: Issue[]) => issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

/**
 * Purges every version of the document's lineage from every store (D-11, D-34). The actor is the admin the guard verified; the body
 * carries only the reason. read_only_doc_dashboard does not apply to admins, as on the quarantine delete route.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalidRequest(detailsOf(params.error.errors));

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'Body must be JSON' }]);
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) return invalidRequest(detailsOf(body.error.errors));

  const result = await purgeDocumentAsAdmin({
    documentId: params.data.id,
    actorUserId: admin.userId,
    reasonCode: body.data.reason_code,
    reasonNote: body.data.reason_note ?? null,
    signal: request.signal,
  });
  if (!result.ok) return purgeFailure(result.reason);
  console.log('[RAG Admin] document purged', {
    recordId: result.auditId,
    lineageId: result.lineageId,
    documents: result.removed.documents ?? 0,
    chunks: result.removed.chunks ?? 0,
    pendingFiles: result.check.pendingFiles,
    result: result.check.result,
  });
  return jsonNoStore({
    success: true,
    record_id: result.auditId,
    removed: result.removed,
    check: checkBody(result.check),
    checked_at: result.check.checkedAt,
  });
}
