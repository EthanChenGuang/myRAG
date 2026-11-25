export type ToolSessionResult = { ok: true; userId: string } | { ok: false; status: 401 | 503; error: string };

export async function getToolSessionUser(): Promise<ToolSessionResult> {
  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const id = data?.user?.id;
    if (!id) return { ok: false, status: 401, error: 'Unauthorized' };
    return { ok: true, userId: id };
  } catch (error) {
    console.error('[ToolExecutionAuth] Session lookup failed:', error instanceof Error ? error.message : 'unknown error');
    return { ok: false, status: 503, error: 'Authentication unavailable' };
  }
}

export function toolApprovalEntryOwner(toolCallId: string): { exists: boolean; ownerUserId: string | null } {
  const state = (globalThis as { toolApprovalState?: Record<string, { ownerUserId?: string | null } | undefined> }).toolApprovalState;
  const entry = state?.[toolCallId];
  return { exists: !!entry, ownerUserId: entry?.ownerUserId ?? null };
}
