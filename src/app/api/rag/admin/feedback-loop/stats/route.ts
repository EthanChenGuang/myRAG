import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { computeFeedbackLoopStats, isStatsWindowError, parseMiningDate, StatsError } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const StatsDate = z.string().max(64).transform((text, context) => {
  const date = parseMiningDate(text) ?? (z.string().datetime({ offset: true }).safeParse(text).success ? new Date(text) : null);
  if (!date || !Number.isFinite(date.getTime())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'expected YYYY-MM-DD or an ISO 8601 date-time' });
    return z.NEVER;
  }
  return date;
});

const StatsQuery = z.object({ since: StatsDate.optional(), until: StatsDate.optional() }).strict();

function badRequest(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 400, headers: NO_STORE });
}

function unavailable(code?: string): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Loop statistics are unavailable', ...(code ? { code } : {}) },
    { status: 503, headers: NO_STORE },
  );
}

/**
 * D-25: aggregate feedback-loop statistics per tenant hash for [since, until). requireAdminOrDeny runs before anything else;
 * the window is at most 92 days and defaults to the last 7. Counts and rates only: no tenant key, query or answer text.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key in raw) return badRequest('since and until may appear once each');
    raw[key] = value;
  }
  const parsed = StatsQuery.safeParse(raw);
  if (!parsed.success) return badRequest('since and until must be YYYY-MM-DD or ISO 8601 date-times, and no other parameter is accepted');

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const stats = await computeFeedbackLoopStats(parsed.data, { client: admin });
    return NextResponse.json({ success: true, stats }, { headers: NO_STORE });
  } catch (error) {
    if (isStatsWindowError(error)) return badRequest('since must be before until, and the window at most 92 days');
    const code = error instanceof StatsError ? error.code : 'unknown';
    console.error('[Feedback Loop] stats failed', { code });
    return unavailable(code);
  }
}
