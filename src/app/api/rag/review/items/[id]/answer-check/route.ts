import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}

export async function POST(): Promise<NextResponse> {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
