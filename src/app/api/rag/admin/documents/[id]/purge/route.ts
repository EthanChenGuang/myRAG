export const runtime = 'nodejs';

export async function POST(_request: Request, _context: { params: Promise<{ id: string }> }): Promise<Response> {
  return new Response(null, { status: 501 });
}
