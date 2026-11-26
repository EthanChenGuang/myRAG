import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isReviewItemId, openReviewSession, REVIEW_NO_STORE, reviewNotFound, reviewUnavailable } from '@/lib/rag';
import {
  AnswerCheckRequestSchema,
  readAnswerCheck,
  saveAnswerCheck,
  type AnswerCheckFailure,
  type AnswerCheckResult,
} from '@/lib/rag/judge/answer-check';

export const runtime = 'nodejs';

function failure(reason: AnswerCheckFailure): NextResponse {
  switch (reason) {
    case 'not_expert':
      return NextResponse.json({ error: 'Domain expert access required' }, { status: 403, headers: REVIEW_NO_STORE });
    case 'no_answer':
      return NextResponse.json({ error: 'no_answer' }, { status: 409, headers: REVIEW_NO_STORE });
    case 'exported':
      return NextResponse.json({ error: 'Review item already exported' }, { status: 409, headers: REVIEW_NO_STORE });
    default:
      return reviewNotFound();
  }
}

function respond(result: AnswerCheckResult): NextResponse {
  if (!result.ok) return failure(result.reason);
  const { supported, relevant, unsupported_content, labelled_at } = result.check;
  return NextResponse.json({ supported, relevant, unsupported_content, labelled_at }, { headers: REVIEW_NO_STORE });
}

/** D-31: the caller's own answer check of one visible item that has an answer. Never carries a judge score. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await openReviewSession();
  if (!session.ok) return session.response;

  const { id } = await context.params;
  if (!isReviewItemId(id)) return reviewNotFound();

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return reviewUnavailable();
    return respond(await readAnswerCheck(session.ssr, admin, id, session.userId));
  } catch {
    console.error('[Review] answer check read failed');
    return reviewUnavailable();
  }
}

/** D-31: saves the three verdicts (strict body; a tenant or score field is rejected) with the caller's session, so RLS decides. */
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
  const parsed = AnswerCheckRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid answer check',
        details: parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      { status: 400, headers: REVIEW_NO_STORE },
    );
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return reviewUnavailable();
    return respond(await saveAnswerCheck(session.ssr, admin, id, session.userId, parsed.data));
  } catch {
    console.error('[Review] answer check save failed');
    return reviewUnavailable();
  }
}
