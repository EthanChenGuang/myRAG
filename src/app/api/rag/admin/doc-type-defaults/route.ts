import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import {
  DOC_TYPE_CHOICES,
  DOC_TYPE_DEFAULT_SOURCE_KINDS,
  DocTypeDefaultsError,
  listDocTypeDefaults,
  resolveAdminWorkspaceScope,
  setDocTypeDefault,
  type DocTypeDefaultRow,
} from '@/lib/rag';

export const runtime = 'nodejs';

const TAG = '[RAG Admin]';
const NO_STORE = { 'Cache-Control': 'no-store' };

const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });
const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    sourceKind: z.enum(DOC_TYPE_DEFAULT_SOURCE_KINDS),
    sourceRef: z.string().trim().min(1).max(200).nullish(),
    docType: z.enum(DOC_TYPE_CHOICES),
  })
  .strict();

function fail(status: number, error: string, details?: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json(details ? { success: false, error, details } : { success: false, error }, { status, headers: NO_STORE });
}

const invalid = (error: z.ZodError): NextResponse =>
  fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));

function itemOf(row: DocTypeDefaultRow) {
  return { source_kind: row.sourceKind, source_ref: row.sourceRef, doc_type: row.docType, updated_by: row.updatedBy, updated_at: row.updatedAt };
}

function failureOf(error: unknown): NextResponse {
  if (error instanceof DocTypeDefaultsError && error.reason !== null) return fail(400, 'Invalid request data');
  console.error(`${TAG} doc type defaults call failed`, {
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof DocTypeDefaultsError ? { rpc: error.rpc, code: error.code } : {}),
  });
  return fail(503, 'Document type defaults are unavailable');
}

/** The default document types of one workspace of the verified admin: the tenant default, the per-source defaults and the Nango ones. */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveAdminWorkspaceScope({
    adminUserId: admin.userId,
    requestedOrganizationId: parsed.data.organizationId ?? null,
    signal: request.signal,
  });
  if (!workspace.ok) return fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable');

  try {
    const rows = await listDocTypeDefaults(workspace.scope, { signal: request.signal });
    return NextResponse.json({ success: true, items: rows.map(itemOf) }, { headers: NO_STORE });
  } catch (error) {
    return failureOf(error);
  }
}

/** Sets or replaces one default. updated_by is the id of the admin the guard verified; the body cannot name an actor. */
export async function PUT(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Invalid request data', [{ path: '', message: 'Body is not valid JSON' }]);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveAdminWorkspaceScope({
    adminUserId: admin.userId,
    requestedOrganizationId: parsed.data.organizationId ?? null,
    signal: request.signal,
  });
  if (!workspace.ok) return fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable');

  try {
    const row = await setDocTypeDefault(
      workspace.scope,
      { sourceKind: parsed.data.sourceKind, sourceRef: parsed.data.sourceRef ?? null, docType: parsed.data.docType, updatedBy: admin.userId },
      { signal: request.signal },
    );
    console.log(`${TAG} doc type default set`, { action: 'set_doc_type_default', sourceKind: row.sourceKind, docType: row.docType });
    return NextResponse.json({ success: true, item: itemOf(row) }, { headers: NO_STORE });
  } catch (error) {
    return failureOf(error);
  }
}
