import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  isReviewItemId,
  LabelRequestSchema,
  openReviewSession,
  REVIEW_NO_STORE,
  reviewNotFound,
  reviewUnavailable,
  validateAndSaveLabel,
} from '@/lib/rag';

export const runtime = 'nodejs';

function badRequest(body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status: 400, headers: REVIEW_NO_STORE });
}

/** D-18: an expert labels or skips one visible item; every evidence span is checked against current chunk text of the item's tenant. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await openReviewSession();
  if (!session.ok) return session.response;

  const { id } = await context.params;
  if (!isReviewItemId(id)) return reviewNotFound();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest({ success: false, error: 'Invalid JSON body' });
  }
  const parsed = LabelRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest({
      success: false,
      error: 'Invalid label',
      details: parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return reviewUnavailable();
    const result = await validateAndSaveLabel(session.ssr, admin, id, parsed.data, session.userId);
    if (result.ok) {
      const { item_id, status, triage, label, labelled_at } = result;
      return NextResponse.json({ item_id, status, triage, label, labelled_at }, { headers: REVIEW_NO_STORE });
    }
    switch (result.reason) {
      case 'invalid_evidence':
        return badRequest({ error: 'invalid_evidence', span: result.span, reason: result.detail });
      case 'invalid_not_relevant':
        return badRequest({ error: 'invalid_not_relevant', index: result.index, reason: 'not_in_snapshot' });
      case 'exported':
        return NextResponse.json({ error: 'Review item already exported' }, { status: 409, headers: REVIEW_NO_STORE });
      default:
        return reviewNotFound();
    }
  } catch {
    console.error('[Review] label failed');
    return reviewUnavailable();
  }
}
