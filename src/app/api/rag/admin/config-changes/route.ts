import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import {
  buildChangeRecord,
  insertChangeRecord,
  listChangeRecords,
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
  RAG_AFFECTING_NAMES,
  ragSettingsHash,
} from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const REPORT_REASON_MAX = 200;
const RELEASE_SOURCES = new Set(['release_override', 'local_prerelease']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const TIMESTAMP = z.string().datetime({ offset: true });

function isIsoSince(value: string): boolean {
  if (DATE_RE.test(value)) {
    const day = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(day.getTime()) && day.toISOString().startsWith(value);
  }
  return TIMESTAMP.safeParse(value).success && Number.isFinite(Date.parse(value));
}

const ListQuerySchema = z.object({
  since: z.string().refine(isIsoSince, { message: 'since must be an ISO date or timestamp' }),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const RecordBodySchema = z
  .object({
    source: z.enum(['release_override', 'local_prerelease', 'cli']),
    gate_result: z.enum(['pass', 'fail', 'error', 'skipped', 'not_required']),
    override_reason: z.string().trim().min(OVERRIDE_REASON_MIN).max(OVERRIDE_REASON_MAX).optional(),
    release_sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    github_actor: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/).optional(),
    changed_keys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).max(200).optional(),
    before_hash: SHA256.optional(),
    after_hash: SHA256.optional(),
    uncalibrated_cells: z.array(z.string().max(1100)).max(500).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.source === 'release_override' && body.override_reason === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['override_reason'], message: 'a release override records its reason' });
    }
    if (!RELEASE_SOURCES.has(body.source)) {
      for (const field of ['release_sha', 'github_actor'] as const) {
        if (body[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'only on release records' });
      }
    }
  });

function invalid(error: z.ZodError): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: 'Invalid request data',
      details: error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
    { status: 400, headers: NO_STORE },
  );
}

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'Configuration changes are unavailable' }, { status: 503, headers: NO_STORE });
}

function recordFailed(): NextResponse {
  return NextResponse.json({ success: false, error: 'rag_gate_record_failed' }, { status: 503, headers: NO_STORE });
}

function sinceIso(value: string): string {
  return new Date(DATE_RE.test(value) ? `${value}T00:00:00Z` : value).toISOString();
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * D-17: configuration change records for the weekly report. Deployment-wide (O-3), so no tenant is read from the request.
 * Records hold key names and hashes only; the operator's override reason is capped at 200 characters here.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const url = new URL(request.url);
  const parsed = ListQuerySchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const result = await listChangeRecords(admin, { since: sinceIso(parsed.data.since), limit: parsed.data.limit });
    if (!result.ok) return unavailable();
    const bySource: Record<string, number> = {};
    const byResult: Record<string, number> = {};
    const records = result.records.map((record) => {
      increment(bySource, record.source);
      increment(byResult, record.gate_result);
      const reason = record.override_reason;
      return { ...record, override_reason: typeof reason === 'string' ? reason.slice(0, REPORT_REASON_MAX) : null };
    });
    return NextResponse.json({ records, counts: { by_source: bySource, by_result: byResult } }, { headers: NO_STORE });
  } catch {
    console.error('[Config Gate] change records read failed');
    return unavailable();
  }
}

/**
 * D-16, D-36: records a release override, a local pre-release run or a CLI-recorded host change. The Config UI writes its
 * own records through the save guards, so config_ui is not accepted here. Without hashes in the body, both hashes are the
 * rag_settings_hash of this deployment's environment. A record that cannot be written answers 503 rag_gate_record_failed.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid request data', details: [{ path: '', message: 'body must be JSON' }] },
      { status: 400, headers: NO_STORE },
    );
  }
  const parsed = RecordBodySchema.safeParse(json);
  if (!parsed.success) return invalid(parsed.error);
  const body = parsed.data;

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return recordFailed();
    const current = ragSettingsHash(process.env, RAG_AFFECTING_NAMES);
    const row = buildChangeRecord({
      actor: guard.userId,
      source: body.source,
      gateResult: body.gate_result,
      changedKeys: body.changed_keys ?? [],
      beforeHash: body.before_hash ?? current,
      afterHash: body.after_hash ?? current,
      overrideReason: body.override_reason ?? null,
      uncalibratedCells: body.uncalibrated_cells ?? [],
      releaseSha: body.release_sha ?? null,
      githubActor: body.github_actor ?? null,
    });
    const inserted = await insertChangeRecord(admin, row);
    if (!inserted.ok) {
      console.error('[Config Gate] change record insert failed', { source: body.source });
      return recordFailed();
    }
    console.log('[Config Gate] change recorded', { recordId: inserted.id, source: body.source });
    return NextResponse.json({ record_id: inserted.id }, { status: 201, headers: NO_STORE });
  } catch {
    console.error('[Config Gate] change record failed', { source: body.source });
    return recordFailed();
  }
}
