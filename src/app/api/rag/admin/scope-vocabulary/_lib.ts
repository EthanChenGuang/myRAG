import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminWorkspaceDenied } from '@/lib/admin-route-auth';
import type { AdminWorkspaceResult } from '@/lib/admin-route-auth';
import { scopeTagsEnabled, type ScopeFailure, type VocabularyEntry } from '@/lib/rag';

/**
 * Shared helpers of the scope tag routes (scope-vocabulary, documents, documents/[id]/scopes). Scope tags narrow retrieval inside the
 * caller's tenant; they are not permissions, and nothing here describes or uses them as access control.
 */
const NO_STORE = { 'Cache-Control': 'no-store' };

export const OrganizationIdSchema = z.string().max(64).nullish();

export type Details = Array<{ path: string; message: string }>;

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function invalidRequest(details: Details): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

export function issues(error: z.ZodError): Details {
  return error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** RAG_SCOPE_TAGS=false: every scope tag route answers 404 before any lookup, and nothing is written. */
export function switchedOff(): NextResponse | null {
  return scopeTagsEnabled() ? null : jsonNoStore({ success: false, error: 'Not found' }, 404);
}

export type Admission = { ok: true; actorUserId: string; tenantKey: string } | { ok: false; response: NextResponse };

/** The verified actor and the one workspace tenant key the request may act on, or the denial. */
export function admission(result: AdminWorkspaceResult): Admission {
  if (!result.ok) return { ok: false, response: adminWorkspaceDenied(result) };
  return { ok: true, actorUserId: result.userId, tenantKey: result.tenantKey };
}

/** Reads a JSON body; a missing or malformed body is the 400 answer. */
export async function jsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: invalidRequest([{ path: '', message: 'Body is not valid JSON' }]) };
  }
}

/**
 * Fixed answers for the reason words of the service (UI-SPEC 8.2). An unknown id and another workspace's id get the same 404 body, so ids
 * cannot be probed; a database message never reaches the answer.
 */
export function scopeFailure(reason: ScopeFailure, notFound = 'Document not found'): NextResponse {
  switch (reason) {
    case 'not_found':
      return jsonNoStore({ success: false, error: notFound }, 404);
    case 'not_admin':
      return jsonNoStore({ success: false, error: 'Forbidden' }, 403);
    case 'tag_exists':
      return jsonNoStore({ success: false, error: 'tag_exists' }, 409);
    case 'unknown_scope_value':
    case 'too_many_scopes':
    case 'value_immutable':
    case 'invalid_dimension':
    case 'invalid_value':
    case 'invalid_label':
    case 'invalid_aliases':
      return jsonNoStore({ success: false, error: reason }, 400);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    default:
      return jsonNoStore({ success: false, error: 'Scope tag administration is unavailable' }, 503);
  }
}

/** An explicit allow-list: the tenant key, creator and any later column stay out of the answer until added here on purpose. */
export function projectEntry(item: VocabularyEntry) {
  return {
    id: item.id,
    dimension: item.dimension,
    value: item.value,
    label: item.label,
    aliases: item.aliases,
    active: item.active,
    updated_at: item.updatedAt,
  };
}
