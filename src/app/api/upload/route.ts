import { NextRequest, NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { createClient } from '@/lib/supabase/server';
import { processImageDocument } from '@/lib/document-processor';
import { logger } from '@/lib/logger';
import { isSingleTenant } from '@/lib/deployment-mode';
import { checkSingleTenantKbWrite } from '@/lib/kb-write-access';
import type { RagAdminDb, TenantScope } from '@/lib/rag';

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

type UploadPipeline = 'legacy' | 'unified';

/**
 * Which write path an upload takes, read per request after the session check. A switch that cannot be read means the legacy path.
 * The pipeline modules are loaded only here and in the unified branch, so the legacy path pulls in nothing new.
 */
async function uploadPipeline(): Promise<UploadPipeline> {
  try {
    const { currentIngestConfig } = await import('@/lib/rag');
    return currentIngestConfig().pipeline === 'unified' ? 'unified' : 'legacy';
  } catch {
    logger.warn('Upload API', 'Ingest switch unavailable, using the legacy pipeline');
    return 'legacy';
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
    if (processRag && (await uploadPipeline()) === 'unified') {
      const resolved = await resolveUploadScope(request, formData, sessionUser);
      if ('response' in resolved) return resolved.response;
      ingestScope = resolved.scope;
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

    if (ingestScope && pendingImages.length > 0) {
      await scheduleImageIngest(ingestScope, pendingImages, imageContext || undefined, startedAt);
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
async function scheduleImageIngest(scope: TenantScope, images: PendingImage[], imageContext: string | undefined, startedAt: number): Promise<void> {
  const deadlineAt = startedAt + INGEST_BUDGET_MS;

  const ingestOne = async (ingest: typeof import('@/lib/rag').ingest, image: PendingImage): Promise<void> => {
    const budgetMs = Math.max(MIN_INGEST_MS, deadlineAt - Date.now());
    try {
      const result = await ingest({
        scope,
        source: 'image_upload',
        sourceKey: image.filePath,
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
      console.log('[Ingest] image upload finished', { status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
    } catch (error) {
      console.error('[Ingest] image upload failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  };

  try {
    const { ingest } = await import('@/lib/rag');
    after(async () => {
      for (let index = 0; index < images.length; index += INGEST_CONCURRENCY) {
        await Promise.allSettled(images.slice(index, index + INGEST_CONCURRENCY).map((image) => ingestOne(ingest, image)));
      }
    });
  } catch {
    logger.error('Upload API', 'Could not schedule the background ingestion');
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