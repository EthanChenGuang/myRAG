import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  return NextResponse.json({ success: false }, { status: 501 });
}
