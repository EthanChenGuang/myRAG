import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { isMiningWindowError, miningDisabledReason, MiningError, parseMiningDate, runMining } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const MiningDate = z.string().max(64).transform((text, context) => {
  const date = parseMiningDate(text) ?? (z.string().datetime({ offset: true }).safeParse(text).success ? new Date(text) : null);
  if (!date || !Number.isFinite(date.getTime())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'expected YYYY-MM-DD or an ISO 8601 date-time' });
    return z.NEVER;
  }
  return date;
});

const MineBody = z.object({ since: MiningDate.optional(), until: MiningDate.optional() }).strict();

function badRequest(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 400, headers: NO_STORE });
}

function unavailable(code?: string): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Mining is unavailable', ...(code ? { code } : {}) },
    { status: 503, headers: NO_STORE },
  );
}

/**
 * D-15: an operator admin (the Config UI button, or a scheduler with an admin credential) purges the expired log, then mines
 * [since, until) into the review queue. requireAdminOrDeny runs before anything else; the window is at most 31 days and defaults to
 * the last window_days. 404 unless RAG_DOMAIN_EXPERT_REVIEW is true and RAG_RETRIEVAL_LOG is masked_query.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  if (miningDisabledReason()) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404, headers: NO_STORE });
  }

  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return badRequest('The body must be JSON');
  }
  const parsed = MineBody.safeParse(raw);
  if (!parsed.success) return badRequest('since and until must be YYYY-MM-DD or ISO 8601 date-times, and no other field is accepted');

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const result = await runMining(parsed.data, { client: admin });
    return NextResponse.json({ success: true, result }, { headers: NO_STORE });
  } catch (error) {
    if (isMiningWindowError(error)) return badRequest('since must be before until, and the window at most 31 days');
    const code = error instanceof MiningError ? error.code : 'unknown';
    console.error('[Feedback Loop] mining failed', { code });
    return unavailable(code);
  }
}
