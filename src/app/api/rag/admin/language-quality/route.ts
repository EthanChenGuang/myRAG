import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { languageQualityForAdmin, MAX_LANGUAGE_QUALITY_DAYS, monitorSettings } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dayValue(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

const QuerySchema = z
  .object({
    since: z.string().regex(DAY_RE).refine((day) => Number.isFinite(dayValue(day)), 'Invalid day'),
    until: z.string().regex(DAY_RE).refine((day) => Number.isFinite(dayValue(day)), 'Invalid day'),
    tenant: z.array(z.string().regex(TENANT_KEY_RE)).max(50).optional(),
    by_tenant: z.enum(['true', 'false']).default('false'),
  })
  .refine((query) => dayValue(query.since) <= dayValue(query.until), { message: 'since must not be after until', path: ['since'] })
  .refine((query) => (dayValue(query.until) - dayValue(query.since)) / DAY_MS + 1 <= MAX_LANGUAGE_QUALITY_DAYS, {
    message: `The window must not exceed ${MAX_LANGUAGE_QUALITY_DAYS} days`,
    path: ['until'],
  });

function answer(status: 400 | 403 | 404 | 503, error: string, details?: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json({ success: false, error, ...(details ? { details } : {}) }, { status, headers: NO_STORE });
}

/**
 * LANG-10: per-language retrievals, "information not available" refusals, knowledge-base outages, helpful and not-helpful votes
 * and low-confidence detections (rag_language_quality_cells, 0743), with the judge score means per language, for a window of at
 * most 90 days over the tenants the verified admin administers. Counts and codes only, never query, answer or chunk text.
 * 404 while RAG_MONITOR is off, before the admin check; the admin check fails closed.
 */
export async function GET(request: Request): Promise<Response> {
  if (!monitorSettings().monitor) return answer(404, 'Not found');
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const params = new URL(request.url).searchParams;
  const tenants = params.getAll('tenant');
  const parsed = QuerySchema.safeParse({
    since: params.get('since') ?? undefined,
    until: params.get('until') ?? undefined,
    tenant: tenants.length > 0 ? tenants : undefined,
    by_tenant: params.get('by_tenant') ?? undefined,
  });
  if (!parsed.success) {
    return answer(
      400,
      'Invalid request data',
      parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return answer(503, 'Language quality is unavailable');
    const report = await languageQualityForAdmin(admin, {
      actorUserId: guard.userId,
      window: { since: parsed.data.since, until: parsed.data.until },
      tenants: parsed.data.tenant ? [...new Set(parsed.data.tenant)] : null,
      byTenant: parsed.data.by_tenant === 'true',
    });
    if (!report.ok) {
      if (report.reason === 'forbidden') return answer(403, 'Forbidden');
      return answer(503, 'Language quality is unavailable');
    }
    console.log('[Monitor] language quality read', { cells: report.cells.length, judged_languages: report.judge ? Object.keys(report.judge).length : 0 });
    return NextResponse.json(
      { window: { since: parsed.data.since, until: parsed.data.until }, cells: report.cells, judge: report.judge },
      { headers: NO_STORE },
    );
  } catch {
    console.error('[Monitor] language quality read failed');
    return answer(503, 'Language quality is unavailable');
  }
}
