import { fail } from '../_responses';

export const runtime = 'nodejs';

export function GET(): Response {
  return fail(501, 'not_implemented');
}
