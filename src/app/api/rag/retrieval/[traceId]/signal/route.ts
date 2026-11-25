import { NextRequest, NextResponse } from 'next/server';
import { SourceSignalRequestSchema } from '@/lib/rag-eval/contracts.generated';
import { readFeedbackLoopConfig } from '@/lib/rag/feedback-loop/config';
import { openRetrievalRequest, RETRIEVAL_NO_STORE, retrievalNotFound, retrievalUnavailable } from '@/lib/rag/feedback-loop/retrieval-route';
import { recordSourceOpened } from '@/lib/rag/feedback-loop/votes';

export const runtime = 'nodejs';

/** D-12: the caller opened a source of their own retrieval; at most 20 per row. Every miss answers the same 404. */
export async function POST(request: NextRequest, context: { params: Promise<{ traceId: string }> }): Promise<NextResponse> {
  if (!readFeedbackLoopConfig().sourceOpenSignal) return retrievalNotFound();

  const input = await openRetrievalRequest(request, SourceSignalRequestSchema);
  if (!input.ok) return input.response;

  const { traceId } = await context.params;
  const result = await recordSourceOpened({ traceId, userId: input.userId });
  if (!result.found) return result.unavailable ? retrievalUnavailable() : retrievalNotFound();
  return new NextResponse(null, { status: 204, headers: RETRIEVAL_NO_STORE });
}
