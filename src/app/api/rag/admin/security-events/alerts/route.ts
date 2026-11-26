import { z } from 'zod/v3';
import { listSecurityAlerts, readSecuritySettings } from '@/lib/rag/security/security-admin';
import { admitSecurityActor, CURSOR_PATTERN, cursorOffset, invalidRequest, jsonNoStore, securityFailure, zodDetails } from '../_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({ cursor: z.string().regex(CURSOR_PATTERN).optional() }).strict();

/** D-45, UI-SPEC 6.13.1 and 6.13.2: open and acknowledged alerts with the effective hold mode and alert level. */
export async function GET(request: Request): Promise<Response> {
  const admission = await admitSecurityActor(request);
  if (!admission.ok) return admission.response;

  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) return invalidRequest(zodDetails(parsed.error.errors));

  const settings = readSecuritySettings();
  const result = await listSecurityAlerts(admission.db, admission.actor, { offset: cursorOffset(parsed.data.cursor) }, settings);
  if (!result.ok) return securityFailure(result.reason);
  console.log('[RAG Admin] security alerts listed', { count: result.items.length, open: result.openCount });
  return jsonNoStore({
    success: true,
    events_recorded: settings.eventsRecorded,
    hold_mode: settings.holdMode,
    alert_level: settings.alertLevel,
    window_hours: settings.windowHours,
    open_count: result.openCount,
    items: result.items,
    next_cursor: result.nextCursor,
  });
}
