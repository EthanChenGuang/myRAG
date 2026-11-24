import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireSessionUser } from '@/lib/session-auth';
import {
  getIngestStatusReport,
  isAdminUser,
  resumeIngest,
  resolveTenantScope,
  type IngestResult,
  type RagAdminDb,
  type TenantScope,
} from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

/** Test seam: a route never passes it, so the cookie session is the only way in. */
export interface IngestRouteDeps {
  getUser?: () => Promise<{ id: string } | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z0-9][a-z0-9_:.-]{0,63}$/;

const ParamsSchema = z.object({ id: z.string().regex(UUID_RE, 'Expected a document id (UUID)') });
const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

type Access = { ok: true; scope: TenantScope; documentId: string; userId: string } | { ok: false; response: Response };

function fail(status: number, error: string, details?: Array<{ path: string; message: string }>): Response {
  return NextResponse.json(details ? { success: false, error, details } : { error }, { status });
}

const notFound = (): Response => fail(404, 'Document not found');

function validationFailure(error: z.ZodError): Response {
  return fail(
    400,
    'Invalid request data',
    error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

/**
 * Verified session first, then the id and query, then the tenant scope. The scope never comes from the request:
 * an organization is honoured only when resolveTenantScope finds a membership row for the session user.
 */
async function authorize(
  request: Request,
  params: Promise<{ id: string }>,
  tag: string,
  deps: IngestRouteDeps,
  write: boolean,
): Promise<Access> {
  let getUser: () => Promise<{ id: string } | null>;
  let userId: string;
  if (deps.getUser) {
    getUser = deps.getUser;
    try {
      const user = await getUser();
      if (!user) return { ok: false, response: fail(401, 'Unauthorized') };
      userId = user.id;
    } catch {
      console.error(`${tag} Session lookup failed`);
      return { ok: false, response: fail(503, 'Authentication unavailable') };
    }
  } else {
    const session = await requireSessionUser(tag);
    if ('response' in session) return { ok: false, response: session.response };
    getUser = session.getUser;
    userId = session.user.id;
  }

  let rawId: string;
  try {
    rawId = (await params).id;
  } catch {
    return { ok: false, response: fail(400, 'Invalid request data') };
  }
  const parsedId = ParamsSchema.safeParse({ id: rawId });
  if (!parsedId.success) return { ok: false, response: validationFailure(parsedId.error) };
  const parsedQuery = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsedQuery.success) return { ok: false, response: validationFailure(parsedQuery.error) };

  const tenant = await resolveTenantScope({
    requestedOrganizationId: parsedQuery.data.organizationId ?? null,
    getUser,
    signal: request.signal,
  });
  if (!tenant.ok) {
    const error = tenant.status === 403 ? 'Forbidden' : tenant.status === 401 ? 'Unauthorized' : 'Workspace verification unavailable';
    return { ok: false, response: fail(tenant.status, error) };
  }
  if (!tenant.scope) return { ok: false, response: fail(401, 'Unauthorized') };

  // Documents of the single tenant carry no user id, so a non-admin cannot be shown to own one: resuming is administrator-only there.
  if (write && tenant.scope.kind === 'single') {
    const admin = getSupabaseAdmin();
    if (!admin) return { ok: false, response: fail(503, 'Authorization unavailable') };
    try {
      if (!(await isAdminUser(admin as unknown as RagAdminDb, userId.toLowerCase(), request.signal))) {
        return { ok: false, response: fail(403, 'Forbidden') };
      }
    } catch {
      console.error(`${tag} Admin lookup failed`);
      return { ok: false, response: fail(503, 'Authorization unavailable') };
    }
  }
  return { ok: true, scope: tenant.scope, documentId: parsedId.data.id.toLowerCase(), userId };
}

function codeOrNull(value: string | undefined | null): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

function logFailure(tag: string, error: unknown): void {
  console.error(`${tag} lookup failed`, { error: error instanceof Error ? error.name : 'unknown' });
}

/** GET /api/rag/ingest/{id}: the status of one document of the caller's tenant. Another tenant's id reads exactly like an unknown id. */
export async function handleIngestStatus(request: Request, params: Promise<{ id: string }>, deps: IngestRouteDeps = {}): Promise<Response> {
  const tag = '[Ingest Status]';
  try {
    const access = await authorize(request, params, tag, deps, false);
    if (!access.ok) return access.response;
    const report = await getIngestStatusReport(access.scope, access.documentId, { signal: request.signal });
    if (!report) return notFound();
    return NextResponse.json({ ...report.view, warnings: report.warnings, ...(report.reason ? { reason: report.reason } : {}) });
  } catch (error) {
    logFailure(tag, error);
    return fail(503, 'Status unavailable');
  }
}

function resultBody(result: IngestResult): Record<string, unknown> {
  const reason = codeOrNull(result.reason);
  return {
    status: result.status,
    documentId: result.documentId,
    version: result.version,
    parserUsed: result.parserUsed,
    chunkCount: result.chunkCount,
    warnings: result.warnings.filter((warning) => CODE_RE.test(warning)),
    ...(reason ? { reason } : {}),
  };
}

/** POST /api/rag/ingest/{id}/resume: continues a processing document of the caller's tenant from its last completed stage. */
export async function handleIngestResume(request: Request, params: Promise<{ id: string }>, deps: IngestRouteDeps = {}): Promise<Response> {
  const tag = '[Ingest Resume]';
  try {
    const access = await authorize(request, params, tag, deps, true);
    if (!access.ok) return access.response;
    const result = await resumeIngest(access.scope, access.documentId, { signal: request.signal });
    if (result.status === 'failed' && result.reason === 'document_not_found') return notFound();
    if (result.status === 'failed' && (result.reason === 'db_unavailable' || result.reason === 'resume_lookup_failed')) {
      return fail(503, 'Resume unavailable');
    }
    return NextResponse.json(resultBody(result));
  } catch (error) {
    logFailure(tag, error);
    return fail(503, 'Resume unavailable');
  }
}
