import { fail } from '../../../_responses';

export const runtime = 'nodejs';

export async function DELETE(): Promise<Response> {
  return fail(501, 'not_implemented');
}
