import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { activateEmbeddingProfile } from '@/lib/rag';
import { PROFILE_ID_PATTERN, invalidRequest, jsonNoStore, profileUnavailable, refusalResponse } from '../../_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().regex(PROFILE_ID_PATTERN) });
/** The activation takes no input: an actor or any other key is refused, the actor is the verified admin. */
const BodySchema = z.object({}).strict();

/** Flips the active pointer to one profile through the SQL gate. The gate refuses an incomplete, inconsistent or unproven profile. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  const raw = await request.text();
  if (raw.trim() !== '') {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
    }
    const checked = BodySchema.safeParse(body);
    if (!checked.success) {
      return invalidRequest(checked.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    }
  }

  const profileId = parsed.data.id;
  try {
    const result = await activateEmbeddingProfile(profileId, admin.userId);
    if (!result.ok) return refusalResponse('activate', profileId, result);
    console.log('[Embedding Profile] admin action', { action: 'activate', profileId: result.activated });
    return jsonNoStore({ success: true, activated: result.activated, previous: result.previous });
  } catch (error) {
    return profileUnavailable('activate', profileId, error);
  }
}
