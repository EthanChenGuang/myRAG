import { NextResponse } from 'next/server';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { env } from '@/lib/env';
import { DocumentContent } from '@/types/chat';
import { createClient } from '@supabase/supabase-js';
import {
  CloudRefused,
  assertCloudAllowed,
  buildSourceKey,
  currentIngestConfig,
  unifiedIngestRefusal,
  embedText,
  ingest,
  submitIngest,
  scheduleIngestWake,
  queueConfigFromProcessEnv,
  repairOwnerMembership,
  resolveAdminWorkspaceScope,
  resolveTenantScope,
  type EnqueueResult,
  type IngestResult,
  type RagAdminDb,
  type TenantScope,
} from '@/lib/rag';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { DocTypeDetectionSchema } from '@/lib/rag-eval/contracts.generated';
import { checkSingleTenantKbWrite } from '@/lib/kb-write-access';
import { z } from 'zod/v3';
import { v4 as uuidv4 } from 'uuid';
import { extractURLs } from '@/lib/url-extractor';
import { isMultiTenant, isSingleTenant } from '@/lib/deployment-mode';
import { verifyUserOrganizationAccess } from '@/lib/auth/organization-handler';

// Use Node.js runtime
export const runtime = 'nodejs';

const STORAGE_BUCKET = 'chat-attachments';

// Token-based chunking utilities
function estimateTokens(text: string): number {
  // OpenAI's tokenizer generates roughly 4 characters per token
  return Math.ceil(text.length / 4);
}

function createTokenBasedChunks(text: string, maxTokens: number = 600, overlapTokens: number = 100): string[] {
  // Split into paragraphs first
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const paragraphTokens = estimateTokens(paragraph);

    // If adding this paragraph would exceed max tokens, create a new chunk
    if (currentTokens + paragraphTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n\n'));
      
      // Keep paragraphs for overlap based on token count
      const overlapChunk: string[] = [];
      let overlapTokenCount = 0;
      for (let j = currentChunk.length - 1; j >= 0; j--) {
        const overlapParagraph = currentChunk[j];
        const overlapParagraphTokens = estimateTokens(overlapParagraph);
        if (overlapTokenCount + overlapParagraphTokens <= overlapTokens) {
          overlapChunk.unshift(overlapParagraph);
          overlapTokenCount += overlapParagraphTokens;
        } else {
          break;
        }
      }
      currentChunk = overlapChunk;
      currentTokens = overlapTokenCount;
    }

    currentChunk.push(paragraph);
    currentTokens += paragraphTokens;
  }

  // Add the last chunk if there's anything left
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n'));
  }

  return chunks;
}

function createCharacterBasedChunks(text: string, chunkSize: number = 1500, chunkOverlap: number = 100): string[] {
  const chunks: string[] = [];
  let start = 0;
  
  while (start < text.length) {
    // Find the end position for this chunk
    let end = start + chunkSize;
    
    // If we're not at the end of the text, try to break at a sentence boundary
    if (end < text.length) {
      // Look for sentence endings (.!?) within the last 20% of the chunk
      const searchStart = Math.max(start + Math.floor(chunkSize * 0.8), start);
      let sentenceEnd = -1;
      
      for (let i = end; i >= searchStart; i--) {
        if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
          // Check if it's followed by a space or newline (to avoid breaking on decimals)
          if (i + 1 < text.length && (text[i + 1] === ' ' || text[i + 1] === '\n')) {
            sentenceEnd = i + 1;
            break;
          }
        }
      }
      
      if (sentenceEnd > 0) {
        end = sentenceEnd;
      }
    }
    
    chunks.push(text.slice(start, end).trim());
    
    // Start the next chunk with overlap
    start = end - chunkOverlap;
    
    // Ensure we make progress
    if (start <= chunks.length * chunkOverlap) {
      start = end;
    }
  }
  
  return chunks.filter(chunk => chunk.length > 10);
}

// Initialize Supabase admin client (only for image storage)
const supabaseAdmin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

interface LlamaCloudUploadResponse {
  id: string;
  status: string;
}

interface LlamaCloudProcessingResult {
  text: string;
  metadata: {
    total_pages?: number;
  };
  images?: Array<{
    data: string;
    pageNumber?: number;
  }>;
  chunks?: string[];
}

interface LlamaCloudJobStatus {
  status: 'processing' | 'completed' | 'failed';
  error?: string;
}

function getLlamaCloudApiKey(): string {
  const apiKey = env.LLAMA_CLOUD_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('LlamaCloud API key is missing. Set LLAMA_CLOUD_API_KEY in .env.local or the Config UI, save the configuration, and restart the app server.');
  }

  return apiKey;
}

function createLlamaCloudAuthError(status: number, statusText: string, errorText?: string): Error {
  const upstreamDetails = errorText?.trim()
    ? ` LlamaCloud response: ${errorText.trim()}`
    : '';

  return new Error(
    `LlamaCloud authentication failed (${status} ${statusText}). ` +
    `Check LLAMA_CLOUD_API_KEY in .env.local or the Config UI, save the configuration, and restart the app server.` +
    upstreamDetails
  );
}

function isLlamaCloudConfigurationError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('LLAMA_CLOUD_API_KEY') ||
    error.message.includes('LlamaCloud authentication failed')
  );
}

async function uploadToLlamaCloud(buffer: Buffer, filename: string): Promise<LlamaCloudUploadResponse> {
  if (!assertCloudAllowed('parse').ok) throw new CloudRefused('cloud_not_allowed');
  const llamaCloudApiKey = getLlamaCloudApiKey();
  const formData = new FormData();
  formData.append('file', buffer, filename);

  const parsing_config = {
    chunk_size: parseInt(env.LLAMACLOUD_CHUNK_SIZE),
    chunk_overlap: parseInt(env.LLAMACLOUD_CHUNK_OVERLAP),
    chunk_strategy: env.LLAMACLOUD_CHUNK_STRATEGY,
    include_chunks: true,
    include_metadata: true,
    // Images are included based on parsing mode capabilities
    include_images: env.LLAMACLOUD_PARSING_MODE !== 'fast', // Premium and Balanced can handle images
    // Add parsing mode configuration
    ...(env.LLAMACLOUD_PARSING_MODE === 'premium' && { premium_mode: true }),
    ...(env.LLAMACLOUD_PARSING_MODE === 'fast' && { fast_mode: true }),
    // balanced mode is default, no additional flag needed
  };

  const output_config = {
    result_type: "markdown",
    language: "en"
  };

  formData.append('parsing_config', JSON.stringify(parsing_config));
  formData.append('output_config', JSON.stringify(output_config));
  formData.append('auto_mode', 'true');
  formData.append('auto_mode_trigger_on_table', 'true');
  formData.append('auto_mode_trigger_on_image', 'true');

  const uploadResponse = await fetch('https://api.cloud.llamaindex.ai/api/parsing/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${llamaCloudApiKey}`
    },
    body: formData,
    timeout: 60000
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    if (uploadResponse.status === 401 || uploadResponse.status === 403) {
      throw createLlamaCloudAuthError(uploadResponse.status, uploadResponse.statusText, errorText);
    }
    throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorText}`);
  }

  return uploadResponse.json();
}

async function waitForJobCompletion(jobId: string, maxAttempts = 40): Promise<void> {
  console.log('Waiting for job completion...');
  const llamaCloudApiKey = getLlamaCloudApiKey();
  let lastStatus = '';
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 3;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(
        `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`,
        {
          headers: {
            'Authorization': `Bearer ${llamaCloudApiKey}`,
            'Accept': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw createLlamaCloudAuthError(response.status, response.statusText, errorText);
        }
        console.error(`Job status check failed (attempt ${attempt + 1}):`, {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        
        if (response.status === 404) {
          // If job not found, wait a bit longer as it might still be initializing
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(`Failed to check job status after ${maxConsecutiveErrors} consecutive attempts: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        // Wait longer between retries when errors occur
        const errorRetryDelay = Math.min(5000 * Math.pow(1.5, consecutiveErrors), 15000);
        console.log(`Error checking status, waiting ${Math.round(errorRetryDelay/1000)}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, errorRetryDelay));
        continue;
      }
      
      // Reset consecutive error counter on successful response
      consecutiveErrors = 0;

      const status = await response.json();
      
      // Only log status if it changed
      if (status.status !== lastStatus) {
        console.log(`Job status (attempt ${attempt + 1}):`, status);
        lastStatus = status.status;
      }

      if (status.status === 'SUCCESS') {
        console.log('Job completed successfully');
        return;
      }
      
      if (status.status === 'FAILED') {
        const errorMessage = status.error || 'Unknown error';
        console.error('Job failed with error:', errorMessage);
        throw new Error(`Job failed: ${errorMessage}`);
      }
      
      if (status.status === 'PENDING' || status.status === 'PROCESSING') {
        // Adaptive delay: Wait longer as the number of attempts increases
        // Start with 2 seconds, gradually increase up to 8 seconds
        const baseDelay = 2000;
        const adaptiveDelay = Math.min(baseDelay + (attempt * 300), 8000);
        console.log(`Job still ${status.status.toLowerCase()}. Waiting ${Math.round(adaptiveDelay/1000)}s before next check...`);
        await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
        continue;
      }

      throw new Error(`Unknown job status: ${status.status}`);
    } catch (error) {
      // Log the full error for debugging
      console.error(`Error checking job status (attempt ${attempt + 1}):`, error);
      
      if (attempt >= maxAttempts - 1) {
        // On final attempt, throw a more descriptive error
        throw new Error(
          `Document processing timed out after ${maxAttempts} attempts. ` +
          `Last error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
      
      // Wait before retry with exponential backoff
      const retryDelay = Math.min(3000 * Math.pow(1.5, attempt), 15000);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  throw new Error(
    `Document processing timed out after ${maxAttempts} attempts. ` +
    `Last known status: ${lastStatus || 'unknown'}`
  );
}

async function processWithLlamaCloud(jobId: string): Promise<LlamaCloudProcessingResult> {
  console.log('Fetching processing results...');
  const llamaCloudApiKey = getLlamaCloudApiKey();
  const response = await fetch(
    `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/markdown`,
    {
      headers: {
        'Authorization': `Bearer ${llamaCloudApiKey}`,
        'Accept': 'application/json'
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw createLlamaCloudAuthError(response.status, response.statusText, errorText);
    }
    throw new Error(`Failed to get results: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const result = await response.json();
  console.log('Processing results received:', {
    hasText: Boolean(result.markdown),
    textLength: result.markdown?.length,
    hasMetadata: Boolean(result.metadata),
    imageCount: result.images?.length || 0,
    hasChunks: Boolean(result.chunks),
    numChunks: result.chunks?.length || 0
  });
  
  // Convert the response format to match our expected structure
  return {
    text: result.markdown || '',
    metadata: {
      total_pages: result.metadata?.total_pages
    },
    images: result.images,
    chunks: result.chunks // Include chunks if provided by LlamaCloud
  };
}

async function uploadExtractedImage(imageBuffer: Buffer, filename: string): Promise<string> {
  console.log(`Uploading extracted image: ${filename}`);
  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(`extracted-images/${filename}`, imageBuffer, {
      contentType: 'image/jpeg',
      cacheControl: '3600'
    });

  if (error) {
    console.error('Error uploading image:', error);
    throw error;
  }

  console.log('Image uploaded successfully');
  const { data: urlData } = supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(`extracted-images/${filename}`);

  return urlData.publicUrl;
}

// Function to store document and its chunks in Supabase
async function storeDocument(
  filename: string,
  content: string,
  chunks: string[],
  userId: string | null,
  organizationId?: string | null
) {
  console.log('Storing document in Supabase:', filename);
  console.log('Deployment mode:', isSingleTenant() ? 'single-tenant' : 'multi-tenant');
  console.log('User ID:', userId || 'N/A (single-tenant)');
  console.log('Organization ID:', organizationId || 'N/A');

  // Generate document ID
  const documentId = uuidv4();
  console.log('Generated document ID:', documentId);

  try {
    // Prepare document data based on deployment mode
    const documentData: any = {
      id: documentId,
      filename: filename,
      content: content,
    };

    // SINGLE-TENANT MODE: shared knowledge base; user_id records the owner who may later modify it
    if (isSingleTenant()) {
      console.log('Single-tenant mode: document will be shared in knowledge base');
      if (userId) documentData.user_id = userId;
    } else {
      // MULTI-TENANT MODE: Full user/organization isolation
      if (userId) {
        documentData.user_id = userId; // Owner
        documentData.uploaded_by = userId; // Legacy field
      }
      // Add organization_id for team documents (NULL for personal)
      if (organizationId) {
        documentData.organization_id = organizationId;
        console.log('Team document: will be accessible to org members');
      } else {
        documentData.organization_id = null;
        console.log('Personal document: accessible only to user');
      }
    }

    // Store the document first - only include required fields
    const { data: document, error: documentError } = await supabaseAdmin
      .from('documents')
      .insert([documentData])
      .select()
      .single();

    if (documentError) {
      console.error('Error storing document:', documentError);
      throw documentError;
    }

    // Process chunks in batches to avoid overwhelming the database
    const BATCH_SIZE = 10;
    console.log(`Processing ${chunks.length} chunks in batches of ${BATCH_SIZE}`);
    
    let successfulChunks = 0;
    
    // Process chunks in batches using Promise.all
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
      
      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} chunks)`);
      
      try {
        // Process chunks in parallel within each batch
        // Use allSettled instead of all to handle partial failures
        const embeddingResults = await Promise.allSettled(
          batch.map(chunk => embedText(chunk, { signal: new AbortController().signal }))
        );
        
        // Filter out failed embeddings and prepare batch insert
        const chunkInserts = embeddingResults
          .map((result, index) => {
            if (result.status === 'fulfilled') {
              const globalChunkIndex = i + index;
              const chunkPosition = globalChunkIndex + 1;
              const chunkContent = batch[index];

              // Extract URLs from chunk content for link inclusion in AI responses
              const urlMetadata = extractURLs(chunkContent);

              const chunkData: any = {
                id: uuidv4(),
                document_id: documentId,
                content: `Document: ${filename}. Chunk ${chunkPosition} of ${chunks.length}. Content: ${chunkContent}`,
                embedding: result.value,
                metadata: {
                  document_title: filename,
                  chunk_index: globalChunkIndex,
                  chunk_position: chunkPosition,
                  total_chunks: chunks.length,

                  // URL metadata for link inclusion in AI responses
                  urls: urlMetadata.urls,
                  has_urls: urlMetadata.hasLinks,
                  url_count: urlMetadata.linkCount,
                  url_categories: [...new Set(urlMetadata.urls.map(u => u.category))],
                }
              };

              // Add organization_id if provided (required in multi-tenant mode)
              if (organizationId) {
                chunkData.organization_id = organizationId;
              }

              return chunkData;
            }
            // Log the failure but continue processing
            console.error(`Failed to generate embedding for chunk at index ${i + index}:`,
              result.status === 'rejected' ? result.reason : 'Unknown error');
            return null;
          })
          .filter(Boolean); // Remove nulls from failed embeddings
        
        if (chunkInserts.length === 0) {
          console.warn(`No valid embeddings generated for batch ${batchNum}, skipping database insert`);
          continue;
        }
        
        // Insert all chunks for this batch in a single database call
        const { error: chunkError } = await supabaseAdmin
          .from('document_chunks')
          .insert(chunkInserts);
        
        if (chunkError) {
          console.error(`Error storing chunk batch ${batchNum}:`, chunkError);
        } else {
          successfulChunks += chunkInserts.length;
          console.log(`Successfully stored batch ${batchNum}/${totalBatches} (${chunkInserts.length}/${batch.length} chunks)`);
        }
      } catch (batchError) {
        console.error(`Error processing batch ${batchNum}:`, batchError);
      }
    }
    
    console.log(`Document storage complete. Successfully stored ${successfulChunks}/${chunks.length} chunks`);
    
    // Even if some chunks failed, return the document ID
    // The document is still useful with partial chunks
    return { documentId, successfulChunks, totalChunks: chunks.length };
  } catch (error) {
    console.error('Error in storeDocument:', error);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// Unified pipeline (RAG_INGEST_PIPELINE=unified): knowledge-base uploads go through ingest().
// Everything below runs only after POST has verified the session (and, in multi-tenant mode, the
// organization), so no path that parses, ingests or stores can be reached without a session.
// ---------------------------------------------------------------------------------------------------

const UPLOAD_BUDGET_MS = 50_000;
const MIN_INGEST_BUDGET_MS = 5_000;
const MAX_UNIFIED_FILE_SIZE = 20 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream']);
const ALLOWED_MIME_TYPES = new Set([
  ...Object.values(EXTENSION_MIME),
  'text/x-markdown',
  'text/rtf',
  'application/csv',
  'application/vnd.ms-excel',
]);

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const unifiedUploadFormSchema = z.object({
  doc_type: z.preprocess(emptyToUndefined, z.union([DocTypeDetectionSchema.shape.doc_type, z.literal('auto')]).optional()),
  upload_source: z.preprocess(emptyToUndefined, z.enum(['chat_upload', 'config_upload']).optional()),
  folder_id: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(200).regex(/^[^\p{Cc}]*$/u).optional()),
});

function uploadPipeline(): 'legacy' | 'unified' {
  try {
    return currentIngestConfig().pipeline === 'unified' ? 'unified' : 'legacy';
  } catch {
    console.warn('[ProcessDocument] ingest switch unavailable, using the legacy pipeline');
    return 'legacy';
  }
}

function mimeForExtension(extension: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(EXTENSION_MIME, extension) ? EXTENSION_MIME[extension] : undefined;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The media type handed to ingest, or null when the file is outside the allow-list. */
function acceptedMediaType(name: string, declaredType: string): string | null {
  const declared = declaredType.split(';')[0].trim().toLowerCase();
  const extension = fileExtension(name);
  const extensionMime = mimeForExtension(extension);
  if (extension !== '' && !extensionMime) return null;
  if (GENERIC_MIME_TYPES.has(declared)) return extensionMime ?? null;
  return ALLOWED_MIME_TYPES.has(declared) ? declared : null;
}

function isEnqueueResult(result: IngestResult | EnqueueResult): result is EnqueueResult {
  return 'jobId' in result;
}

function documentTypeOf(name: string): DocumentContent['type'] {
  const extension = fileExtension(name);
  return extension === 'pdf' || extension === 'doc' || extension === 'docx' || extension === 'txt' ||
    extension === 'pptx' || extension === 'xlsx' || extension === 'html' || extension === 'rtf' || extension === 'epub'
    ? (extension as DocumentContent['type'])
    : 'txt';
}

function scopeRefusal(status: 401 | 403 | 503): NextResponse {
  const error = status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorized' : 'Workspace verification unavailable';
  return NextResponse.json({ error }, { status });
}

async function uploadThroughIngest(input: {
  req: Request;
  formData: { get(name: string): FormDataEntryValue | null };
  file: File;
  userId: string | null;
  orgIdFromForm: string | null;
  startedAt: number;
}): Promise<NextResponse> {
  const { req, file, orgIdFromForm } = input;
  if (!input.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = input.userId;

  const parsedForm = unifiedUploadFormSchema.safeParse({
    doc_type: input.formData.get('doc_type') ?? undefined,
    upload_source: input.formData.get('upload_source') ?? undefined,
    folder_id: input.formData.get('folder_id') ?? undefined,
  });
  if (!parsedForm.success) {
    console.warn('[ProcessDocument] Invalid upload form', { paths: parsedForm.error.errors.map((issue) => issue.path.join('.')) });
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid request data',
        details: parsedForm.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      { status: 400 },
    );
  }
  const form = parsedForm.data;

  if (file.size > MAX_UNIFIED_FILE_SIZE) {
    return NextResponse.json(
      { error: `File size exceeds limit. Maximum allowed size is ${MAX_UNIFIED_FILE_SIZE / 1024 / 1024}MB` },
      { status: 413 },
    );
  }
  const mimeType = acceptedMediaType(file.name, file.type);
  if (mimeType === null) {
    return NextResponse.json({ error: 'This file type is not supported' }, { status: 415 });
  }

  // config_upload is honoured only for the verified session user when the admin guard names the same user.
  let source: 'chat_upload' | 'config_upload' = 'chat_upload';
  if (form.upload_source === 'config_upload') {
    const admin = await checkAdmin(req);
    if (!admin.ok && admin.status === 503) return adminDenied(503);
    if (admin.ok && admin.userId.toLowerCase() === userId.toLowerCase()) source = 'config_upload';
  }

  const getUser = async () => ({ id: userId });
  await repairOwnerMembership({ requestedOrganizationId: orgIdFromForm, getUser });
  let scope: TenantScope;
  if (source === 'config_upload') {
    const resolved = await resolveAdminWorkspaceScope({
      adminUserId: userId,
      requestedOrganizationId: orgIdFromForm,
      signal: req.signal,
    });
    if (!resolved.ok) return scopeRefusal(resolved.status);
    scope = resolved.scope;
  } else {
    const tenant = await resolveTenantScope({
      requestedOrganizationId: typeof orgIdFromForm === 'string' ? orgIdFromForm : null,
      getUser,
      signal: req.signal,
    });
    if (!tenant.ok) return scopeRefusal(tenant.status);
    if (!tenant.scope) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    scope = tenant.scope;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const deadlineMs = Math.max(MIN_INGEST_BUDGET_MS, UPLOAD_BUDGET_MS - (Date.now() - input.startedAt));

  const ingestInput = {
    scope,
    source,
    sourceKey: buildSourceKey(source, { folderId: form.folder_id, filename: file.name }),
    file: bytes,
    filename: file.name,
    mimeType,
    ...(form.doc_type ? { docType: form.doc_type } : {}),
    signal: req.signal,
    deadlineMs,
  };

  let result: IngestResult | EnqueueResult;
  try {
    result = queueConfigFromProcessEnv().ingestAsync ? await submitIngest(ingestInput) : await ingest(ingestInput);
  } catch (error) {
    console.error('[ProcessDocument] ingest threw', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ error: 'Failed to process document', status: 'failed' }, { status: 500 });
  }

  if (isEnqueueResult(result)) {
    console.log('[ProcessDocument] Enqueued upload', {
      source,
      status: result.status,
      documentId: result.documentId,
      jobId: result.jobId,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    if (result.status === 'failed') {
      return NextResponse.json({ error: 'Failed to process document', status: 'failed' }, { status: 500 });
    }
    if (result.status === 'skipped_duplicate') {
      return NextResponse.json(
        {
          id: result.documentId,
          documentId: result.documentId,
          jobId: result.jobId,
          name: file.name,
          filename: file.name,
          type: documentTypeOf(file.name),
          status: 'skipped_duplicate',
        },
        { status: 200 },
      );
    }
    scheduleIngestWake();
    return NextResponse.json(
      {
        jobId: result.jobId,
        documentId: result.documentId,
        status: 'queued',
        id: result.documentId,
        name: file.name,
        filename: file.name,
        type: documentTypeOf(file.name),
      },
      { status: 202 },
    );
  }

  console.log('[ProcessDocument] Ingested upload', {
    source,
    status: result.status,
    documentId: result.documentId ?? result.duplicateOf ?? null,
    chunks: result.chunkCount,
    ...(result.reason ? { reason: result.reason } : {}),
  });

  if (result.status === 'failed') {
    return NextResponse.json({ error: 'Failed to process document', status: 'failed' }, { status: 500 });
  }
  const documentId = result.documentId ?? result.duplicateOf ?? null;
  return NextResponse.json(
    {
      id: documentId,
      documentId,
      name: file.name,
      filename: file.name,
      type: documentTypeOf(file.name),
      successfulChunks: result.chunkCount,
      totalChunks: result.chunkCount,
      status: result.status,
      version: result.version,
      parserUsed: result.parserUsed,
    },
    { status: result.status === 'processing' ? 202 : 200 },
  );
}


export async function POST(req: Request) {
  const startedAt = Date.now();
  console.log('[ProcessDocument] POST request received');
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const isTemporary = formData.get('isTemporary') === 'true';
    const orgIdFromForm = formData.get('organization_id') as string | null;

    console.log('[ProcessDocument] File received:', { present: Boolean(file) });
    console.log('[ProcessDocument] isTemporary:', isTemporary);
    console.log('[ProcessDocument] organization_id from form:', orgIdFromForm);

    if (!file) {
      console.log('[ProcessDocument] No file provided, returning 400');
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Handle user/organization based on deployment mode
    let userId: string | null = null;
    let organizationId: string | null = null;

    // Every request needs a verified session: permanent writes persist to the knowledge base,
    // and temporary parsing still spends the operator's LlamaCloud quota.
    if (isSingleTenant()) {
      try {
        const { createClient: createSSRClient } = await import('@/lib/supabase/server');
        const supabase = await createSSRClient();
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();
        if (!user || authError) {
          return NextResponse.json(
            { error: 'Authentication required. Please sign in to process documents.' },
            { status: 401 }
          );
        }
        userId = user.id;
      } catch {
        console.error('[ProcessDocument] Session lookup failed');
        return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
      }
      organizationId = null;

      if (!isTemporary) {
        const access = await checkSingleTenantKbWrite({
          admin: supabaseAdmin as unknown as RagAdminDb,
          userId,
          signal: req.signal,
        });
        if (!access.ok) {
          return NextResponse.json({ error: access.error }, { status: access.status });
        }
      }
    } else {
      // MULTI-TENANT MODE: Get user_id and optional organization_id
      // Use SSR Supabase client (cookie-aware) to read the user session reliably
      const { createClient: createSSRClient } = await import('@/lib/supabase/server');
      const supabase = await createSSRClient();
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError) {
        console.log('Unable to authenticate upload request:', authError.message);
      }

      if (user) {
        // Authenticated user upload
        userId = user.id;
        console.log('Authenticated upload by user:', userId);

        // Check if organization_id was provided in formData (for team uploads)
        // orgIdFromForm is already defined above

        if (orgIdFromForm && isMultiTenant()) {
          // Organization upload: validate user is a member or the owner.
          // Restored databases can have organizations.owner_id without the
          // matching organization_members row, so ownership is also accepted.
          const access = await verifyUserOrganizationAccess(userId, orgIdFromForm);

          if (access.hasAccess) {
            organizationId = orgIdFromForm;
            console.log('Organization upload:', {
              organizationId,
              role: access.role || 'unknown'
            });
          } else {
            return NextResponse.json(
              { error: 'You are not a member of this organization. Select a workspace that belongs to the signed-in user, or invite this user to the selected workspace before uploading.' },
              { status: 403 }
            );
          }
        } else {
          // Personal upload (no organization)
          organizationId = null;
          console.log('Personal upload (user workspace)');
        }
      } else {
        return NextResponse.json(
          { error: 'Authentication required. Please sign in and upload from your Personal Workspace.' },
          { status: 401 }
        );
      }
    }

    // Knowledge-base uploads switch to ingest() only here, after the session and organization checks above.
    // Temporary attachments stay on the legacy parse call in both pipelines.
    if (!isTemporary && uploadPipeline() === 'unified') {
      const refusal = unifiedIngestRefusal();
      if (refusal) return NextResponse.json(refusal, { status: 503 });
      return await uploadThroughIngest({ req, formData, file, userId, orgIdFromForm, startedAt });
    }

    console.log('Processing file', isTemporary ? '(temporary)' : '(permanent)');
    const buffer = Buffer.from(await file.arrayBuffer());
    const extension = file.name.split('.').pop()?.toLowerCase();
    const fileSize = buffer.length;
    
    // Log file details
    console.log('File details:', {
      type: file.type,
      size: `${(fileSize / 1024 / 1024).toFixed(2)} MB`,
      extension
    });

    // Add file size validation
    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
    if (fileSize > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds limit. Maximum allowed size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    // The cloud switch holds in every pipeline; the session and organization checks above stay first.
    if (!assertCloudAllowed('parse').ok) {
      console.warn('[Ingest] cloud parsing disabled');
      return NextResponse.json({ error: 'cloud_parsing_disabled' }, { status: 503 });
    }

    // Process with LlamaCloud (for both temporary and permanent documents)
    console.log('Using LlamaCloud for document processing', isTemporary ? '(temporary)' : '(permanent)');
    
    let uploadResult;
    try {
      uploadResult = await uploadToLlamaCloud(buffer, file.name);
      
      if (!uploadResult.id) {
        throw new Error('No job ID in upload response');
      }
      
      console.log('File uploaded to LlamaCloud, job ID:', uploadResult.id);
    } catch (uploadError) {
      if (uploadError instanceof CloudRefused) {
        return NextResponse.json({ error: 'cloud_parsing_disabled' }, { status: 503 });
      }
      console.error('Error uploading to LlamaCloud:', uploadError);
      return NextResponse.json(
        { error: `Failed to upload document: ${uploadError instanceof Error ? uploadError.message : 'Unknown error'}` },
        { status: isLlamaCloudConfigurationError(uploadError) ? 502 : 500 }
      );
    }

    // Wait for job completion with timeout handling
    try {
      await waitForJobCompletion(uploadResult.id);
      console.log('Job completed, fetching results');
    } catch (jobError) {
      console.error('Error waiting for job completion:', jobError);
      // If this is a timeout error, provide a more user-friendly message
      if (jobError instanceof Error && jobError.message.includes('timed out')) {
        return NextResponse.json(
          { 
            error: 'Document processing is taking longer than expected. Please try with a smaller document or try again later.',
            jobId: uploadResult.id // Return job ID so client could potentially poll for completion
          },
          { status: 504 } // Gateway Timeout status
        );
      }
      
      return NextResponse.json(
        { error: `Document processing failed: ${jobError instanceof Error ? jobError.message : 'Unknown error'}` },
        { status: isLlamaCloudConfigurationError(jobError) ? 502 : 500 }
      );
    }

    let processingResult;
    try {
      processingResult = await processWithLlamaCloud(uploadResult.id);
      const { text, metadata, images } = processingResult;

      if (!text) {
        throw new Error('No text content extracted from document');
      }

      console.log('Document processed successfully:', {
        textLength: text.length,
        hasMetadata: Boolean(metadata),
        imageCount: images?.length || 0
      });
    } catch (processingError) {
      console.error('Error processing document results:', processingError);
      return NextResponse.json(
        { error: `Failed to process document results: ${processingError instanceof Error ? processingError.message : 'Unknown error'}` },
        { status: isLlamaCloudConfigurationError(processingError) ? 502 : 500 }
      );
    }

    const { text, metadata, images, chunks: llamaChunks } = processingResult;

    // For temporary documents, return immediately with just the text
    if (isTemporary) {
      console.log('Temporary document - returning text only, no chunking/embedding');
      
      const documentContent: DocumentContent = {
        id: uuidv4(),
        type: (extension === 'pdf' || extension === 'doc' || extension === 'docx' || extension === 'txt' || 
               extension === 'pptx' || extension === 'xlsx' || extension === 'html' || extension === 'rtf' || extension === 'epub') 
          ? extension as DocumentContent['type']
          : 'txt',
        name: file.name,
        text,
        pages: metadata?.total_pages || 1,
        extractedImages: undefined,
        chunks: undefined,
        successfulChunks: undefined,
        totalChunks: undefined
      };
      
      console.log('Temporary document processed successfully:', {
        name: file.name,
        textLength: text.length,
        type: documentContent.type
      });
      
      return NextResponse.json(documentContent);
    }

    // Process any extracted images (only for permanent documents)
    const processedImages = images ? await Promise.all(
      images.map(async (img: any, index: number) => {
        console.log(`Processing image ${index + 1}/${images.length}`);
        const imgBuffer = Buffer.from(img.data, 'base64');
        const imgFilename = `${Date.now()}-${index}.jpg`;
        const url = await uploadExtractedImage(imgBuffer, imgFilename);
        return {
          url,
          pageNumber: img.pageNumber
        };
      })
    ) : undefined;

    // Determine chunking strategy based on LlamaCloud response and configuration
    let validChunks: string[];
    
    if (llamaChunks && llamaChunks.length > 0) {
      // Use chunks from LlamaCloud if available
      console.log(`Using ${llamaChunks.length} chunks from LlamaCloud`);
      validChunks = llamaChunks.filter(chunk => chunk.trim().length > 10);
    } else {
      // Fall back to creating our own chunks
      console.log('No chunks from LlamaCloud, creating chunks based on configuration');
      
      const chunkSize = parseInt(env.LLAMACLOUD_CHUNK_SIZE);
      const chunkOverlap = parseInt(env.LLAMACLOUD_CHUNK_OVERLAP);
      const chunkStrategy = env.LLAMACLOUD_CHUNK_STRATEGY;
      
      if (chunkStrategy === 'token' || chunkStrategy === 'sentence') {
        // Use token-based chunking for better semantic boundaries
        const maxTokens = Math.floor(chunkSize / 4); // Convert characters to tokens
        const overlapTokens = Math.floor(chunkOverlap / 4);
        validChunks = createTokenBasedChunks(text, maxTokens, overlapTokens);
        console.log(`Created ${validChunks.length} token-based chunks`);
      } else {
        // Use character-based chunking
        validChunks = createCharacterBasedChunks(text, chunkSize, chunkOverlap);
        console.log(`Created ${validChunks.length} character-based chunks`);
      }
    }
    
    // Log chunk statistics
    if (validChunks.length > 0) {
      const avgChunkSize = validChunks.reduce((sum, chunk) => sum + chunk.length, 0) / validChunks.length;
      console.log(`Chunk statistics: count=${validChunks.length}, avgSize=${Math.round(avgChunkSize)} chars`);
      console.log('First chunk preview:', validChunks[0].substring(0, 200) + '...');
    } else {
      console.warn('No valid chunks were generated from the document text. This may affect search functionality.');
    }
    
    // Generate document ID
    const documentId = uuidv4();

    // For permanent documents, store in Supabase
    console.log('Storing permanent document in Supabase...');
    const { documentId: storedDocumentId, successfulChunks, totalChunks } = await storeDocument(
      file.name,
      text,
      validChunks,
      userId,
      organizationId
    );
    console.log('Document stored successfully with ID:', storedDocumentId);
    console.log(`Successfully stored ${successfulChunks}/${totalChunks} chunks with embeddings`);

    // Determine document type from filename
    const type = (extension === 'pdf' || extension === 'doc' || extension === 'docx' || extension === 'txt' || 
                   extension === 'pptx' || extension === 'xlsx' || extension === 'html' || extension === 'rtf' || extension === 'epub') 
      ? extension as DocumentContent['type']
      : 'txt';

    const documentContent: DocumentContent = {
      type,
      name: file.name,
      text,
      pages: metadata.total_pages,
      extractedImages: processedImages,
      id: storedDocumentId,
      successfulChunks,
      totalChunks
    };

    return NextResponse.json(documentContent);
  } catch (error) {
    console.error('[ProcessDocument] Error processing document:', error);
    console.error('[ProcessDocument] Error stack:', error instanceof Error ? error.stack : 'N/A');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
