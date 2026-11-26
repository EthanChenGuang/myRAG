export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request): Promise<Response> {
  return new Response(null, { status: 501 });
}
