import { NextResponse } from 'next/server';
import type { SourceSyncFailure } from '@/lib/nango/source-sync-admin';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The same body for another tenant's id and an unknown id, so ids are not probed (D-41). */
export function sourceSyncFailure(reason: SourceSyncFailure): NextResponse {
  switch (reason) {
    case 'not_found':
      return jsonNoStore({ success: false, error: 'not_found' }, 404);
    case 'run_not_pending':
      return jsonNoStore({ success: false, error: 'run_not_pending' }, 409);
    case 'confirmation_expired':
      return jsonNoStore({ success: false, error: 'confirmation_expired' }, 409);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    default:
      return jsonNoStore({ success: false, error: 'Source sync administration is unavailable' }, 503);
  }
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

export function issuesOf(error: { errors: Array<{ path: Array<string | number>; message: string }> }) {
  return error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Reads an optional JSON body; an empty body is undefined, malformed JSON is an error. */
export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const raw = await request.text();
  if (raw.trim() === '') return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}
