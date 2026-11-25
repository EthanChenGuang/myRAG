import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { ChunkingActivationRefused, rollbackChunkingProfile } from '@/lib/rag';
import { DocTypeSchema, chunkingUnavailable, invalidRequest, jsonNoStore, optionalJsonBody, refusalResponse, zodDetails } from '../_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The doc type whose pointer goes back; an actor or any other key is refused, the actor is the verified admin. */
const BodySchema = z.object({ doc_type: DocTypeSchema }).strict();

/** Restores the doc type's previous profile (legacy when there is none) through the SQL gate; a refusal such as no_previous is 409. */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const read = await optionalJsonBody(request);
  if (!read.ok) return read.response;
  const body = BodySchema.safeParse(read.body);
  if (!body.success) return invalidRequest(zodDetails(body.error));

  const docType = body.data.doc_type;
  try {
    const result = await rollbackChunkingProfile(docType, { actor: admin.userId, signal: request.signal });
    console.log('[RAG Admin] chunking profile action', { action: 'rollback', profileId: result.restored, docType: result.docType, actor: admin.userId });
    return jsonNoStore({ success: true, restored: result.restored, rolled_back: result.rolledBack, doc_type: result.docType });
  } catch (error) {
    if (error instanceof ChunkingActivationRefused) return refusalResponse('rollback', null, error);
    return chunkingUnavailable('rollback', null, error);
  }
}
