import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/api-middleware';
import { answerFeedbackEnabled } from '@/lib/answers/read';
import { submitAnswerFeedback } from '@/lib/rag';
import { AnswerFeedbackRequestSchema } from '@/lib/rag-eval/contracts.generated';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const NOT_FOUND = { error: 'Answer not found' };
const NO_STORE = { 'Cache-Control': 'no-store' };

function isJson(request: NextRequest): boolean {
  const type = request.headers.get('content-type') ?? '';
  return type.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** D-17/D-18: the caller's vote on their own answer. Not found, not owned and a malformed id all answer the same 404. */
export async function POST(request: NextRequest, context: { params: Promise<{ answerId: string }> }): Promise<NextResponse> {
  if (!answerFeedbackEnabled()) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });

  let supabase: Awaited<ReturnType<typeof createClient>>;
  let userId: string | null;
  try {
    supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    userId = data?.user?.id ?? null;
  } catch {
    console.error('[RAG Feedback] session lookup failed');
    return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503, headers: NO_STORE });
  }
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });

  if (!isJson(request)) {
    return NextResponse.json({ success: false, error: 'Content-Type must be application/json' }, { status: 415, headers: NO_STORE });
  }

  // validateRequest echoes the parser's message, which can quote the body (the comment); parse a copy first so it never sees malformed JSON.
  try {
    await request.clone().json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to parse request body', details: [{ path: '', message: 'Body must be valid JSON' }] },
      { status: 400, headers: NO_STORE },
    );
  }
  const body = await validateRequest(request, AnswerFeedbackRequestSchema);
  if (!body.success) return body.response;

  const { answerId } = await context.params;
  const result = await submitAnswerFeedback({ answerId, userId, request: body.data, session: supabase });
  if (result.ok) return NextResponse.json({ feedback: result.feedback }, { headers: NO_STORE });
  if (result.reason === 'not_found') return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
  return NextResponse.json({ error: 'Feedback unavailable' }, { status: 503, headers: NO_STORE });
}
