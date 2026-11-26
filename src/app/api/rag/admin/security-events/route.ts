import { z } from 'zod/v3';
import { listSecurityEvents, readSecuritySettings, SECURITY_EVENT_SOURCES } from '@/lib/rag';
import { admitSecurityActor, CURSOR_PATTERN, cursorOffset, invalidRequest, jsonNoStore, securityFailure, zodDetails } from './_responses';

export const runtime = 'nodejs';

const QuerySchema = z
  .object({
    source: z.enum(SECURITY_EVENT_SOURCES).optional(),
    uploader: z.string().uuid().optional(),
    since: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().regex(CURSOR_PATTERN).optional(),
  })
  .strict();

/** D-47, UI-SPEC 6.13.2: security events of the tenants the caller administers, newest first, 50 per page. Ids, names and counts only. */
export async function GET(request: Request): Promise<Response> {
  const admission = await admitSecurityActor(request);
  if (!admission.ok) return admission.response;

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) return invalidRequest(zodDetails(parsed.error.errors));

  const { source, uploader, since, cursor } = parsed.data;
  const result = await listSecurityEvents(admission.db, admission.actor, { source, uploader, since, offset: cursorOffset(cursor) });
  if (!result.ok) return securityFailure(result.reason);
  console.log('[RAG Admin] security events listed', { count: result.items.length, tenants: admission.actor.tenantKeys.length });
  return jsonNoStore({
    success: true,
    events_recorded: readSecuritySettings().eventsRecorded,
    items: result.items,
    next_cursor: result.nextCursor,
  });
}
