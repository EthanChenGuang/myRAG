import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request): Promise<Response> {
  return NextResponse.json({ success: false, error: 'not_implemented' }, { status: 501 });
}
