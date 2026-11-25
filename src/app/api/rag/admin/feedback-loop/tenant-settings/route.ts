import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return NextResponse.json({ success: false }, { status: 501 });
}

export async function PUT(): Promise<Response> {
  return NextResponse.json({ success: false }, { status: 501 });
}
