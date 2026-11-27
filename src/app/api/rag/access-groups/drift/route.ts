import { fail } from '../_responses';

export const runtime = 'nodejs';

export function POST(): Response {
  return fail(501, 'not_implemented');
}
