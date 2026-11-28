import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  isReviewItemId,
  openReviewSession,
  REVIEW_NO_STORE,
  reviewNotFound,
  reviewUnavailable,
  ReviewSearchRequestSchema,
  searchForReviewItem,
} from '@/lib/rag';

export const runtime = 'nodejs';

/** D-19: search the visible item's own tenant for evidence the retrieval missed; the scope never comes from the body. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await openReviewSession();
  if (!session.ok) return session.response;

  const { id } = await context.params;
  if (!isReviewItemId(id)) return reviewNotFound();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400, headers: REVIEW_NO_STORE });
  }
  const parsed = ReviewSearchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid search',
        details: parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      { status: 400, headers: REVIEW_NO_STORE },
    );
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return reviewUnavailable();
    const result = await searchForReviewItem(session.ssr, admin, id, parsed.data.query, session.userId);
    if (result.ok) return NextResponse.json({ item_id: result.item_id, hits: result.hits }, { headers: REVIEW_NO_STORE });
    if (result.reason === 'not_found') return reviewNotFound();
    return reviewUnavailable();
  } catch {
    console.error('[Review] search failed');
    return reviewUnavailable();
  }
}
