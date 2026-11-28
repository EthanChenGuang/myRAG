import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { checkSidecarSecret } from '@/lib/rag';
import { runSourceReconcile } from '@/lib/nango/reconcile';

export const runtime = 'nodejs';
export const maxDuration = 60;

const RECONCILE_DEADLINE_MS = 50_000;

const bodySchema = z.object({ connection_id: z.string().uuid().optional() }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = checkSidecarSecret(request.headers);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });
  }

  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim() !== '') raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }

  try {
    const result = await runSourceReconcile({
      deadlineMs: RECONCILE_DEADLINE_MS,
      ...(parsed.data.connection_id ? { connectionId: parsed.data.connection_id } : {}),
      signal: request.signal,
    });
    console.log('[Source Reconcile] scheduled run', { ...result });
    return NextResponse.json({ success: true, ...result }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    console.error('[Source Reconcile] run failed', { error: name });
    return NextResponse.json({ success: false, error: 'reconcile_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
