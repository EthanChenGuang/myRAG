import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { readFeedbackLoopConfig } from './config';

export const REVIEW_NO_STORE = { 'Cache-Control': 'no-store' };
/** One body for a missing, malformed and not-visible item, so an id of another tenant cannot be told apart. */
export const REVIEW_NOT_FOUND = { error: 'Review item not found' };

export function reviewNotFound(): NextResponse {
  return NextResponse.json(REVIEW_NOT_FOUND, { status: 404, headers: REVIEW_NO_STORE });
}

export function reviewUnavailable(): NextResponse {
  return NextResponse.json({ error: 'Review queue unavailable' }, { status: 503, headers: REVIEW_NO_STORE });
}

export type ReviewSession = { ok: true; ssr: SupabaseClient; userId: string } | { ok: false; response: NextResponse };

/**
 * Entry of every /api/rag/review/* route: 404 while RAG_DOMAIN_EXPERT_REVIEW is off (the routes do not exist then), 401 without a
 * Supabase session, 503 when the session cannot be checked. The returned SSR client carries the caller's session, so RLS decides.
 */
export async function openReviewSession(): Promise<ReviewSession> {
  if (!readFeedbackLoopConfig().domainExpertReview) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404, headers: REVIEW_NO_STORE }) };
  }
  try {
    const ssr = await createClient();
    const { data } = await ssr.auth.getUser();
    const userId = data?.user?.id ?? null;
    if (!userId) {
      return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: REVIEW_NO_STORE }) };
    }
    return { ok: true, ssr: ssr as unknown as SupabaseClient, userId };
  } catch {
    console.error('[Review] session lookup failed');
    return { ok: false, response: NextResponse.json({ error: 'Authentication unavailable' }, { status: 503, headers: REVIEW_NO_STORE }) };
  }
}
