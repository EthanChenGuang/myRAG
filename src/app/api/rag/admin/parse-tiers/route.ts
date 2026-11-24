export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return new Response(null, { status: 501 });
}

export async function PUT(): Promise<Response> {
  return new Response(null, { status: 501 });
}
