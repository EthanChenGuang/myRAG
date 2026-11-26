import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const notImplemented = async (_request: Request): Promise<Response> => NextResponse.json({ success: false }, { status: 501 });
export const GET = notImplemented;
export const POST = notImplemented;
