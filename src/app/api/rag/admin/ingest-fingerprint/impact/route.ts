export const runtime = 'nodejs';

export async function POST(_request: Request): Promise<Response> {
  return new Response(JSON.stringify({ success: false, error: 'not_implemented' }), { status: 501 });
}
