import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const notImplemented = () => NextResponse.json({ success: false, error: 'Not implemented' }, { status: 501 });

export async function PUT(): Promise<Response> {
  return notImplemented();
}
