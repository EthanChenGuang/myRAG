import { accessStatus } from '@/lib/rag';
import { requireAccessOperator } from '../_auth';
import { enforcementStatusOf, failureOf, ok, serviceDeps } from '../_responses';

export const runtime = 'nodejs';

/**
 * A-03, D-07, UI-SPEC 6.6: the Enforcement view. Deployment-wide, so only an operator admin reads it: the running switch, the database
 * flag read now, the last readiness verdict with reason codes and object names, the embedded chat group (key, found, name) and the check
 * time. No tenant key and no other group is returned.
 */
export async function GET(request: Request): Promise<Response> {
  const operator = await requireAccessOperator(request);
  if (!operator.ok) return operator.response;
  try {
    return ok({ status: enforcementStatusOf(await accessStatus(serviceDeps(request))) });
  } catch (error) {
    return failureOf(error);
  }
}
