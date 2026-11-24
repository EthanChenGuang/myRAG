export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return Response.json({ success: false, error: 'Not implemented' }, { status: 501 });
}

export async function PUT(): Promise<Response> {
  return Response.json({ success: false, error: 'Not implemented' }, { status: 501 });
}
