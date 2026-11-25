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
