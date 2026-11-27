import { runAccessDrift } from '@/lib/rag';
import { requireAccessOperator } from '../_auth';
import { failureOf, ok, serviceDeps } from '../_responses';

export const runtime = 'nodejs';

/**
 * D-03, A-08: the label check. Counts, per store present in this database, the rows whose access labels differ from their document's.
 * There is no repair action: differing rows are already left out of answers.
 */
export async function POST(request: Request): Promise<Response> {
  const operator = await requireAccessOperator(request);
  if (!operator.ok) return operator.response;
  try {
    const stores = await runAccessDrift(serviceDeps(request));
    return ok({ stores, checkedAt: new Date().toISOString() });
  } catch (error) {
    return failureOf(error);
  }
}
