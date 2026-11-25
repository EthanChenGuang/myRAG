import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const notImplemented = () => NextResponse.json({ success: false, error: 'Not implemented' }, { status: 501 });

export async function GET(): Promise<Response> {
  return notImplemented();
}

export async function POST(): Promise<Response> {
  return notImplemented();
}

export async function PATCH(): Promise<Response> {
  return notImplemented();
}
