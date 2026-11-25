import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { rollbackBinding } from '@/lib/rag';
import { BindingKeySchema, adminActor, bindingsUnavailable, invalidRequest, issues, jsonNoStore, readJsonBody, refusalResponse } from '../_responses';
import { bindingBody } from '../_binding-body';

export const runtime = 'nodejs';

/** Restores the previous binding of (doc type, tenant) through the gate, which refuses when its index is no longer complete (D-10). */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const parsed = BindingKeySchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  try {
    const result = await rollbackBinding(parsed.data.doc_type, parsed.data.tenant_key, adminActor(admin.userId));
    if (!result.ok) return refusalResponse('rollback', null, result);
    console.log('[Embedding Binding] admin action', { action: 'rollback', bindingId: result.restored.id });
    return jsonNoStore({ success: true, restored: bindingBody(result.restored), rolled_back: result.rolledBack });
  } catch (error) {
    return bindingsUnavailable('rollback', null, error);
  }
}
