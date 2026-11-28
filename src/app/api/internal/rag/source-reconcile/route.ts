import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(_request: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ success: false }, { status: 500 });
}
