import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function notImplemented(): NextResponse {
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}

export async function GET(_request: Request): Promise<NextResponse> {
  return notImplemented();
}

export async function POST(_request: Request): Promise<NextResponse> {
  return notImplemented();
}

export async function DELETE(_request: Request): Promise<NextResponse> {
  return notImplemented();
}
