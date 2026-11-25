export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, _context?: unknown): Promise<Response> {
  return new Response(JSON.stringify({ success: false, error: 'not_implemented' }), { status: 501 });
}
