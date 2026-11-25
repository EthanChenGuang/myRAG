import { NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { readFeedbackLoopConfig } from '@/lib/rag/feedback-loop/config';
import { purgeRetrievalLog, PurgeError } from '@/lib/rag/feedback-loop/purge';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'The retrieval log purge is unavailable' }, { status: 503, headers: NO_STORE });
}

/** D-06: an operator admin purges expired retrieval log rows and expired open review items. requireAdminOrDeny runs before anything else. */
export async function POST(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const { retentionDays } = readFeedbackLoopConfig();
    const counts = await purgeRetrievalLog(admin, retentionDays);
    console.log('[Feedback Loop] purge done', counts);
    return NextResponse.json({ success: true, retentionDays, ...counts }, { headers: NO_STORE });
  } catch (error) {
    console.error('[Feedback Loop] purge failed', { code: error instanceof PurgeError ? error.code : 'unknown' });
    return unavailable();
  }
}
