import { isAdminUser, type RagAdminDb } from '@/lib/rag';

export type KbWriteAccess =
  | { ok: true; isAdmin: boolean }
  | { ok: false; status: 403 | 503; error: string };

/**
 * Single-tenant knowledge-base writes: an admin always passes; anyone else passes only while
 * admin_settings.read_only_doc_dashboard is off. Any lookup failure refuses the write.
 */
export async function checkSingleTenantKbWrite(input: {
  admin: RagAdminDb;
  userId: string;
  signal: AbortSignal;
}): Promise<KbWriteAccess> {
  try {
    if (await isAdminUser(input.admin, input.userId, input.signal)) return { ok: true, isAdmin: true };
  } catch {
    console.error('[KB Write] Admin lookup failed');
    return { ok: false, status: 503, error: 'Authorization unavailable' };
  }

  const { data, error } = await input.admin
    .from('admin_settings')
    .select('read_only_doc_dashboard')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[KB Write] Settings lookup failed', { code: error.code });
    return { ok: false, status: 503, error: 'Authorization unavailable' };
  }
  if ((data as { read_only_doc_dashboard?: unknown } | null)?.read_only_doc_dashboard === true) {
    return { ok: false, status: 403, error: 'Knowledge base changes are restricted to administrators' };
  }
  return { ok: true, isAdmin: false };
}
