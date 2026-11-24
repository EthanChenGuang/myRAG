export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  return new Response(null, { status: 501 });
}
