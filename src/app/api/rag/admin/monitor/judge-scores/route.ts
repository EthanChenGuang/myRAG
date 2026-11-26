import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { monitorSettings } from '@/lib/rag/monitor/config';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_JUDGE_SCORES = 500;

const ScoreSchema = z
  .object({
    trace_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    metric: z.enum(['faithfulness', 'answer_relevance']),
    score: z.number().finite().min(0).max(1),
    judge_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/),
  })
  .strict();

const BodySchema = z.object({ scores: z.array(ScoreSchema).min(1).max(MAX_JUDGE_SCORES) }).strict();

function answer(status: 400 | 404 | 503, error: string, details?: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json({ success: false, error, ...(details ? { details } : {}) }, { status, headers: NO_STORE });
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * D-23, D-55: mirrors online judge scores (trace id, metric, score, judge id; numbers and codes only) so the monitor never reads
 * Langfuse. The body carries no tenant: rag_online_judge_scores_record takes it from the retrieval log row of each trace and drops
 * scores whose trace is in no log row. 404 while RAG_MONITOR is off, before the admin check.
 */
export async function POST(request: Request): Promise<Response> {
  if (!monitorSettings().monitor) return answer(404, 'Not found');
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return answer(400, 'Invalid JSON body');
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return answer(
      400,
      'Invalid request data',
      parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return answer(503, 'Judge score mirror is unavailable');
    const { data, error } = await admin.rpc('rag_online_judge_scores_record', { p_scores: parsed.data.scores });
    const row = (Array.isArray(data) ? data[0] : data) as { stored?: unknown; dropped?: unknown } | null | undefined;
    const stored = countOf(row?.stored);
    const dropped = countOf(row?.dropped);
    if (error || stored === null || dropped === null) {
      console.error('[Monitor] judge score mirror failed', { code: (error as { code?: string } | null)?.code ?? null });
      return answer(503, 'Judge score mirror is unavailable');
    }
    console.log('[Monitor] judge scores mirrored', { received: parsed.data.scores.length, stored, dropped });
    return NextResponse.json({ stored, dropped }, { headers: NO_STORE });
  } catch {
    console.error('[Monitor] judge score mirror failed');
    return answer(503, 'Judge score mirror is unavailable');
  }
}
