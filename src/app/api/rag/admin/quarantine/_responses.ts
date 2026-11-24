import { NextResponse } from 'next/server';
import { adminDenied } from '@/lib/admin-route-auth';
import type { QuarantineFailure } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The same body for another tenant's document and an unknown id, so ids are not probed. */
export function quarantineFailure(reason: QuarantineFailure): NextResponse {
  switch (reason) {
    case 'not_found':
      return jsonNoStore({ success: false, error: 'Document not found' }, 404);
    case 'not_quarantined':
      return jsonNoStore({ success: false, error: 'Document is not quarantined' }, 409);
    case 'not_admin':
      return adminDenied(403);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    default:
      return jsonNoStore({ success: false, error: 'Quarantine administration is unavailable' }, 503);
  }
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}
