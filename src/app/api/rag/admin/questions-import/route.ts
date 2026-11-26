import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminWorkspaceDenied, checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { IMPORT_LIMITS, importQuestions, prepareQuestions, readFeedbackLoopConfig } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const BatchBody = z
  .object({
    organizationId: z.string().max(64).nullish(),
    format: z.enum(['csv', 'jsonl']),
    column: z.string().min(1).max(128),
    dry_run: z.boolean(),
    rows: z.array(z.string()).max(IMPORT_LIMITS.maxBatchRows),
  })
  .strict();

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function tooLarge(): NextResponse {
  return json({ success: false, error: 'The batch is larger than 60 KB' }, 413);
}

function badRequest(): NextResponse {
  return json(
    { success: false, error: 'The body must be { organizationId, format: csv | jsonl, column, dry_run, rows: string[] } with at most 2000 rows' },
    400,
  );
}

/** The body as text, or null once it passes the batch limit (the read stops there). */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * D-51, UI-SPEC 6.10.3: the Config UI sends a historical question file in batches of question strings it extracted in the
 * browser. 404 while RAG_DOMAIN_EXPERT_REVIEW is off; 413 above 60 KB (content-length, then the bytes read); the tenant comes
 * from the admitted workspace only. The server masks, fingerprints and deduplicates; the answer and the log carry counts only.
 */
export async function POST(request: Request): Promise<Response> {
  if (!readFeedbackLoopConfig().domainExpertReview) return json({ success: false, error: 'Not found' }, 404);

  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > IMPORT_LIMITS.maxBatchBytes) return tooLarge();
  const text = await readLimited(request, IMPORT_LIMITS.maxBatchBytes).catch(() => '');
  if (text === null) return tooLarge();

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return badRequest();
  }
  const requestedOrg =
    raw !== null && typeof raw === 'object' && typeof (raw as { organizationId?: unknown }).organizationId === 'string'
      ? (raw as { organizationId: string }).organizationId
      : null;
  const admitted = await checkAdminOrOrgAdmin(request, requestedOrg);
  if (!admitted.ok) return adminWorkspaceDenied(admitted);

  const parsed = BatchBody.safeParse(raw);
  if (!parsed.success) return badRequest();

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return json({ success: false, error: 'The questions import is unavailable' }, 503);
    const counts = await importQuestions(admin, {
      tenantKey: admitted.tenantKey,
      prepared: prepareQuestions(parsed.data.rows),
      dryRun: parsed.data.dry_run,
    });
    console.log('[Monitor] questions import batch', {
      dry_run: parsed.data.dry_run,
      read: counts.read,
      added: counts.added,
      duplicates: counts.duplicates,
      rejected_pii: counts.rejected_pii,
      truncated: counts.truncated,
      empty: counts.empty,
    });
    return json({ success: true, dry_run: parsed.data.dry_run, ...counts });
  } catch (error) {
    const operation = (error as { operation?: unknown } | null)?.operation;
    const code = (error as { code?: unknown } | null)?.code;
    console.error('[Monitor] questions import failed', {
      operation: typeof operation === 'string' ? operation : 'unknown',
      code: typeof code === 'string' ? code : 'unknown',
    });
    return json({ success: false, error: 'The questions import is unavailable' }, 503);
  }
}
