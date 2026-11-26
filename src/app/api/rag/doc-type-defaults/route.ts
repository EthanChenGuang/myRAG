import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireSessionUser } from '@/lib/session-auth';
import {
  DocTypeDefaultsError,
  INGEST_SOURCES,
  activeUploadVocabulary,
  docTypePickerEnabled,
  replacesConfirmedAtOnce,
  replacesEnabled,
  resolvePickerDefault,
  resolveTenantScope,
  uploadScopesEnabled,
  type TenantScope,
  type UploadVocabularyEntry,
} from '@/lib/rag';

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

const TAGS_OFF = { enabled: false, vocabulary: [] as UploadVocabularyEntry[] };

/** D-40, UI-SPEC 8.1: whether the upload tag picker shows, and the active vocabulary of the caller's own workspace (never another's). */
async function uploadTags(scope: TenantScope, signal: AbortSignal): Promise<{ enabled: boolean; vocabulary: UploadVocabularyEntry[] } | null> {
  if (!uploadScopesEnabled()) return TAGS_OFF;
  const vocabulary = await activeUploadVocabulary(scope, { signal });
  return vocabulary.ok ? { enabled: true, vocabulary: vocabulary.items } : null;
}

const REPLACES_OFF = { enabled: false, confirmedAtOnce: false };

/**
 * D-41, UI-SPEC decision 9: whether the "Replaces…" control shows (unified pipeline and RAG_SUPERSESSION_DETECT=on), and whether the
 * caller's choice is confirmed at once (an admin of this workspace) or becomes a pending candidate for an admin.
 */
async function uploadReplaces(scope: TenantScope, userId: string, signal: AbortSignal): Promise<{ enabled: boolean; confirmedAtOnce: boolean }> {
  if (!replacesEnabled()) return REPLACES_OFF;
  return { enabled: true, confirmedAtOnce: await replacesConfirmedAtOnce(scope, userId, signal) };
}

/**
 * The type the upload picker pre-selects for the caller's tenant (D-15, D-17). The session comes first, in both deployment modes; the
 * tenant is the session user's own, or an organization they are a member of. Under the legacy pipeline the picker stays hidden. The tags
 * block says whether the tag picker shows (unified pipeline and RAG_SCOPE_TAGS) and lists that workspace's active values; the replaces
 * block says whether "Replaces…" shows and whether it is confirmed at once.
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

  if (!docTypePickerEnabled()) return NextResponse.json({ enabled: false, tags: TAGS_OFF, replaces: REPLACES_OFF }, { headers: NO_STORE });

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
    const tags = await uploadTags(tenant.scope, request.signal);
    if (tags === null) return fail(503, 'Document type defaults are unavailable');
    const replaces = await uploadReplaces(tenant.scope, session.user.id, request.signal);
    return NextResponse.json({ enabled: true, docType: choice.docType, origin: choice.origin, tags, replaces }, { headers: NO_STORE });
  } catch (error) {
    console.error(`${TAG} defaults lookup failed`, {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof DocTypeDefaultsError ? { rpc: error.rpc, code: error.code } : {}),
    });
    return fail(503, 'Document type defaults are unavailable');
  }
}
