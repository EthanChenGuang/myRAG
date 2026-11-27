import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { checkVectorSyncAccess, runVectorSyncSlice, type RpcClient, type VectorSyncMode } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SLICE_BUDGET_MS = 45_000;
const BodySchema = z.object({ mode: z.enum(['drain', 'reconcile']).optional() }).strict();

function invalid(details: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json({ success: false, error: 'Invalid request data', details }, { status: 400 });
}

function parseMode(input: unknown): { ok: true; mode: VectorSyncMode } | { ok: false; response: NextResponse } {
  const result = BodySchema.safeParse(input);
  if (!result.success) {
    return { ok: false, response: invalid(result.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))) };
  }
  return { ok: true, mode: result.data.mode ?? 'drain' };
}

/** One slice (D-04, A-6). The request's abort signal is never passed on: a caller timeout must not cut a slice short. */
async function run(req: NextRequest, readInput: () => Promise<unknown>): Promise<NextResponse> {
  const access = checkVectorSyncAccess(req.headers, env.RAG_VECTOR_SYNC_SECRET);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  let input: unknown;
  try {
    input = await readInput();
  } catch {
    return invalid([{ path: '', message: 'Body must be JSON' }]);
  }
  const parsed = parseMode(input);
  if (!parsed.ok) return parsed.response;

  const admin = getSupabaseAdmin() as unknown as RpcClient | null;
  if (!admin) return NextResponse.json({ error: 'Vector sync endpoint is not configured' }, { status: 503 });

  try {
    const report = await runVectorSyncSlice(parsed.mode, { rpc: admin, budgetMs: SLICE_BUDGET_MS });
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    console.error('[Vector Sync] slice failed', { mode: parsed.mode, error: error instanceof Error ? error.name : 'unknown' });
    return NextResponse.json({ error: 'vector_sync_failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return run(req, async () => {
    const text = await req.text();
    return text.trim() === '' ? {} : JSON.parse(text);
  });
}

/** Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`; operators set CRON_SECRET to RAG_VECTOR_SYNC_SECRET. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return run(req, async () => Object.fromEntries(req.nextUrl.searchParams.entries()));
}
