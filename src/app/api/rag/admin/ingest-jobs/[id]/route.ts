import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { deleteJob, getJobForScope } from '@/lib/rag';
import { JobIdSchema, OrganizationIdSchema, fail, invalid, isJobNotFoundRefusal, isRefusal, jsonNoStore, ledgerFailure, notFound, projectJob, projectJobDetail, resolveWorkspace } from '../_lib';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ParamsSchema = z.object({ id: JobIdSchema, organizationId: OrganizationIdSchema });

async function readParams(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return ParamsSchema.safeParse({ id, organizationId: new URL(request.url).searchParams.get('organizationId') });
}

/**
 * One job of the verified admin's workspace with its parse attempts and page ranges. original_ref, settings and stage_state are not
 * returned. A job of another tenant answers exactly like an unknown id.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = await readParams(request, context);
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveWorkspace(admin.userId, parsed.data.organizationId, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const job = await getJobForScope(workspace.scope, parsed.data.id, { signal: request.signal });
    if (!job) return notFound();
    return jsonNoStore({ success: true, job: projectJobDetail(job) });
  } catch (error) {
    return ledgerFailure('get', error);
  }
}

/**
 * Deletes an unpublished job and its version through the audited SQL function. The actor is the id the guard verified; the body is
 * never read. A job whose version is current answers 409 not_deletable.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = await readParams(request, context);
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveWorkspace(admin.userId, parsed.data.organizationId, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const existing = await getJobForScope(workspace.scope, parsed.data.id, { signal: request.signal });
    if (!existing) return notFound();
    const deleted = await deleteJob(existing.id, admin.userId, { signal: request.signal });
    console.log('[RAG Admin] ingest job deleted', { action: 'delete_ingestion_job', jobId: deleted.id });
    return jsonNoStore({ success: true, job: { ...projectJob(deleted), deleted_at: deleted.deleted_at } });
  } catch (error) {
    if (isJobNotFoundRefusal(error)) return notFound();
    if (isRefusal(error)) return fail(409, 'not_deletable');
    return ledgerFailure('delete', error);
  }
}
