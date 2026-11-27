import { fail } from '../../_responses';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return fail(501, 'not_implemented');
}

export async function POST(): Promise<Response> {
  return fail(501, 'not_implemented');
}
