import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { BINDING_DOC_TYPES, ProfileUnavailableError } from '@/lib/rag';
import type { BindingRefusal } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The profile ids the registry and the CLI use: lowercase letters, digits, dots, underscores and hyphens. */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The tenant keys a binding may name: the single-tenant key or a user or organization key. Null means deployment-wide. */
export const TENANT_KEY_PATTERN = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const DocTypeSchema = z.enum(BINDING_DOC_TYPES);
/** Required and explicit: a string for one tenant, null for the deployment-wide binding. */
export const TenantKeySchema = z.string().regex(TENANT_KEY_PATTERN).nullable();
export const BindingKeySchema = z.object({ doc_type: DocTypeSchema, tenant_key: TenantKeySchema }).strict();

export type BindingAction = 'list' | 'create' | 'set_status' | 'activate' | 'rollback' | 'deactivate';

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

export function issues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** The JSON body, or a 400 response. An empty body reads as `{}`. */
export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const raw = await request.text();
  if (raw.trim() === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: invalidRequest([{ path: '', message: 'Body is not valid JSON' }]) };
  }
}

/** The gate records who flipped a binding: the verified admin. */
export function adminActor(userId: string): string {
  return `admin:${userId}`;
}

/** The registry, the database or the response was not usable. Only the reason word is logged; the body names no cause. */
export function bindingsUnavailable(action: BindingAction, bindingId: string | null, error: unknown): NextResponse {
  const reason = error instanceof ProfileUnavailableError ? error.reason : 'unexpected';
  console.error('[Embedding Binding] admin action failed', { action, bindingId, reason });
  return jsonNoStore({ success: false, error: 'embedding_registry_unavailable' }, 503);
}

const MAX_DETAIL_CHARS = 300;

/** A named refusal of the 0441 gate: 409 with the gate's code and its own message (ids and counts only, capped). An actor refusal is our fault, not the caller's: 503. */
export function refusalResponse(action: BindingAction, bindingId: string | null, refusal: BindingRefusal): NextResponse {
  if (/: actor_required$/.test(refusal.reason)) return bindingsUnavailable(action, bindingId, new Error('actor_required'));
  console.warn('[Embedding Binding] admin action refused', { action, bindingId, reason: refusal.reason });
  const detail = refusal.detail.startsWith(refusal.reason) ? refusal.detail.slice(0, MAX_DETAIL_CHARS) : refusal.reason;
  return jsonNoStore({ success: false, error: 'binding_refused', reason: refusal.reason, detail }, 409);
}
