import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { createClient } from '@/lib/supabase/server';
import { readOwnedAnswerRecord } from '@/lib/answers/store';
import { answerFeedbackEnabled, citedDocumentIds, documentStatuses, toAnswerRecord } from '@/lib/answers/read';
import { AnswerRecordSchema } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ answerId: z.string().uuid() });
const NOT_FOUND = { error: 'Answer not found' };

export async function GET(_request: NextRequest, context: { params: Promise<{ answerId: string }> }): Promise<NextResponse> {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  let userId: string | null;
  try {
    supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    userId = data?.user?.id ?? null;
  } catch {
    console.error('[RAG Answers] session lookup failed');
    return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
  }
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid request data',
        details: parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      { status: 400 },
    );
  }

  try {
    const row = await readOwnedAnswerRecord(supabase, { id: parsed.data.answerId, userId });
    if (!row) return NextResponse.json(NOT_FOUND, { status: 404 });
    const documents = await documentStatuses(supabase, citedDocumentIds(row));
    const body = AnswerRecordSchema.safeParse(toAnswerRecord(row, new Date(), documents, { feedbackEnabled: answerFeedbackEnabled() }));
    if (!body.success) {
      console.error('[RAG Answers] stored record failed the contract', { issues: body.error.errors.length });
      return NextResponse.json({ error: 'Answer record unavailable' }, { status: 500 });
    }
    return NextResponse.json(body.data);
  } catch {
    console.error('[RAG Answers] record read failed');
    return NextResponse.json({ error: 'Answer record unavailable' }, { status: 500 });
  }
}
