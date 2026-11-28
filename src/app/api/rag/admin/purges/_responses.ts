import { NextResponse } from 'next/server';
import type { PurgeCheck, PurgeFailure } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The same body for another tenant's id and an unknown id, so ids are not probed. */
export function purgeFailure(reason: PurgeFailure): NextResponse {
  switch (reason) {
    case 'not_found':
    case 'tenant_mismatch':
      return jsonNoStore({ success: false, error: 'not_found' }, 404);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'invalid_request' }, 400);
    default:
      return jsonNoStore({ success: false, error: 'purge_unavailable' }, 503);
  }
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'invalid_request', details }, 400);
}

/** The check of a purge on the wire (UI-SPEC 8.1): counts only, never a file name, path or hash. */
export function checkBody(check: PurgeCheck) {
  return { left: check.left, pending_files: check.pendingFiles, queued_external: check.queuedExternal, result: check.result };
}
