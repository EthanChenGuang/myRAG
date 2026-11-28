import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getReviewItemChunks, isReviewItemId, openReviewSession, REVIEW_NO_STORE, reviewNotFound, reviewUnavailable } from '@/lib/rag';

export const runtime = 'nodejs';

/** D-16: chunk text of one visible item's snapshot, fetched only after the RLS read and only within the item's tenant. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await openReviewSession();
  if (!session.ok) return session.response;

  const { id } = await context.params;
  if (!isReviewItemId(id)) return reviewNotFound();

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return reviewUnavailable();
    const result = await getReviewItemChunks(session.ssr, admin, id, session.userId);
    if (!result.ok) return reviewNotFound();
    return NextResponse.json({ item_id: result.item_id, chunks: result.chunks }, { headers: REVIEW_NO_STORE });
  } catch {
    console.error('[Review] chunk read failed');
    return reviewUnavailable();
  }
}
