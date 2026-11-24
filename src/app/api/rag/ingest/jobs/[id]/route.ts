import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireSessionUser } from '@/lib/session-auth';
import { getJobForScope, IngestLedgerError, resolveTenantScope } from '@/lib/rag';
import type { IngestionJob } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z0-9][a-z0-9_:.-]{0,63}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

const ParamsSchema = z.object({ id: z.string().regex(UUID_RE, 'Expected a job id (UUID)') });
const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

function fail(status: number, error: string, details?: Array<{ path: string; message: string }>): Response {
  return NextResponse.json(details ? { success: false, error, details } : { error }, { status, headers: NO_STORE });
}

function validationFailure(error: z.ZodError): Response {
  return fail(
    400,
    'Invalid request data',
    error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

function publicReason(job: IngestionJob): string | null {
  const raw = job.status === 'failed' ? job.error_class : job.status === 'needs_review' ? job.needs_review_reason : null;
  return typeof raw === 'string' && CODE_RE.test(raw) ? raw : null;
}

/** Owner-visible job status without settings, paths, attempts or tenant keys. */
function jobStatusBody(job: IngestionJob): Record<string, unknown> {
  return {
    jobId: job.id,
    documentId: job.document_id,
    status: job.status,
    stage: job.stage,
    provisional: job.provisional_published_at != null,
    needsReview: job.status === 'needs_review',
    reason: publicReason(job),
    updatedAt: job.updated_at,
  };
}

/**
 * GET /api/rag/ingest/jobs/{id}: poll one ingestion job of the caller's tenant. Another tenant's id reads exactly like an unknown id.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const tag = '[RAG Ingest]';
  const session = await requireSessionUser(tag);
  if ('response' in session) return session.response;

  let rawId: string;
  try {
    rawId = (await params).id;
  } catch {
    return fail(400, 'Invalid request data');
  }
  const parsedId = ParamsSchema.safeParse({ id: rawId });
  if (!parsedId.success) return validationFailure(parsedId.error);
  const parsedQuery = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsedQuery.success) return validationFailure(parsedQuery.error);

  const tenant = await resolveTenantScope({
    requestedOrganizationId: parsedQuery.data.organizationId ?? null,
    getUser: session.getUser,
    signal: request.signal,
  });
  if (!tenant.ok) {
    const error = tenant.status === 403 ? 'Forbidden' : tenant.status === 401 ? 'Unauthorized' : 'Workspace verification unavailable';
    return fail(tenant.status, error);
  }
  if (!tenant.scope) return fail(401, 'Unauthorized');

  try {
    const job = await getJobForScope(tenant.scope, parsedId.data.id.toLowerCase(), { signal: request.signal });
    if (!job) return fail(404, 'Job not found');
    return NextResponse.json(jobStatusBody(job), { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error('[RAG Ingest] job status lookup failed', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof IngestLedgerError ? { rpc: error.rpc, code: error.code } : {}),
    });
    return fail(503, 'Job status unavailable');
  }
}