import { jsonNoStore } from '../../../_responses';

export const runtime = 'nodejs';

export async function POST(_request: Request, _context: { params: Promise<{ id: string }> }): Promise<Response> {
  return jsonNoStore({ success: false }, 501);
}
