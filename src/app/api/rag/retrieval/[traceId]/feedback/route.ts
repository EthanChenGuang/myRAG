import { NextRequest, NextResponse } from 'next/server';
import {
  openRetrievalRequest,
  readFeedbackLoopConfig,
  RETRIEVAL_NO_STORE,
  retrievalNotFound,
  retrievalUnavailable,
  setRefusalVote,
  traceHash,
} from '@/lib/rag';
import { RefusalFeedbackRequestSchema } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';

/**
 * D-08: the caller's vote on their own refusal ("I expected an answer" or "correct, not in my documents"). The switch off, an unknown
 * or malformed trace id, another user's row and a row that is not a refusal all answer the same 404.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ traceId: string }> }): Promise<NextResponse> {
  if (!readFeedbackLoopConfig().refusalFeedback) return retrievalNotFound();

  const input = await openRetrievalRequest(request, RefusalFeedbackRequestSchema);
  if (!input.ok) return input.response;

  const { traceId } = await context.params;
  const result = await setRefusalVote({ traceId, userId: input.userId, request: input.body });
  if (!result.found) return result.unavailable ? retrievalUnavailable() : retrievalNotFound();

  console.log(`[Feedback Loop] ${JSON.stringify({ event: 'refusal_vote', vote: result.vote, reasons: result.reasons.length, trace: traceHash(traceId) })}`);
  return NextResponse.json({ vote: result.vote, reasons: result.reasons, at: result.at }, { headers: RETRIEVAL_NO_STORE });
}
