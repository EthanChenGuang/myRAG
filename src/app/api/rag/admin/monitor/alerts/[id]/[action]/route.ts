import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(_request: Request, _context: { params: Promise<{ id: string; action: string }> }): Promise<Response> {
  return NextResponse.json({ success: false, error: 'Not implemented' }, { status: 501 });
}
