import { NextResponse } from 'next/server';
import { verifyEmbedFeedbackToken } from '@/lib/rag';

export const runtime = 'nodejs';

void verifyEmbedFeedbackToken;

export async function POST(): Promise<Response> {
  return NextResponse.json({ success: false }, { status: 501 });
}

export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, { status: 501 });
}
