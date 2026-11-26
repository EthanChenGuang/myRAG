import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { activateRebuild, RebuildNotFound, RebuildRefused } from '@/lib/rag';
import { emptyJsonBody, jsonNoStore, rebuildUnavailable } from '../../../_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

/**
 * POST: publishes the held versions of a complete reparse run whose recorded eval passed (D-12). The run row is locked and its state checked in SQL, so a second call is refused. Refusals answer 409
 * { error: 'activation_refused', reason }, an unknown run 404; success answers counts only.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return jsonNoStore({ success: false, error: 'not_found' }, 404);
  const refused = await emptyJsonBody(request);
  if (refused) return refused;

  try {
    const done = await activateRebuild(params.data.id, admin.userId, { signal: request.signal });
    console.log('[RAG Admin] rebuild activate', { runId: params.data.id, published: done.published.length, superseded: done.superseded });
    return jsonNoStore({ success: true, published: done.published.length, superseded: done.superseded });
  } catch (error) {
    if (error instanceof RebuildRefused) {
      console.warn('[RAG Admin] rebuild activate refused', { runId: params.data.id, reason: error.reason });
      return jsonNoStore({ success: false, error: 'activation_refused', reason: error.reason }, 409);
    }
    if (error instanceof RebuildNotFound) return jsonNoStore({ success: false, error: 'not_found' }, 404);
    if (request.signal.aborted) return jsonNoStore({ success: false, error: 'activate_aborted' }, 499);
    return rebuildUnavailable('activate', error);
  }
}
