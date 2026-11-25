import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/embed-rate-limit';
import { readFeedbackLoopConfig, verifyEmbedFeedbackToken } from '@/lib/rag';
import { EmbedFeedbackRequestSchema } from '@/lib/rag-eval/contracts.generated';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const RESPONSE_HEADERS = { ...CORS_HEADERS, 'Cache-Control': 'no-store', Vary: 'Origin' };
const UPDATE_TIMEOUT_MS = 5000;

/** One body for every failure, so a caller never learns whether the switch, the token or the row was the reason. */
function notFound(): NextResponse {
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404, headers: RESPONSE_HEADERS });
}

function badRequest(): NextResponse {
  return NextResponse.json({ success: false, error: 'Invalid request data' }, { status: 400, headers: RESPONSE_HEADERS });
}

function originAllowed(request: NextRequest): boolean {
  const allowedDomains = env.NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS;
  if (allowedDomains === '*') return true;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return allowedDomains
    .split(',')
    .map((domain: string) => domain.trim())
    .some((domain: string) => (domain.startsWith('*.') ? origin.endsWith(domain.substring(2)) : origin.includes(domain)));
}

function traceHash(traceId: string): string {
  return createHash('sha256').update(traceId).digest('hex').slice(0, 12);
}

/**
 * D-11: an anonymous embed visitor rates one answer. The signed token alone names the trace and the tenant; the body cannot.
 * No cookie or session is read. Only the embed row whose trace_id and tenant_key equal the token's is updated; the latest vote wins.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const config = readFeedbackLoopConfig();
  const embedOn = env.NEXT_PUBLIC_EMBED_ENABLED === 'true' || env.NEXT_PUBLIC_DEMO_MODE === 'true';
  if (!config.embedFeedbackEnabled || !embedOn || !originAllowed(request)) return notFound();

  const rateLimit = checkRateLimit(`embed-feedback:${getRateLimitIdentifier(request)}`);
  if (!rateLimit.allowed) {
    return new NextResponse('Rate limit exceeded', {
      status: 429,
      headers: {
        'X-RateLimit-Limit': env.EMBED_RATE_LIMIT,
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(rateLimit.resetTime).toISOString(),
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest();
  }
  const parsed = EmbedFeedbackRequestSchema.safeParse(raw);
  if (!parsed.success) return badRequest();

  const claims = verifyEmbedFeedbackToken(parsed.data.token, { secret: config.embedFeedbackSecret });
  if (!claims) return notFound();

  const admin = getSupabaseAdmin();
  if (!admin) return notFound();

  const vote = parsed.data.vote;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
    let result: { data: unknown; error: { code?: unknown } | null };
    try {
      result = (await admin
        .from('rag_retrieval_log')
        .update({
          feedback_vote: vote === 'helpful' ? 1 : -1,
          feedback_kind: 'embed',
          feedback_reasons: [...(parsed.data.reasons ?? [])],
          feedback_at: new Date().toISOString(),
        })
        .eq('trace_id', claims.traceId)
        .eq('tenant_key', claims.tenantKey)
        .eq('channel', 'embed')
        .select('id')
        .abortSignal(controller.signal)) as { data: unknown; error: { code?: unknown } | null };
    } finally {
      clearTimeout(timer);
    }
    if (result.error) {
      const code = typeof result.error.code === 'string' && result.error.code !== '' ? result.error.code : 'db_error';
      console.warn('[Feedback Loop] embed vote not stored', { code });
      return notFound();
    }
    if (!Array.isArray(result.data) || result.data.length === 0) return notFound();
  } catch (error) {
    console.warn('[Feedback Loop] embed vote not stored', { code: error instanceof Error ? error.name || 'error' : 'unknown' });
    return notFound();
  }

  console.log('[Feedback Loop] embed vote recorded', { vote, trace: traceHash(claims.traceId) });
  return NextResponse.json({ success: true }, { headers: RESPONSE_HEADERS });
}

export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-cache',
      Vary: 'Origin',
    },
  });
}
