import { syncAccessStatus } from '@/lib/rag';
import { requireAccessOperator } from '../../_auth';
import { TAG, enforcementStatusOf, failureOf, ok, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

/**
 * A-03: "Sync enforcement" runs the startup sync (writes the database flag to match the running switch, reruns the readiness checks) and
 * answers like GET status. A failed flag write is a reason in the verdict, which then stays not ready; it is not an HTTP error.
 */
export async function POST(request: Request): Promise<Response> {
  const operator = await requireAccessOperator(request);
  if (!operator.ok) return operator.response;
  try {
    const status = await syncAccessStatus(serviceDeps(request));
    console.log(`${TAG} enforcement synced`, { action: 'access_enforcement_sync', status: status.status, reasons: status.reasons });
    return ok({ status: enforcementStatusOf(status) });
  } catch (error) {
    return failureOf(error);
  }
}
