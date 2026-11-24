import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireSessionUser } from '@/lib/session-auth';
import { DocTypeDefaultsError, INGEST_SOURCES, docTypePickerEnabled, resolvePickerDefault, resolveTenantScope } from '@/lib/rag';

export const runtime = 'nodejs';

const TAG = '[Doc Type Defaults]';
const NO_STORE = { 'Cache-Control': 'no-store' };
const REF_MAX = 200;

const QuerySchema = z.object({
  source: z.enum(INGEST_SOURCES),
  organizationId: z.string().max(64).nullish(),
  nangoConnectionId: z.string().trim().min(1).max(REF_MAX).nullish(),
  nangoFolderId: z.string().trim().min(1).max(REF_MAX).nullish(),
});

function fail(status: number, error: string, details?: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json(details ? { success: false, error, details } : { success: false, error }, { status, headers: NO_STORE });
}

/**
 * The type the upload picker pre-selects for the caller's tenant (D-15, D-17). The session comes first, in both deployment modes; the
 * tenant is the session user's own, or an organization they are a member of. Under the legacy pipeline the picker stays hidden.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await requireSessionUser(TAG);
  if ('response' in session) return session.response;

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    source: url.searchParams.get('source') ?? undefined,
    organizationId: url.searchParams.get('organizationId'),
    nangoConnectionId: url.searchParams.get('nangoConnectionId'),
    nangoFolderId: url.searchParams.get('nangoFolderId'),
  });
  if (!parsed.success) {
    return fail(400, 'Invalid request data', parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  if (!docTypePickerEnabled()) return NextResponse.json({ enabled: false }, { headers: NO_STORE });

  const tenant = await resolveTenantScope({
    requestedOrganizationId: parsed.data.organizationId ?? null,
    getUser: session.getUser,
    signal: request.signal,
  });
  if (!tenant.ok) {
    return fail(tenant.status, tenant.status === 403 ? 'Forbidden' : tenant.status === 401 ? 'Unauthorized' : 'Workspace verification unavailable');
  }
  if (!tenant.scope) return fail(401, 'Unauthorized');

  try {
    const choice = await resolvePickerDefault(
      tenant.scope,
      {
        source: parsed.data.source,
        nangoConnectionId: parsed.data.nangoConnectionId ?? null,
        nangoFolderId: parsed.data.nangoFolderId ?? null,
      },
      { signal: request.signal },
    );
    return NextResponse.json({ enabled: true, docType: choice.docType, origin: choice.origin }, { headers: NO_STORE });
  } catch (error) {
    console.error(`${TAG} defaults lookup failed`, {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof DocTypeDefaultsError ? { rpc: error.rpc, code: error.code } : {}),
    });
    return fail(503, 'Document type defaults are unavailable');
  }
}
