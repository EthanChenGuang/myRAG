import { jsonNoStore } from '../_responses';

export const runtime = 'nodejs';

export async function GET(_request: Request): Promise<Response> {
  return jsonNoStore({ success: false }, 501);
}
