import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { rollbackEmbeddingProfile } from '@/lib/rag';
import { invalidRequest, jsonNoStore, profileUnavailable, refusalResponse } from '../_responses';

export const runtime = 'nodejs';

/** The rollback takes no input: an actor or any other key is refused, the actor is the verified admin. */
const BodySchema = z.object({}).strict();

/** Restores the previously active profile through the SQL gate, which refuses when that profile no longer has a vector for every chunk. */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

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

  try {
    const result = await rollbackEmbeddingProfile(admin.userId);
    if (!result.ok) return refusalResponse('rollback', null, result);
    console.log('[Embedding Profile] admin action', { action: 'rollback', profileId: result.restored });
    return jsonNoStore({ success: true, restored: result.restored, rolled_back: result.rolledBack });
  } catch (error) {
    return profileUnavailable('rollback', null, error);
  }
}
