import { z } from 'zod/v3';
import { MAX_RE_REVIEW_ITEMS, enqueueReReview } from '@/lib/rag/monitor/golden-evidence';
import { fail, goldenGuard, invalid, jsonNoStore, readJson, tenantAccess, unavailable } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z
  .object({
    tenant: z.string().min(1).max(64),
    items: z
      .array(z.object({ item_id: z.string().min(1).max(200), question: z.string().min(1).max(4000) }).strict())
      .min(1)
      .max(MAX_RE_REVIEW_ITEMS),
  })
  .strict();

/**
 * D-50: queue golden items due for re-review into the expert queue (reason re_review, this week's mining window). The question is
 * masked and fingerprinted as the 5.1.1 log does; a repeat in the same week inserts nothing. Answers counts only.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await goldenGuard(request);
  if (!guard.ok) return guard.response;
  const raw = await readJson(request);
  if (!raw.ok) return fail(400, 'Invalid JSON body');
  const parsed = Body.safeParse(raw.body);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const access = await tenantAccess(guard.userId, parsed.data.tenant);
    if (!access.ok) return access.response;
    const result = await enqueueReReview(access.admin, {
      tenantKey: access.tenantKey,
      questions: parsed.data.items.map((item) => item.question),
    });
    return jsonNoStore({ success: true, requested: parsed.data.items.length, inserted: result.inserted });
  } catch (error) {
    console.error('[Monitor] golden re-review failed', { code: error instanceof Error ? error.message : 'unknown' });
    return unavailable();
  }
}
