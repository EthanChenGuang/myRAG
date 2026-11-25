import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(_request: NextRequest, _context: { params: Promise<{ traceId: string }> }): Promise<NextResponse> {
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}
