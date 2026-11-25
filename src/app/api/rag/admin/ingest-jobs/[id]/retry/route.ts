import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { getJobForScope, retryJob } from '@/lib/rag';
import { JobIdSchema, OrganizationIdSchema, fail, invalid, isJobNotFoundRefusal, isRefusal, jsonNoStore, ledgerFailure, notFound, projectJob, resolveWorkspace } from '../../_lib';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ParamsSchema = z.object({ id: JobIdSchema, organizationId: OrganizationIdSchema });
const RETRYABLE = new Set(['failed', 'needs_review']);

/**
 * Requeues a failed or needs_review job of the verified admin's workspace through the audited SQL function. The actor is the id the
 * guard verified; the body is never read. Another tenant's job answers exactly like an unknown id (404); a job in any other status
 * answers 409 not_retryable.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const { id } = await context.params;
  const parsed = ParamsSchema.safeParse({ id, organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveWorkspace(admin.userId, parsed.data.organizationId, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const existing = await getJobForScope(workspace.scope, parsed.data.id, { signal: request.signal });
    if (!existing) return notFound();
    if (!RETRYABLE.has(existing.status)) return fail(409, 'not_retryable');
    const job = await retryJob(existing.id, admin.userId, { signal: request.signal });
    console.log('[RAG Admin] ingest job retried', { action: 'retry_ingestion_job', jobId: job.id });
    return jsonNoStore({ success: true, job: projectJob(job) });
  } catch (error) {
    if (isJobNotFoundRefusal(error)) return notFound();
    if (isRefusal(error)) return fail(409, 'not_retryable');
    return ledgerFailure('retry', error);
  }
}
