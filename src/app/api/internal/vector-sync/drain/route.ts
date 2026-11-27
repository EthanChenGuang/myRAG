import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({}, { status: 200 });
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({}, { status: 200 });
}
