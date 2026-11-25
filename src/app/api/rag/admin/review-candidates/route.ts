import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listReviewCandidates } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const WindowSchema = z
  .object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
  .refine((value) => Date.parse(value.from) <= Date.parse(value.to), { message: 'from must not be later than to', path: ['from'] });

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'Review candidates are unavailable' }, { status: 503, headers: NO_STORE });
}

/**
 * D-19: flagged answer records in a time window for the review queue (python -m rag_eval.review_queue pull --source db).
 * The S7 admin guard (checkAdmin/adminDenied, the two halves of requireAdminOrDeny) runs before anything is read; the verified
 * admin id is needed to resolve the tenants in SQL.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const url = new URL(request.url);
  const parsed = WindowSchema.safeParse({ from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid request data',
        details: parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const result = await listReviewCandidates(admin, {
      actorUserId: guard.userId,
      from: new Date(parsed.data.from).toISOString(),
      to: new Date(parsed.data.to).toISOString(),
    });
    if (!result.ok) return unavailable();
    console.log('[RAG Admin] review candidates listed', { count: result.items.length });
    return NextResponse.json({ items: result.items }, { headers: NO_STORE });
  } catch {
    console.error('[RAG Admin] review candidates read failed');
    return unavailable();
  }
}
