import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import {
  AdminDocumentScopeError,
  changeDocumentType,
  DOC_TYPE_IDS,
  scopeForAdminDocument,
} from '@/lib/rag';

export const runtime = 'nodejs';

const TAG = '[RAG Admin]';
const NO_STORE = { 'Cache-Control': 'no-store' };

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z
  .object({
    docType: z.enum(DOC_TYPE_IDS),
  })
  .strict();

function fail(status: number, error: string, details?: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json(details ? { success: false, error, details } : { success: false, error }, { status, headers: NO_STORE });
}

const invalid = (error: z.ZodError): NextResponse =>
  fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));

function mapChangeFailure(reason: string): NextResponse {
  if (reason === 'not_found') return fail(404, 'Document not found');
  if (reason === 'invalid_doc_type') return fail(400, 'Invalid request data');
  if (reason === 'not_changeable' || reason === 'original_unavailable') return fail(409, 'Document cannot be changed');
  return fail(503, 'Document type change is unavailable');
}

/** Re-processes one document under a new type as a new version. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalid(parsed.error);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Invalid request data');
  }
  const checked = BodySchema.safeParse(body);
  if (!checked.success) return invalid(checked.error);

  let scope;
  try {
    scope = await scopeForAdminDocument({ documentId: parsed.data.id, adminUserId: admin.userId, signal: request.signal });
  } catch (error) {
    if (error instanceof AdminDocumentScopeError) {
      if (error.reason === 'not_admin') return fail(403, 'Forbidden');
      return fail(503, 'Document type change is unavailable');
    }
    throw error;
  }
  if (scope === null) return fail(404, 'Document not found');

  const changed = await changeDocumentType({
    scope,
    documentId: parsed.data.id,
    docType: checked.data.docType,
    signal: request.signal,
  });
  if (!changed.ok) return mapChangeFailure(changed.reason);

  const { result } = changed;
  console.log(TAG, { action: 'doc_type_change', documentId: parsed.data.id, docType: checked.data.docType });
  const status = result.status === 'processing' ? 202 : 200;
  return NextResponse.json(
    {
      success: true,
      id: result.documentId,
      status: result.status,
      version: result.version,
    },
    { status, headers: NO_STORE },
  );
}