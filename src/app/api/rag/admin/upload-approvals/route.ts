export const runtime = 'nodejs';

export async function GET(_request: Request): Promise<Response> {
  return new Response(null, { status: 501 });
}
