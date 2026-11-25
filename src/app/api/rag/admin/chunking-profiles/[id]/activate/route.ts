import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { ChunkingActivationRefused, activateChunkingProfile } from '@/lib/rag';
import {
  DocTypeSchema,
  PROFILE_ID_PATTERN,
  chunkingUnavailable,
  invalidRequest,
  jsonNoStore,
  optionalJsonBody,
  refusalResponse,
  zodDetails,
} from '../../_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().regex(PROFILE_ID_PATTERN) });
/** Only the doc type (needed when the id exists for more than one, and for legacy); an actor or any other key is refused. */
const BodySchema = z.object({ doc_type: DocTypeSchema.optional() }).strict();

/**
 * Flips the doc type's pointer to the profile through the SQL gate, with the verified admin as actor. A gate refusal is 409 with its reason
 * (eval_failed, open gaps and the rest), an unknown profile 404.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalidRequest(zodDetails(params.error));
  const read = await optionalJsonBody(request);
  if (!read.ok) return read.response;
  const body = BodySchema.safeParse(read.body);
  if (!body.success) return invalidRequest(zodDetails(body.error));

  const profileId = params.data.id;
  try {
    const result = await activateChunkingProfile(profileId, {
      actor: admin.userId,
      signal: request.signal,
      ...(body.data.doc_type ? { docType: body.data.doc_type } : {}),
    });
    console.log('[RAG Admin] chunking profile action', { action: 'activate', profileId: result.activated, docType: result.docType, actor: admin.userId });
    return jsonNoStore({ success: true, activated: result.activated, previous: result.previous, doc_type: result.docType, changed: result.changed });
  } catch (error) {
    if (error instanceof ChunkingActivationRefused) return refusalResponse('activate', profileId, error);
    return chunkingUnavailable('activate', profileId, error);
  }
}
