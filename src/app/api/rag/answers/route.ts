import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { answerIdsInMessages, attachAnswersToChat, listOwnedAnswerRecordsForChat } from '@/lib/answers/store';
import { answerFeedbackEnabled, citedDocumentIds, documentStatuses, toAnswerRecord } from '@/lib/answers/read';
import { AnswerRecordSchema, type AnswerRecord } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';

const QuerySchema = z.object({ chatId: z.string().uuid() });
const NOT_FOUND = { error: 'Chat not found' };

export async function GET(request: NextRequest): Promise<NextResponse> {
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

  const parsed = QuerySchema.safeParse({ chatId: request.nextUrl.searchParams.get('chatId') ?? undefined });
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
  const { chatId } = parsed.data;

  try {
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('id,user_id,organization_id,messages')
      .eq('id', chatId)
      .eq('user_id', userId)
      .maybeSingle();
    if (chatError) {
      console.error('[RAG Answers] chat lookup failed', { code: chatError.code });
      return NextResponse.json({ error: 'Answer records unavailable' }, { status: 500 });
    }
    const owned = chat as { id: string; user_id: string; organization_id: string | null; messages: unknown } | null;
    if (!owned || owned.user_id !== userId) return NextResponse.json(NOT_FOUND, { status: 404 });

    const answerIds = answerIdsInMessages(owned.messages);
    if (answerIds.length > 0) {
      try {
        await attachAnswersToChat(getSupabaseAdmin(), {
          userId,
          chat: { id: owned.id, organization_id: owned.organization_id ?? null },
          answerIds,
        });
      } catch {
        console.error('[RAG Answers] attach failed');
      }
    }

    const rows = await listOwnedAnswerRecordsForChat(supabase, { chatId: owned.id, userId });
    const documents = await documentStatuses(supabase, [...new Set(rows.flatMap((row) => citedDocumentIds(row)))]);
    const now = new Date();
    const feedbackEnabled = answerFeedbackEnabled();
    const records: AnswerRecord[] = [];
    for (const row of rows) {
      const body = AnswerRecordSchema.safeParse(toAnswerRecord(row, now, documents, { feedbackEnabled }));
      if (!body.success) {
        console.error('[RAG Answers] stored record failed the contract', { issues: body.error.errors.length });
        return NextResponse.json({ error: 'Answer records unavailable' }, { status: 500 });
      }
      records.push(body.data);
    }
    return NextResponse.json({ records });
  } catch {
    console.error('[RAG Answers] chat records read failed');
    return NextResponse.json({ error: 'Answer records unavailable' }, { status: 500 });
  }
}
