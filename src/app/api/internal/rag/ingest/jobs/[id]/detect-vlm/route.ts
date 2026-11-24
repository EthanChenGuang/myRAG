import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(): Promise<NextResponse> {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
