import { acknowledgeSecurityAlert } from '@/lib/rag/security/security-admin';
import { admitSecurityActor, jsonNoStore, securityFailure } from '../../../_responses';

export const runtime = 'nodejs';

/** D-45: acknowledges an alert of an administered tenant. The tenant comes from the alert row; no body is read. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admission = await admitSecurityActor(request);
  if (!admission.ok) return admission.response;

  const { id } = await context.params;
  const result = await acknowledgeSecurityAlert(admission.db, admission.actor, id);
  if (!result.ok) return securityFailure(result.reason);
  return jsonNoStore({ success: true, id: result.alertId, tenant_key: result.tenantKey, status: 'acknowledged' });
}
