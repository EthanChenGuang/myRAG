import { fail } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request): Promise<Response> {
  return fail(501, 'Not implemented');
}
