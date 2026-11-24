import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { IngestLedgerError, resolveAdminWorkspaceScope } from '@/lib/rag';
import type { TenantScope } from '@/lib/rag';
import type { IngestionJob } from '@/lib/rag-eval/contracts.generated';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const JobIdSchema = z.string().uuid();
export const OrganizationIdSchema = z.string().max(64).nullish();

export type Details = Array<{ path: string; message: string }>;

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function fail(status: number, error: string, details?: Details): NextResponse {
  return jsonNoStore(details ? { success: false, error, details } : { success: false, error }, status);
}

export function invalid(error: z.ZodError): NextResponse {
  return fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
}

/** The same body for another tenant's job and an unknown id, so ids cannot be probed. */
export const notFound = (): NextResponse => fail(404, 'Job not found');

/**
 * Operator view of a job. An explicit allow-list, not a spread of the ledger row: a column added to ingestion_jobs stays hidden
 * until it is added here on purpose. Omitted on purpose: original_ref, settings, stage_state, source_key, file_sha256, locked_by,
 * timings, trace_id and provisional_published_at (surfaced only as provisional).
 */
export function projectJob(job: IngestionJob) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    tenant_key: job.tenant_key,
    source: job.source,
    filename: job.filename,
    mime_type: job.mime_type,
    doc_class: job.doc_class,
    tier: job.tier,
    pages: job.pages,
    provisional: job.provisional_published_at != null,
    retries: job.retries,
    max_retries: job.max_retries,
    error_class: job.error_class,
    needs_review_reason: job.needs_review_reason,
    est_cost_usd: job.est_cost_usd,
    batch_id: job.batch_id,
    document_id: job.document_id,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

export function projectJobDetail(job: IngestionJob) {
  return { ...projectJob(job), attempts: job.attempts ?? [], page_ranges: job.page_ranges ?? [] };
}

export type Workspace = { ok: true; scope: TenantScope } | { ok: false; response: NextResponse };

/** The roles the SQL retry, delete and quarantine functions require (rag_admin_tenant_keys); reads of an organization need the same. */
export const ADMIN_ORGANIZATION_ROLES = ['owner', 'admin'] as const;

/** The workspace of the verified admin: the personal or default one, or an organization honoured only for its owner or admin. */
export async function resolveWorkspace(adminUserId: string, organizationId: string | null | undefined, signal: AbortSignal): Promise<Workspace> {
  const workspace = await resolveAdminWorkspaceScope({
    adminUserId,
    requestedOrganizationId: organizationId ?? null,
    requiredOrganizationRoles: ADMIN_ORGANIZATION_ROLES,
    signal,
  });
  if (workspace.ok) return { ok: true, scope: workspace.scope };
  return { ok: false, response: fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable') };
}

/** A refusal by the SQL function (job not visible to this admin, wrong status, current document) carries the code ingest_refused. */
export function isRefusal(error: unknown): boolean {
  return error instanceof IngestLedgerError && error.code === 'ingest_refused';
}

/** The SQL did not find the job for this actor: it reads like an unknown id, not like a status conflict. */
export function isJobNotFoundRefusal(error: unknown): boolean {
  return isRefusal(error) && (error as IngestLedgerError).reason === 'job_not_found';
}

export function ledgerFailure(action: string, error: unknown): NextResponse {
  console.error('[RAG Admin] ingest job call failed', {
    action,
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof IngestLedgerError ? { rpc: error.rpc, code: error.code } : {}),
  });
  return fail(503, 'Ingestion job administration is unavailable');
}

const CursorSchema = z.object({ c: z.string().datetime({ offset: true }), i: z.string().uuid() }).strict();

export type JobCursor = { createdAt: string; id: string };

export function encodeCursor(job: Pick<IngestionJob, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify({ c: job.created_at, i: job.id }), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): JobCursor | null {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.success ? { createdAt: parsed.data.c, id: parsed.data.i } : null;
  } catch {
    return null;
  }
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Microseconds since the epoch, read from the timestamp string the database returned (not through a JS Date, which stops at
 * milliseconds). Digits past the sixth are dropped, as the database stores no more.
 */
export function timestampMicros(value: string): bigint | null {
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const zone = match[3].toUpperCase() === 'Z' ? 'Z' : match[3].length === 5 ? `${match[3].slice(0, 3)}:${match[3].slice(3)}` : match[3];
  const seconds = Date.parse(`${match[1]}${zone}`);
  if (Number.isNaN(seconds)) return null;
  return BigInt(seconds) * BigInt(1000) + BigInt((match[2] ?? '').slice(0, 6).padEnd(6, '0'));
}

/** True when the job sorts after the cursor in the list order (created_at, id, both descending), at the database's microsecond precision. */
export function isAfterCursor(job: Pick<IngestionJob, 'created_at' | 'id'>, cursor: JobCursor): boolean {
  const at = timestampMicros(job.created_at);
  const from = timestampMicros(cursor.createdAt);
  if (at === null || from === null) return false;
  if (at !== from) return at < from;
  return job.id < cursor.id;
}
