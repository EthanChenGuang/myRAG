import { NextRequest, NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { createClient } from '@/lib/supabase/server';
import { processImageDocument } from '@/lib/document-processor';
import { logger } from '@/lib/logger';
import { isSingleTenant } from '@/lib/deployment-mode';
import { checkSingleTenantKbWrite } from '@/lib/kb-write-access';
import type { EnqueueResult, RagAdminDb, TenantScope } from '@/lib/rag';

/**
 * Dedicated file upload endpoint for MCP tool compatibility
 * Uploads files to Supabase Storage and returns downloadable URLs
 */

// Configuration
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const BUCKET_NAME = 'chat-images';
// The route's limit is 60 s (vercel.json); background ingestion runs inside it, so it gets what the request has left of 55 s.
const INGEST_BUDGET_MS = 55_000;
const MIN_INGEST_MS = 5_000;
const INGEST_CONCURRENCY = 4;

/**
 * Generate a unique filename with timestamp and random suffix
 */
function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const rawExtension = originalName.includes('.') ? originalName.split('.').pop() || '' : '';
  const nameWithoutExt = rawExtension ? originalName.slice(0, -(rawExtension.length + 1)) : originalName;
  const extension = rawExtension.replace(/[^a-zA-Z0-9]/g, '');
  const sanitizedName = nameWithoutExt.replace(/[^a-zA-Z0-9-_]/g, '_');

  return extension
    ? `${sanitizedName}_${timestamp}_${randomSuffix}.${extension}`
    : `${sanitizedName}_${timestamp}_${randomSuffix}`;
}

/**
 * Get the public download URL for a file in Supabase Storage
 */
function getDownloadUrl(filePath: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return `${baseUrl}/storage/v1/object/public/${BUCKET_NAME}/${filePath}?download`;
}

type UploadPipeline = 'legacy' | 'unified' | 'blocked';

/**
 * Which write path an upload takes, read per request after the session check. A switch that cannot be read means the legacy path.
 * The pipeline modules are loaded only here and in the unified branch, so the legacy path pulls in nothing new.
 */
async function uploadPipeline(): Promise<UploadPipeline> {
  try {
    const { currentIngestConfig } = await import('@/lib/rag');
    const config = currentIngestConfig();
    if (config.pipeline === 'unified' && config.pipelineBlocked) return 'blocked';
    return config.pipeline === 'unified' ? 'unified' : 'legacy';
  } catch {
    logger.warn('Upload API', 'Ingest switch unavailable, using the legacy pipeline');
    return 'legacy';
  }
}

/** D-56: the legacy image writer cannot hold a document; with upload approval on a knowledge-base upload refuses before storage. */
async function legacyUploadRefused(): Promise<boolean> {
  try {
    const { legacyWriteRefused } = await import('@/lib/rag');
    return legacyWriteRefused();
  } catch {
    const raw = (process.env.RAG_UPLOAD_APPROVAL ?? '').trim().toLowerCase();
    return raw === 'members' || raw === 'all';
  }
}

function refusal(status: 401 | 403 | 503): NextResponse {
  const error = status === 403 ? 'Forbidden' : status === 401 ? 'Authentication required' : 'Workspace verification unavailable';
  return NextResponse.json({ error }, { status });
}

/**
 * The scope an image upload is ingested under, resolved in the request before anything is stored. The user is the session
 * user the route already verified (no second lookup); an organization from the form counts only after the membership check.
 * A Config UI upload (upload_source=config_upload) asks checkAdmin once: only an ok result for that same user gives the
 * admin workspace scope; a 401, a 403 or another user gives the session scope, and a 503 refuses. The admin cookie never
 * replaces the session, which was checked first, and never changes the storage prefix.
 */
async function resolveUploadScope(
  request: NextRequest,
  formData: FormData,
  sessionUser: { id: string },
): Promise<{ scope: TenantScope } | { response: NextResponse }> {
  const { repairOwnerMembership, resolveAdminWorkspaceScope, resolveTenantScope } = await import('@/lib/rag');
  const getUser = async () => sessionUser;
  const organization = formData.get('organization_id');
  const requestedOrganizationId = typeof organization === 'string' && organization !== '' ? organization : null;

  if (formData.get('upload_source') === 'config_upload') {
    const { checkAdmin } = await import('@/lib/admin-route-auth');
    const admin = await checkAdmin(request);
    if (!admin.ok && admin.status === 503) {
      return { response: NextResponse.json({ error: 'Admin verification is unavailable' }, { status: 503 }) };
    }
    if (admin.ok && admin.userId.toLowerCase() === sessionUser.id.toLowerCase()) {
      const workspace = await resolveAdminWorkspaceScope({
        adminUserId: sessionUser.id,
        requestedOrganizationId,
        signal: request.signal,
      });
      return workspace.ok ? { scope: workspace.scope } : { response: refusal(workspace.status) };
    }
  }

  await repairOwnerMembership({ requestedOrganizationId, getUser });
  const tenant = await resolveTenantScope({ requestedOrganizationId, getUser, signal: request.signal });
  if (!tenant.ok) return { response: refusal(tenant.status) };
  if (!tenant.scope) return { response: refusal(401) };
  return { scope: tenant.scope };
}

interface PendingImage {
  name: string;
  type: string;
  bytes: Uint8Array;
  filePath: string;
  downloadUrl: string;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    logger.info('Upload API', 'File upload request received');

    let user: { id: string } | null = null;
    try {
      const supabase = await createClient();
      const { data, error: authError } = await supabase.auth.getUser();
      user = !authError && data?.user?.id ? { id: data.user.id } : null;
    } catch {
      logger.error('Upload API', 'Session lookup failed');
      return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
    }
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    const sessionUser = user;

    // Check if supabaseAdmin is available
    if (!supabaseAdmin) {
      logger.error('Upload API', 'Supabase admin client not available');
      return NextResponse.json(
        { error: 'Storage service unavailable' },
        { status: 500 }
      );
    }

    // Parse FormData
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    const processRag = formData.get('process_rag') === 'true';
    if (processRag && isSingleTenant()) {
      const access = await checkSingleTenantKbWrite({
        admin: supabaseAdmin as unknown as RagAdminDb,
        userId: sessionUser.id,
        signal: request.signal,
      });
      if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
      }
    }

    // The unified pipeline resolves its scope here, before any storage write, from the session already verified above
    let ingestScope: TenantScope | null = null;
    const pipeline = processRag ? await uploadPipeline() : 'legacy';
    if (pipeline === 'blocked') {
      return NextResponse.json({ error: 'languages_not_configured' }, { status: 503 });
    }
    if (processRag && pipeline === 'legacy' && (await legacyUploadRefused())) {
      const { legacyApprovalRefusal } = await import('@/lib/rag');
      return legacyApprovalRefusal();
    }
    const requestedScopes = formData.getAll('scopes');
    let uploadScopes: string[] | undefined;
    let uploadReplaces: string | undefined;
    if (pipeline === 'unified') {
      const resolved = await resolveUploadScope(request, formData, sessionUser);
      if ('response' in resolved) return resolved.response;
      ingestScope = resolved.scope;
      // D-40: the uploader's tags, checked against the workspace's active vocabulary before any file is stored.
      const { validateUploadScopes } = await import('@/lib/rag');
      const scopeCheck = await validateUploadScopes(ingestScope, requestedScopes, { signal: request.signal });
      if (!scopeCheck.ok) {
        console.warn('[Ingest] upload scope tags refused', { reason: scopeCheck.reason });
        return scopeCheck.reason === 'unavailable'
          ? NextResponse.json({ error: 'scope_tags_unavailable' }, { status: 503 })
          : NextResponse.json({ success: false, error: scopeCheck.reason }, { status: 400 });
      }
      uploadScopes = scopeCheck.scopes;
      // D-41: "Replaces…" names one current document of the same workspace; it applies to a single ingested file only.
      const requestedReplaces = formData.get('replaces_document_id');
      if (typeof requestedReplaces === 'string' && requestedReplaces.trim() !== '' && files.length > 1) {
        return NextResponse.json({ success: false, error: 'replaces_needs_one_file' }, { status: 400 });
      }
      const { validateUploadReplaces } = await import('@/lib/rag');
      // Every image upload starts its own lineage (a unique storage path), so it can never be the named document's lineage.
      const replacesCheck = await validateUploadReplaces(ingestScope, requestedReplaces, { signal: request.signal, source: 'image_upload', sourceKey: '' });
      if (!replacesCheck.ok) {
        console.warn('[Ingest] upload replaces refused', { reason: replacesCheck.reason });
        return replacesCheck.reason === 'unavailable'
          ? NextResponse.json({ error: 'replaces_unavailable' }, { status: 503 })
          : NextResponse.json({ success: false, error: replacesCheck.reason }, { status: 400 });
      }
      uploadReplaces = replacesCheck.replacesDocumentId;
    } else if (requestedScopes.length > 0) {
      // Tags count only where the unified pipeline ingests; the legacy path loads nothing new for them.
      console.warn('[Ingest] upload scope tags ignored', { count: requestedScopes.length, reason: processRag ? 'legacy_pipeline' : 'not_ingested' });
    }
    const pendingImages: PendingImage[] = [];

    logger.info('Upload API', `Processing ${files.length} files`);

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided' },
        { status: 400 }
      );
    }

    const uploadResults = [];
    const errors = [];

    for (const file of files) {
      try {
        // Validate file type
        if (!ALLOWED_TYPES.includes(file.type)) {
          errors.push(`File ${file.name}: Unsupported file type ${file.type}`);
          continue;
        }

        // Validate file size
        if (file.size > MAX_FILE_SIZE) {
          errors.push(`File ${file.name}: File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
          continue;
        }

        // Generate unique filename
        const uniqueFilename = generateUniqueFilename(file.name);
        const filePath = `${sessionUser.id}/${uniqueFilename}`;

        // Convert file to buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);

        logger.info('Upload API', `Uploading file: ${file.name} (${file.size} bytes) as ${filePath}`);

        // Upload to Supabase Storage
        const { data, error } = await supabaseAdmin.storage
          .from(BUCKET_NAME)
          .upload(filePath, buffer, {
            contentType: file.type,
            duplex: 'half'
          });

        if (error) {
          logger.error('Upload API', `Upload failed for ${file.name}:`, error);
          errors.push(`File ${file.name}: Upload failed - ${error.message}`);
          continue;
        }

        // Generate download URL for MCP compatibility
        const downloadUrl = getDownloadUrl(filePath);
        if (ingestScope && file.type.startsWith('image/')) {
          pendingImages.push({ name: file.name, type: file.type, bytes: buffer, filePath, downloadUrl });
        }

        uploadResults.push({
          originalName: file.name,
          fileName: uniqueFilename,
          filePath: filePath,
          downloadUrl: downloadUrl,
          size: file.size,
          type: file.type,
          uploadedAt: new Date().toISOString()
        });

        logger.info('Upload API', `Successfully uploaded: ${file.name} -> ${downloadUrl}`);

      } catch (fileError) {
        logger.error('Upload API', `Error processing file ${file.name}:`, fileError);
        errors.push(`File ${file.name}: Processing failed - ${fileError instanceof Error ? fileError.message : 'Unknown error'}`);
      }
    }

    // Return results
    const response = {
      success: uploadResults.length > 0,
      uploaded: uploadResults.length,
      total: files.length,
      files: uploadResults,
      errors: errors.length > 0 ? errors : undefined
    };

    logger.info('Upload API', `Upload complete: ${uploadResults.length}/${files.length} files uploaded`);

    // Trigger background RAG processing for images (RAG integration)
    // We don't await this to keep the upload response fast
    const imageContext = formData.get('image_context') as string | undefined;

    let queuedIngest: EnqueueResult[] | null = null;
    if (ingestScope && pendingImages.length > 0) {
      queuedIngest = await scheduleImageIngest(ingestScope, sessionUser.id, pendingImages, imageContext || undefined, startedAt, uploadScopes, uploadReplaces);
    }

    (async () => {
      try {
        // The unified pipeline ingests in the background task scheduled above
        if (ingestScope) {
          return;
        }

        // Only process for RAG if explicitly requested
        if (!processRag) {
          return;
        }

        logger.info('Upload API', `Starting background image processing for user ${sessionUser.id}`);

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const result = uploadResults.find(r => r.originalName === file.name);

          if (result && file.type.startsWith('image/')) {
            logger.info('Upload API', `Processing image for RAG: ${file.name}`);

            // Get file buffer again
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Process in background without awaiting
            processImageDocument(file.name, buffer, {
              user_id: sessionUser.id,
              source: 'upload',
              image_url: result.downloadUrl,
              image_type: file.type,
              image_context: imageContext || undefined,
              source_file_id: result.filePath
            }).catch(err => {
              logger.error('Upload API', `Error in background image processing for ${file.name}:`, err);
            });
          }
        }
      } catch (error) {
        logger.error('Upload API', 'Background image processing failed:', error);
      }
    })();

    if (uploadResults.length === 0) {
      return NextResponse.json(response, { status: 400 });
    }

    if (queuedIngest) {
      const failed = queuedIngest.some((row) => row.status === 'failed');
      const queued = queuedIngest.some((row) => row.status === 'queued');
      if (failed && !queued) {
        return NextResponse.json({ ...response, status: 'failed' }, { status: 500 });
      }
      const ingestPayload =
        queuedIngest.length === 1
          ? {
              jobId: queuedIngest[0]!.jobId,
              documentId: queuedIngest[0]!.documentId,
              status: queuedIngest[0]!.status,
            }
          : { ingestJobs: queuedIngest };
      return NextResponse.json(
        { ...response, ...ingestPayload },
        { status: queued ? 202 : 200 },
      );
    }

    return NextResponse.json(response, { status: 200 });

  } catch (error) {
    logger.error('Upload API', 'Upload request failed:', error);

    return NextResponse.json(
      {
        error: 'Upload failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

/**
 * Runs the ingestion of the stored images after the response with after(), so the platform keeps the work alive until it is done
 * (an un-awaited promise is dropped when the function freezes). The scope was resolved in the request; the callback holds it and
 * the bytes and never reads the session or the form again. Each image gets what is left of the request budget and a document that
 * runs out of time stays processing and resumable.
 */
async function scheduleImageIngest(
  scope: TenantScope,
  uploaderId: string,
  images: PendingImage[],
  imageContext: string | undefined,
  startedAt: number,
  scopes?: string[],
  replacesDocumentId?: string,
): Promise<EnqueueResult[] | null> {
  const deadlineAt = startedAt + INGEST_BUDGET_MS;

  const buildInput = (image: PendingImage, budgetMs: number) => ({
    scope,
    source: 'image_upload' as const,
    sourceKey: image.filePath,
    uploaderId,
    ...(scopes ? { scopes } : {}),
    ...(replacesDocumentId ? { replacesDocumentId } : {}),
    file: image.bytes,
    filename: image.name,
    mimeType: image.type,
    signal: AbortSignal.timeout(budgetMs),
    deadlineMs: budgetMs,
    options: {
      imageUrl: image.downloadUrl,
      ...(imageContext ? { imageContext } : {}),
      origin: { sourceFileId: image.filePath },
      documentMetadata: { image_type: image.type },
    },
  });

  try {
    const { ingest, submitIngest, queueConfigFromProcessEnv, scheduleIngestWake } = await import('@/lib/rag');
    const queueConfig = queueConfigFromProcessEnv();
    if (queueConfig.ingestAsync) {
      const results: EnqueueResult[] = [];
      let queued = false;
      for (const image of images) {
        const budgetMs = Math.max(MIN_INGEST_MS, deadlineAt - Date.now());
        const result = await submitIngest(buildInput(image, budgetMs), { queueConfig: () => queueConfig });
        if ('status' in result && result.status === 'queued') queued = true;
        results.push(result as EnqueueResult);
      }
      if (queued) scheduleIngestWake();
      return results;
    }

    const ingestOne = async (image: PendingImage): Promise<void> => {
      const budgetMs = Math.max(MIN_INGEST_MS, deadlineAt - Date.now());
      try {
        const result = await ingest(buildInput(image, budgetMs));
        console.log('[Ingest] image upload finished', { status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
      } catch (error) {
        console.error('[Ingest] image upload failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
    };

    after(async () => {
      for (let index = 0; index < images.length; index += INGEST_CONCURRENCY) {
        await Promise.allSettled(images.slice(index, index + INGEST_CONCURRENCY).map((image) => ingestOne(image)));
      }
    });
    return null;
  } catch {
    logger.error('Upload API', 'Could not schedule the background ingestion');
    return null;
  }
}

export async function GET() {
  return NextResponse.json(
    {
      message: 'Upload endpoint ready',
      maxFileSize: MAX_FILE_SIZE,
      allowedTypes: ALLOWED_TYPES,
      bucketName: BUCKET_NAME
    },
    { status: 200 }
  );
}