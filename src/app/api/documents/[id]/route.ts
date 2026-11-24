import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { repairOwnerMembership, resolveTenantScope, scopeKey, type RagAdminDb } from '@/lib/rag';
import { checkSingleTenantKbWrite } from '@/lib/kb-write-access';
import { removeDocumentObjects, type DocumentObjectRow } from '@/lib/rag/ingest/remove-document-objects';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL_LENGTH = 2048;

type Predicate =
  | { kind: 'none' }
  | { kind: 'org'; organizationId: string }
  | { kind: 'personal'; userId: string }
  | { kind: 'owner'; userId: string };

interface Scopable<Q> {
  eq(column: string, value: string): Q;
  is(column: string, value: null): Q;
}

interface Authorized {
  admin: ReturnType<typeof getSupabaseAdmin>;
  predicate: Predicate;
  tenantKey: string;
}

type AuthResult = { ok: true; value: Authorized } | { ok: false; response: Response };

function fail(status: number, error: string): Response {
  return NextResponse.json({ error }, { status });
}

function applyPredicate<Q extends Scopable<Q>>(query: Q, predicate: Predicate): Q {
  if (predicate.kind === 'org') return query.eq('organization_id', predicate.organizationId);
  if (predicate.kind === 'personal') return query.is('organization_id', null).eq('user_id', predicate.userId);
  if (predicate.kind === 'owner') return query.eq('user_id', predicate.userId);
  return query;
}

async function authorize(
  request: NextRequest,
  requestedOrganizationId: unknown,
  write: boolean
): Promise<AuthResult> {
  let sessionUserPromise: Promise<{ id: string } | null> | null = null;
  const getSessionUser = () => {
    sessionUserPromise ??= (async () => {
      const { createClient } = await import('@/lib/supabase/server');
      const sbSSR = await createClient();
      const { data: userRes } = await sbSSR.auth.getUser();
      return userRes?.user?.id ? { id: userRes.user.id } : null;
    })();
    return sessionUserPromise;
  };

  let sessionUser: { id: string } | null;
  try {
    sessionUser = await getSessionUser();
  } catch {
    console.error('[Documents] Session lookup failed');
    return { ok: false, response: fail(503, 'Authentication unavailable') };
  }
  if (!sessionUser) return { ok: false, response: fail(401, 'Unauthorized') };

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error('[Documents] Database client is not available');
    return { ok: false, response: fail(500, 'Internal server error') };
  }

  await repairOwnerMembership({ requestedOrganizationId, getUser: getSessionUser });
  const tenant = await resolveTenantScope({
    requestedOrganizationId: typeof requestedOrganizationId === 'string' ? requestedOrganizationId : null,
    getUser: getSessionUser,
    signal: request.signal,
  });
  if (!tenant.ok) {
    const error =
      tenant.status === 403 ? 'Forbidden' : tenant.status === 401 ? 'Unauthorized' : 'Workspace verification unavailable';
    return { ok: false, response: fail(tenant.status, error) };
  }
  const scope = tenant.scope;
  if (!scope) return { ok: false, response: fail(401, 'Unauthorized') };

  let predicate: Predicate = { kind: 'none' };
  if (write && scope.kind === 'single') {
    const access = await checkSingleTenantKbWrite({
      admin: admin as unknown as RagAdminDb,
      userId: sessionUser.id,
      signal: request.signal,
    });
    if (!access.ok) return { ok: false, response: fail(access.status, access.error) };
    if (!access.isAdmin) predicate = { kind: 'owner', userId: sessionUser.id };
  } else if (scope.kind === 'org' && scope.organizationId) {
    predicate = { kind: 'org', organizationId: scope.organizationId };
  } else if (scope.kind === 'personal' && scope.userId) {
    predicate = { kind: 'personal', userId: scope.userId };
  }
  return { ok: true, value: { admin, predicate, tenantKey: scopeKey(scope) } };
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return fail(400, 'Invalid document id');

    const auth = await authorize(request, new URL(request.url).searchParams.get('organizationId'), true);
    if (!auth.ok) return auth.response;
    const { admin, predicate, tenantKey } = auth.value;

    // The row must be in the caller's tenant; another tenant's id reads exactly like an unknown id.
    const { data: owned, error: lookupError } = await applyPredicate(
      admin.from('documents').select('id, lineage_id').eq('id', id).eq('tenant_key', tenantKey),
      predicate
    ).maybeSingle();
    if (lookupError) {
      console.error('[Documents] Ownership lookup failed', { code: lookupError.code });
      return fail(500, 'Failed to delete document');
    }
    if (!owned) return fail(404, 'Document not found');

    // Deleting a document deletes every version of its lineage, in this tenant only.
    const lineageId: string = owned.lineage_id ?? owned.id;
    const { data: versions, error: versionsError } = await applyPredicate(
      admin.from('documents').select('id, version, lineage_id, original_path, processing_state').eq('lineage_id', lineageId).eq('tenant_key', tenantKey),
      predicate
    );
    if (versionsError) {
      console.error('[Documents] Version lookup failed', { code: versionsError.code });
      return fail(500, 'Failed to delete document');
    }
    const versionRows = (versions ?? []) as DocumentObjectRow[];
    const versionIds = Array.from(new Set([id, ...versionRows.map((version) => version.id)]));

    const { error: chunksError } = await admin.from('document_chunks').delete().in('document_id', versionIds);
    if (chunksError) {
      console.error('[Documents] Chunk delete failed', { code: chunksError.code });
      return fail(500, 'Failed to delete document');
    }

    const { error: documentError } = await applyPredicate(
      admin.from('documents').delete().eq('lineage_id', lineageId).eq('tenant_key', tenantKey),
      predicate
    );
    if (documentError) {
      console.error('[Documents] Document delete failed', { code: documentError.code });
      return fail(500, 'Failed to delete document');
    }

    // Best effort and after the rows: the originals and parse files of every version leave the private bucket, and a storage failure
    // is reported in the answer without undoing the delete.
    const objects = await removeDocumentObjects({ tenantKey, rows: versionRows });
    if (objects.failed > 0) return NextResponse.json({ success: true, artifacts_failed: objects.failed });
    return NextResponse.json({ success: true });
  } catch {
    console.error('[Documents] Delete request failed');
    return fail(500, 'Failed to delete document');
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return fail(400, 'Invalid document id');

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail(400, 'Invalid request body');
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return fail(400, 'Invalid JSON body');
    }

    const queryOrganizationId = new URL(request.url).searchParams.get('organizationId');
    const auth = await authorize(request, queryOrganizationId ?? body.organizationId, true);
    if (!auth.ok) return auth.response;
    const { admin, predicate, tenantKey } = auth.value;

    const externalUrl = body.external_url;
    if (typeof externalUrl !== 'string' || externalUrl.length > MAX_URL_LENGTH) {
      return fail(400, 'Invalid external_url');
    }
    if (externalUrl.trim() !== '') {
      try {
        const protocol = new URL(externalUrl.trim()).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') return fail(400, 'Invalid external_url');
      } catch {
        return fail(400, 'Invalid external_url');
      }
    }

    const { data: named, error: lookupError } = await applyPredicate(
      admin.from('documents').select('id, lineage_id, is_current, metadata').eq('id', id).eq('tenant_key', tenantKey),
      predicate
    ).maybeSingle();
    if (lookupError) {
      console.error('[Documents] Ownership lookup failed', { code: lookupError.code });
      return fail(500, 'Failed to update document');
    }
    if (!named) return fail(404, 'Document not found');

    // The link belongs to the document, so it goes on the lineage's current version (later versions copy it forward).
    // A lineage with no current version yet takes it on the row that was named.
    const lineageId: string = named.lineage_id ?? named.id;
    const { data: currentVersion, error: currentError } = await applyPredicate(
      admin
        .from('documents')
        .select('id, metadata')
        .eq('lineage_id', lineageId)
        .eq('is_current', true)
        .eq('tenant_key', tenantKey),
      predicate
    ).maybeSingle();
    if (currentError) {
      console.error('[Documents] Version lookup failed', { code: currentError.code });
      return fail(500, 'Failed to update document');
    }
    let target: { id: string; metadata: Record<string, unknown> | null; isCurrent: boolean } | null = currentVersion
      ? { id: currentVersion.id, metadata: currentVersion.metadata, isCurrent: true }
      : null;
    target ??= { id: named.id, metadata: named.metadata, isCurrent: named.is_current === true };

    const updatedMetadata = { ...(target.metadata || {}), external_url: externalUrl };
    const { error: updateError } = await applyPredicate(
      admin
        .from('documents')
        .update({ metadata: updatedMetadata })
        .eq('id', target.id)
        .eq('lineage_id', lineageId)
        .eq('is_current', target.isCurrent)
        .eq('tenant_key', tenantKey),
      predicate
    );
    if (updateError) {
      console.error('[Documents] Document update failed', { code: updateError.code });
      return fail(500, 'Failed to update document');
    }

    return NextResponse.json({ success: true });
  } catch {
    console.error('[Documents] Update request failed');
    return fail(500, 'Failed to update document');
  }
}
