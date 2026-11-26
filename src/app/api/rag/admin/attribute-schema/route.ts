export const runtime = 'nodejs';

const pending = () => Response.json({ success: false, error: 'Not implemented' }, { status: 501 });

export async function GET(_request: Request): Promise<Response> {
  return pending();
}
export async function POST(_request: Request): Promise<Response> {
  return pending();
}
export async function PUT(_request: Request): Promise<Response> {
  return pending();
}
export async function DELETE(_request: Request): Promise<Response> {
  return pending();
}
