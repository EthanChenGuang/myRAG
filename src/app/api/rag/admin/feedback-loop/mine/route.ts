import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(_request: Request): Promise<Response> {
  return NextResponse.json({ success: false, error: 'Not implemented' }, { status: 501 });
}
