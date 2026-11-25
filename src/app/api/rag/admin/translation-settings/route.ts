import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(_request: Request): Promise<Response> {
  return NextResponse.json({ success: false, error: 'Not implemented' }, { status: 501 });
}

export async function PUT(_request: Request): Promise<Response> {
  return NextResponse.json({ success: false, error: 'Not implemented' }, { status: 501 });
}
