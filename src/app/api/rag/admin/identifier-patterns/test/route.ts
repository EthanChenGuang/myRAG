import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { IDENTIFIER_PATTERN_LIMITS, IdentifierPatternError, resolveAdminWorkspaceScope, testIdentifierPatterns } from '@/lib/rag';

export const runtime = 'nodejs';

const TAG = '[RAG Admin]';
const NO_STORE = { 'Cache-Control': 'no-store' };

const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    sample: z.string().max(IDENTIFIER_PATTERN_LIMITS.maxSampleLength),
    draft: z
      .object({
        id: z.string().uuid().optional(),
        pattern: z.string().min(1).max(IDENTIFIER_PATTERN_LIMITS.maxPatternLength),
        flags: z.enum(['u', 'iu']),
      })
      .strict()
      .nullish(),
  })
  .strict();

type Details = Array<{ path: string; message: string }>;

function fail(status: number, error: string, details?: Details): NextResponse {
  return NextResponse.json(details ? { success: false, error, details } : { success: false, error }, { status, headers: NO_STORE });
}

const invalid = (error: z.ZodError): NextResponse =>
  fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));

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
  console.error(`${TAG} identifier pattern test failed`, {
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof IdentifierPatternError ? { rpc: error.rpc, code: error.code, sqlState: error.sqlState } : {}),
  });
  return fail(503, 'Identifier pattern test is unavailable');
}

/**
 * Runs a sample against the built-in rule, the workspace's enabled patterns and an optional draft (checked like a saved pattern).
 * The sample is never stored or logged; offsets are UTF-16 offsets into the sample as sent.
 */
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
    const draft = parsed.data.draft ? { id: parsed.data.draft.id?.toLowerCase(), pattern: parsed.data.draft.pattern, flags: parsed.data.draft.flags } : null;
    const result = await testIdentifierPatterns(workspace.scope, parsed.data.sample, draft, { signal: request.signal });
    console.log(`${TAG} identifier patterns tested`, {
      action: 'test_identifier_patterns',
      patterns: result.tested.patternIds.length,
      draft: draft !== null,
      matches: result.total,
    });
    return NextResponse.json(
      {
        success: true,
        matches: result.matches.map((match) => ({ raw: match.raw, normalized: match.normalized, source: match.source, start: match.start, end: match.end })),
        tested: { pattern_ids: result.tested.patternIds },
        truncated: result.truncated,
        total: result.total,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return mapPatternError(error);
  }
}
