import { NextResponse } from 'next/server';
import { FingerprintImpactError } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'invalid_request', details }, 400);
}

/** A read failure: the reason code only, never the database message. */
export function fingerprintUnavailable(action: 'impact' | 'coverage', error: unknown): NextResponse {
  const code = error instanceof FingerprintImpactError ? error.code : 'unexpected';
  console.error('[RAG Admin] ingest fingerprint read failed', { action, code });
  return jsonNoStore({ success: false, error: 'fingerprint_unavailable' }, 503);
}

/** A rebuild read or write that failed for an environment or database reason: the code is logged, never the database message. */
export function rebuildUnavailable(action: 'start' | 'activate' | 'rollback' | 'list', error: unknown): NextResponse {
  const code = error instanceof Error ? error.name : 'unexpected';
  console.error('[RAG Admin] rebuild failed', { action, code });
  return jsonNoStore({ success: false, error: 'rebuild_unavailable' }, 503);
}

/** An empty body, `{}` or no body at all; anything else is refused. */
export async function emptyJsonBody(request: Request): Promise<NextResponse | null> {
  const raw = await request.text();
  if (raw.trim() === '') return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0) return null;
  return invalidRequest([{ path: '', message: 'This action takes no body' }]);
}
