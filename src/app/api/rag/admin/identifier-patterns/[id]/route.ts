import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import {
  deleteIdentifierPattern,
  IDENTIFIER_PATTERN_LIMITS,
  IdentifierPatternError,
  resolveAdminWorkspaceScope,
  updateIdentifierPattern,
  type IdentifierPatternRow,
} from '@/lib/rag';

export const runtime = 'nodejs';

const TAG = '[RAG Admin]';
const NO_STORE = { 'Cache-Control': 'no-store' };

const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });
const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    name: z.string().trim().min(1).max(IDENTIFIER_PATTERN_LIMITS.maxNameLength).optional(),
    pattern: z.string().min(1).max(IDENTIFIER_PATTERN_LIMITS.maxPatternLength).optional(),
    flags: z.enum(['u', 'iu']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.pattern !== undefined || body.flags !== undefined || body.enabled !== undefined, {
    message: 'At least one of name, pattern, flags or enabled is required',
  });

type Details = Array<{ path: string; message: string }>;
type Context = { params: Promise<{ id: string }> };

function fail(status: number, error: string, details?: Details): NextResponse {
  return NextResponse.json(details ? { success: false, error, details } : { success: false, error }, { status, headers: NO_STORE });
}

const invalid = (error: z.ZodError): NextResponse =>
  fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));

function itemOf(row: IdentifierPatternRow) {
  return { id: row.id, name: row.name, pattern: row.pattern, flags: row.flags, enabled: row.enabled, updated_at: row.updatedAt };
}

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

async function patternIdOf(context: Context): Promise<{ ok: true; id: string } | { ok: false; response: NextResponse }> {
  const parsed = ParamsSchema.safeParse(await context.params);
  return parsed.success ? { ok: true, id: parsed.data.id.toLowerCase() } : { ok: false, response: invalid(parsed.error) };
}

/** Changes the given fields of one pattern of the admin's workspace; a new pattern or flags are validated and probed first. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const target = await patternIdOf(context);
  if (!target.ok) return target.response;

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
    const { name, pattern, flags, enabled } = parsed.data;
    const row = await updateIdentifierPattern(workspace.scope, target.id, { name, pattern, flags, enabled }, { signal: request.signal });
    console.log(`${TAG} identifier pattern updated`, { action: 'update_identifier_pattern', patternId: row.id });
    return NextResponse.json({ success: true, item: itemOf(row) }, { headers: NO_STORE });
  } catch (error) {
    return mapPatternError(error);
  }
}

/** Deletes one pattern of the admin's workspace; the workspace comes from the query string. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const target = await patternIdOf(context);
  if (!target.ok) return target.response;

  const parsed = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveAdminWorkspaceScope({
    adminUserId: admin.userId,
    requestedOrganizationId: parsed.data.organizationId ?? null,
    signal: request.signal,
  });
  if (!workspace.ok) return fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable');

  try {
    await deleteIdentifierPattern(workspace.scope, target.id, { signal: request.signal });
    console.log(`${TAG} identifier pattern deleted`, { action: 'delete_identifier_pattern', patternId: target.id });
    return NextResponse.json({ success: true, id: target.id }, { headers: NO_STORE });
  } catch (error) {
    return mapPatternError(error);
  }
}
