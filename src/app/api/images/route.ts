import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { removeDocumentObjects, repairOwnerMembership, resolveTenantScope, type RagAdminDb } from '@/lib/rag';
import { checkSingleTenantKbWrite } from '@/lib/kb-write-access';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

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
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  predicate: Predicate;
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

function isImageFilename(filename: unknown): boolean {
  if (typeof filename !== 'string') return false;
  const lower = filename.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function requestedOrganization(request: NextRequest): string | null {
  const params = new URL(request.url).searchParams;
  return params.get('organization_id') ?? params.get('organizationId');
}

async function authorize(request: NextRequest, requestedOrganizationId: unknown, write: boolean): Promise<AuthResult> {
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
    console.error('[Images API] Session lookup failed');
    return { ok: false, response: fail(503, 'Authentication unavailable') };
  }
  if (!sessionUser) return { ok: false, response: fail(401, 'Unauthorized') };

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error('[Images API] Database client is not available');
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
  return { ok: true, value: { admin, predicate } };
}

// GET: List the images in the caller's verified workspace
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const auth = await authorize(request, requestedOrganization(request), false);
    if (!auth.ok) return auth.response;
    const { admin, predicate } = auth.value;

    const { data, error: docError } = await applyPredicate(
      admin.from('documents').select('id, filename, created_at').eq('is_current', true).eq('status', 'ready'),
      predicate
    ).order('created_at', { ascending: false });
    if (docError) {
      console.error('[Images API] Document listing failed', { code: docError.code });
      return fail(500, 'Failed to list images');
    }

    const imageDocuments = (data ?? []).filter((doc: { filename?: string | null }) => isImageFilename(doc.filename));

    const imagesWithUrls = await Promise.all(
      imageDocuments.map(async (doc: { id: string; filename: string; created_at: string }) => {
        const { data: chunks, error: chunkError } = await admin
          .from('document_chunks')
          .select('metadata')
          .eq('document_id', doc.id)
          .eq('is_current', true)
          .eq('status', 'ready')
          .limit(1);

        if (chunkError || !chunks || chunks.length === 0) return null;

        const imageUrl = chunks[0].metadata?.image_url;
        if (!imageUrl) return null;

        return { id: doc.id, name: doc.filename, url: imageUrl, created_at: doc.created_at };
      })
    );

    const validImages = imagesWithUrls.filter((img) => img !== null);
    console.log(`[Images API] Found ${validImages.length} images with URLs`);

    return NextResponse.json({ images: validImages });
  } catch {
    console.error('[Images API] List request failed');
    return fail(500, 'Failed to list images');
  }
}

// DELETE: Remove an image from the caller's verified workspace
export async function DELETE(request: NextRequest): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return fail(400, 'Image ID is required');
    if (!UUID_RE.test(id)) return fail(400, 'Invalid image id');

    const auth = await authorize(request, requestedOrganization(request), true);
    if (!auth.ok) return auth.response;
    const { admin, predicate } = auth.value;

    const { data: doc, error: lookupError } = await applyPredicate(
      admin.from('documents').select('id, filename, tenant_key, lineage_id, version, original_path, processing_state').eq('id', id),
      predicate
    ).maybeSingle();
    if (lookupError) {
      console.error('[Images API] Ownership lookup failed', { code: lookupError.code });
      return fail(500, 'Failed to delete image');
    }
    if (!doc || !isImageFilename(doc.filename)) return fail(404, 'Image not found');

    const { data: chunks } = await admin
      .from('document_chunks')
      .select('metadata')
      .eq('document_id', id)
      .limit(1);
    const imageUrl: unknown = chunks?.[0]?.metadata?.image_url;

    const { error: chunksError } = await admin.from('document_chunks').delete().eq('document_id', id);
    if (chunksError) {
      console.error('[Images API] Chunk delete failed', { code: chunksError.code });
      return fail(500, 'Failed to delete image');
    }

    const { error: documentError } = await applyPredicate(admin.from('documents').delete().eq('id', id), predicate);
    if (documentError) {
      console.error('[Images API] Document delete failed', { code: documentError.code });
      return fail(500, 'Failed to delete image');
    }

    // Best effort and after the rows: a stored original or parse file of the image leaves the private bucket; a failure is logged only.
    if (typeof doc.tenant_key === 'string') await removeDocumentObjects({ tenantKey: doc.tenant_key, rows: [doc] });

    if (typeof imageUrl === 'string') {
      try {
        // URL format: .../storage/v1/object/public/chat-images/filename.jpg
        const parts = imageUrl.split('/chat-images/');
        if (parts.length > 1) {
          const filename = parts[1].split('?')[0];
          const { error: storageError } = await admin.storage.from('chat-images').remove([filename]);
          if (storageError) console.warn('[Images API] Storage delete failed (non-critical)');
        }
      } catch {
        console.warn('[Images API] Could not parse image URL for storage delete');
      }
    }

    return NextResponse.json({ success: true });
  } catch {
    console.error('[Images API] Delete request failed');
    return fail(500, 'Failed to delete image');
  }
}
