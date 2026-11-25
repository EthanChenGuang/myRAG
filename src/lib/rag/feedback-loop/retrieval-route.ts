import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { z } from 'zod/v3';
import { validateRequest } from '@/lib/api-middleware';

export const RETRIEVAL_NO_STORE = { 'Cache-Control': 'no-store' };
/** One body for a switch that is off, an unknown or malformed trace id, another user's row and a row that is not a refusal. */
export const RETRIEVAL_NOT_FOUND = { error: 'Not found' };

export function retrievalNotFound(): NextResponse {
  return NextResponse.json(RETRIEVAL_NOT_FOUND, { status: 404, headers: RETRIEVAL_NO_STORE });
}

export function retrievalUnavailable(): NextResponse {
  return NextResponse.json({ error: 'Feedback unavailable' }, { status: 503, headers: RETRIEVAL_NO_STORE });
}

/** A short sha256 prefix for [Feedback Loop] lines; the trace id itself is never logged. */
export function traceHash(traceId: string): string {
  return createHash('sha256').update(traceId).digest('hex').slice(0, 12);
}

export type RetrievalRouteInput<T> = { ok: true; userId: string; body: T } | { ok: false; response: NextResponse };

function isJson(request: NextRequest): boolean {
  const type = request.headers.get('content-type') ?? '';
  return type.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Entry of /api/rag/retrieval/{traceId}/feedback and /signal, after the route checked its switch: 401 without a Supabase session,
 * 503 when the session cannot be checked, 415 for anything but application/json (with SameSite cookies this blocks form CSRF),
 * 400 for malformed JSON or a body outside the schema. The user id comes from the session only.
 */
export async function openRetrievalRequest<S extends z.ZodTypeAny>(request: NextRequest, schema: S): Promise<RetrievalRouteInput<z.infer<S>>> {
  let userId: string | null;
  try {
    const { createClient } = await import('@/lib/supabase/server');
    const ssr = await createClient();
    const { data } = await ssr.auth.getUser();
    userId = data?.user?.id ?? null;
  } catch {
    console.error('[Feedback Loop] session lookup failed');
    return { ok: false, response: NextResponse.json({ error: 'Authentication unavailable' }, { status: 503, headers: RETRIEVAL_NO_STORE }) };
  }
  if (!userId) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: RETRIEVAL_NO_STORE }) };

  if (!isJson(request)) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Content-Type must be application/json' }, { status: 415, headers: RETRIEVAL_NO_STORE }),
    };
  }
  // validateRequest echoes the parser's message, which can quote the body; parse a copy first so it never sees malformed JSON.
  try {
    await request.clone().json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Failed to parse request body', details: [{ path: '', message: 'Body must be valid JSON' }] },
        { status: 400, headers: RETRIEVAL_NO_STORE },
      ),
    };
  }
  const body = await validateRequest(request, schema);
  if (!body.success) {
    body.response.headers.set('Cache-Control', 'no-store');
    return { ok: false, response: body.response };
  }
  return { ok: true, userId, body: body.data };
}
