import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listJobsPage } from '@/lib/rag';
import type { TenantScope } from '@/lib/rag';
import type { IngestionJob } from '@/lib/rag-eval/contracts.generated';
import { OrganizationIdSchema, decodeCursor, encodeCursor, fail, invalid, isAfterCursor, jsonNoStore, ledgerFailure, projectJob, resolveWorkspace } from './_lib';
import type { JobCursor } from './_lib';

export const runtime = 'nodejs';

const STATUSES = ['queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding', 'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review'] as const;
const PAGE = 100;
const MAX_SCAN = 10_000;

const QuerySchema = z.object({
  status: z.array(z.enum(STATUSES)).max(STATUSES.length).default([]),
  kind: z.enum(['ingest', 'dry_run', 'delete']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(256).optional(),
  organizationId: OrganizationIdSchema,
});

async function pageAfter(
  scope: TenantScope,
  filters: { statuses: string[] | null; kind: string | null },
  cursor: JobCursor | null,
  want: number,
  signal: AbortSignal,
): Promise<IngestionJob[] | 'cursor_too_far'> {
  if (!cursor) {
    const first = await listJobsPage({ scope, ...filters, limit: want, offset: 0 }, { signal });
    if (first.skipped === 0) return first.jobs;
  }
  const found: IngestionJob[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < MAX_SCAN; offset += PAGE) {
    const page = await listJobsPage({ scope, ...filters, limit: PAGE, offset }, { signal });
    for (const row of page.jobs) {
      if (seen.has(row.id) || (cursor && !isAfterCursor(row, cursor))) continue;
      seen.add(row.id);
      found.push(row);
      if (found.length >= want) return found;
    }
    if (page.fetched < PAGE) return found;
  }
  return 'cursor_too_far';
}

/**
 * Ingestion jobs of one workspace of the verified admin, newest first: the personal (or, single-tenant, the default) workspace, or an
 * organization named by `organizationId` once the membership check passes. The list is deployment-operator-only (admin_users) and never
 * crosses tenants: another tenant's job is not listed, and reads like an unknown id on the detail, retry and delete routes. Each row is
 * the operator allow-list of projectJob; original_ref, settings, stage_state, source_key, file_sha256, locked_by, timings and trace_id
 * are never returned. Filters: repeated `status`, `kind` (ingest, dry_run, delete; every row carries its kind), `limit` and the opaque
 * keyset `cursor` of the previous answer.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    status: params.getAll('status'),
    kind: params.get('kind') ?? undefined,
    limit: params.get('limit') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
    organizationId: params.get('organizationId'),
  });
  if (!parsed.success) return invalid(parsed.error);
  const query = parsed.data;

  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) return fail(400, 'Invalid request data', [{ path: 'cursor', message: 'Cursor is not valid' }]);

  const workspace = await resolveWorkspace(admin.userId, query.organizationId, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const rows = await pageAfter(
      workspace.scope,
      { statuses: query.status.length > 0 ? query.status : null, kind: query.kind ?? null },
      cursor,
      query.limit + 1,
      request.signal,
    );
    if (rows === 'cursor_too_far') return fail(400, 'Invalid request data', [{ path: 'cursor', message: 'Cursor is too far back' }]);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    console.log('[RAG Admin] ingest jobs listed', { count: items.length });
    return jsonNoStore({
      success: true,
      items: items.map(projectJob),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    });
  } catch (error) {
    return ledgerFailure('list', error);
  }
}
