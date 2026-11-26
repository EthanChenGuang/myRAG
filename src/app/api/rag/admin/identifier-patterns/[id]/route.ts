export const runtime = 'nodejs';

export async function PATCH(_request: Request, _context: { params: Promise<{ id: string }> }): Promise<Response> {
  return new Response(null, { status: 501 });
}

export async function DELETE(_request: Request, _context: { params: Promise<{ id: string }> }): Promise<Response> {
  return new Response(null, { status: 501 });
}
