import { NextRequest, NextResponse } from 'next/server';
import { listReviewItems, openReviewSession, REVIEW_NO_STORE, ReviewListQuerySchema, reviewUnavailable } from '@/lib/rag';

export const runtime = 'nodejs';

/** D-16: the caller's visible review items, newest first, at most 50 per page. Filters: status, reason, language; no tag filter (D-29). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await openReviewSession();
  if (!session.ok) return session.response;

  const params = request.nextUrl.searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) raw[key] = value;
  const parsed = ReviewListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid request data',
        details: parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      { status: 400, headers: REVIEW_NO_STORE },
    );
  }

  try {
    const result = await listReviewItems(session.ssr, parsed.data);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: 'Invalid request data', details: [{ path: 'cursor', message: 'Invalid cursor' }] },
        { status: 400, headers: REVIEW_NO_STORE },
      );
    }
    return NextResponse.json({ items: result.items, next_cursor: result.next_cursor }, { headers: REVIEW_NO_STORE });
  } catch {
    console.error('[Review] item list failed');
    return reviewUnavailable();
  }
}
