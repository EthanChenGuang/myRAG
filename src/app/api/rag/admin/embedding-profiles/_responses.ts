import { NextResponse } from 'next/server';
import { ProfileUnavailableError } from '@/lib/rag';
import type { ProfileRefusal } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The profile ids the registry and the CLI use: lowercase letters, digits, dots, underscores and hyphens. */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ProfileAction = 'list' | 'activate' | 'rollback';

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

/** Anything the gate did not name: the registry, the database or the response was not usable. Only the reason word is logged and answered. */
export function profileUnavailable(action: ProfileAction, profileId: string | null, error: unknown): NextResponse {
  const reason = error instanceof ProfileUnavailableError ? error.reason : 'unexpected';
  console.error('[Embedding Profile] admin action failed', { action, profileId, reason });
  return jsonNoStore({ success: false, error: 'Embedding profile administration is unavailable' }, 503);
}

const MISSING_COUNT = /^(?:activation|rollback)_refused: incomplete \((\d+) /;

/**
 * A refusal of the gate: 404 for an unknown profile, 409 for every other named refusal, with the gate's own reason and, for an incomplete
 * profile, the number of chunks still missing. The rest of the gate's message is not passed on.
 */
export function refusalResponse(action: 'activate' | 'rollback', profileId: string | null, refusal: ProfileRefusal): NextResponse {
  if (/: actor_required$/.test(refusal.reason)) return profileUnavailable(action, profileId, new Error('actor_required'));
  console.warn('[Embedding Profile] admin action refused', { action, profileId, reason: refusal.reason });
  if (refusal.reason === 'activation_refused: unknown_profile') return jsonNoStore({ success: false, error: 'Profile not found' }, 404);
  const missing = MISSING_COUNT.exec(refusal.detail);
  return jsonNoStore(
    {
      success: false,
      error: action === 'activate' ? 'Activation refused' : 'Rollback refused',
      reason: refusal.reason,
      ...(missing ? { missing_chunks: Number(missing[1]) } : {}),
    },
    409,
  );
}
