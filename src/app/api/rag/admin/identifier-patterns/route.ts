import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import {
  createIdentifierPattern,
  IDENTIFIER_PATTERN_LIMITS,
  IdentifierPatternError,
  listIdentifierPatterns,
  resolveAdminWorkspaceScope,
  type IdentifierPatternRow,
} from '@/lib/rag';

export const runtime = 'nodejs';

const TAG = '[RAG Admin]';
const NO_STORE = { 'Cache-Control': 'no-store' };

const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });
const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    name: z.string().trim().min(1).max(IDENTIFIER_PATTERN_LIMITS.maxNameLength),
    pattern: z.string().min(1).max(IDENTIFIER_PATTERN_LIMITS.maxPatternLength),
    flags: z.enum(['u', 'iu']),
    enabled: z.boolean().optional(),
  })
  .strict();

type Details = Array<{ path: string; message: string }>;

function fail(status: number, error: string, details?: Details): NextResponse {
  return NextResponse.json(details ? { success: false, error, details } : { success: false, error }, { status, headers: NO_STORE });
}

const invalid = (error: z.ZodError): NextResponse =>
  fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));

function itemOf(row: IdentifierPatternRow) {
  return { id: row.id, name: row.name, pattern: row.pattern, flags: row.flags, enabled: row.enabled, updated_at: row.updatedAt };
}

const LIMITS = {
  max_patterns: IDENTIFIER_PATTERN_LIMITS.maxPatterns,
  max_pattern_length: IDENTIFIER_PATTERN_LIMITS.maxPatternLength,
  max_name_length: IDENTIFIER_PATTERN_LIMITS.maxNameLength,
  max_sample_length: IDENTIFIER_PATTERN_LIMITS.maxSampleLength,
};

/** The one mapping of the pattern service's codes to answers (UI-SPEC 8.2). Logs carry the rpc and codes only. */
function mapPatternError(error: unknown): NextResponse {
  if (error instanceof IdentifierPatternError) {
    switch (error.code) {
      case 'invalid_identifier_pattern':
        return fail(400, 'invalid_identifier_pattern', error.findings.map((finding) => ({ path: error.field ?? 'pattern', message: finding.code })));
      case 'invalid_argument':
        return fail(400, 'Invalid request data', [{ path: error.field ?? '', message: 'invalid' }]);
      case 'sample_too_long':
        return fail(400, 'Invalid request data', [{ path: 'sample', message: 'too_long' }]);
      case 'limit_reached':
      case 'name_exists':
        return fail(409, error.code);
      case 'pattern_not_found':
        return fail(404, error.code);
      default:
        break;
    }
  }
  console.error(`${TAG} identifier pattern call failed`, {
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof IdentifierPatternError ? { rpc: error.rpc, code: error.code, sqlState: error.sqlState } : {}),
  });
  return fail(503, 'Identifier patterns are unavailable');
}

/** The identifier patterns of one workspace of the verified admin, in creation order, with the limits the panel enforces. */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveAdminWorkspaceScope({
    adminUserId: admin.userId,
    requestedOrganizationId: parsed.data.organizationId ?? null,
    signal: request.signal,
  });
  if (!workspace.ok) return fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable');

  try {
    const rows = await listIdentifierPatterns(workspace.scope, { signal: request.signal });
    return NextResponse.json({ success: true, items: rows.map(itemOf), limits: LIMITS }, { headers: NO_STORE });
  } catch (error) {
    return mapPatternError(error);
  }
}

/** Validates, probes and stores one pattern. created_by is the admin the guard verified; the body cannot name an actor or a tenant. */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Invalid request data', [{ path: '', message: 'Body is not valid JSON' }]);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveAdminWorkspaceScope({
    adminUserId: admin.userId,
    requestedOrganizationId: parsed.data.organizationId ?? null,
    signal: request.signal,
  });
  if (!workspace.ok) return fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable');

  try {
    const row = await createIdentifierPattern(
      workspace.scope,
      { name: parsed.data.name, pattern: parsed.data.pattern, flags: parsed.data.flags, enabled: parsed.data.enabled ?? true, createdBy: admin.userId },
      { signal: request.signal },
    );
    console.log(`${TAG} identifier pattern created`, { action: 'create_identifier_pattern', patternId: row.id });
    return NextResponse.json({ success: true, item: itemOf(row) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return mapPatternError(error);
  }
}
