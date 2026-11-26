import { NextResponse } from 'next/server';
import type { z } from 'zod/v3';
import type { EvalRunRequest } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function fail(status: number, error: string): NextResponse {
  return jsonNoStore({ success: false, error }, status);
}

export function invalid(error: z.ZodError): NextResponse {
  return jsonNoStore(
    { success: false, error: 'Invalid request data', details: error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    400,
  );
}

export const unavailable = (): NextResponse => fail(503, 'Evaluation run requests are unavailable');

/** The view of one request (UI-SPEC 8.1): ids, codes, times and counts only, from an explicit allow-list. */
export function projectRequest(row: EvalRunRequest) {
  const summary = row.result_summary;
  return {
    id: row.id,
    tenant_key: row.tenant_key,
    reason: row.reason,
    ref_id: row.ref_id,
    requested_at: row.requested_at,
    updated_at: row.updated_at,
    status: row.status,
    skip_reason: row.skip_reason,
    result: summary?.result ?? null,
    checks: summary?.failed_checks ?? [],
    counts: summary?.counts ?? {},
  };
}
