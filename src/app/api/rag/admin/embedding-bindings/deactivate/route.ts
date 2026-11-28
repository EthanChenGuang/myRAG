import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { deactivateBinding } from '@/lib/rag';
import { BindingKeySchema, adminActor, bindingsUnavailable, invalidRequest, issues, jsonNoStore, readJsonBody, refusalResponse } from '../_responses';

export const runtime = 'nodejs';

/** Sets the active binding of (doc type, tenant) to available: that key falls back to the global profile alone (D-10). */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const parsed = BindingKeySchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  try {
    const result = await deactivateBinding(parsed.data.doc_type, parsed.data.tenant_key, adminActor(admin.userId));
    if (!result.ok) return refusalResponse('deactivate', null, result);
    console.log('[Embedding Binding] admin action', { action: 'deactivate', bindingId: result.deactivated });
    return jsonNoStore({ success: true, deactivated: result.deactivated });
  } catch (error) {
    return bindingsUnavailable('deactivate', null, error);
  }
}
