import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getReviewItem, isReviewItemId } from '@/lib/rag/feedback-loop/review-access';
import { openReviewSession, REVIEW_NO_STORE, reviewNotFound, reviewUnavailable } from '@/lib/rag/feedback-loop/review-route';

export const runtime = 'nodejs';

/** D-16: one review item read through RLS, with the masked answer of its own linked chat for chat items. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await openReviewSession();
  if (!session.ok) return session.response;

  const { id } = await context.params;
  if (!isReviewItemId(id)) return reviewNotFound();

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return reviewUnavailable();
    const result = await getReviewItem(session.ssr, admin, id);
    if (!result.ok) {
      if (result.reason === 'not_found') return reviewNotFound();
      return NextResponse.json({ error: 'Review item unavailable' }, { status: 500, headers: REVIEW_NO_STORE });
    }
    return NextResponse.json(result.item, { headers: REVIEW_NO_STORE });
  } catch {
    console.error('[Review] item read failed');
    return reviewUnavailable();
  }
}
