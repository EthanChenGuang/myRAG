import { getNango } from './client';
import { getSupabaseAdmin } from '@/lib/supabase';
import { nangoPipeline, processDocumentWithMetadata } from './document-adapter';
import { fetchFileContent } from './file-fetcher';
import { PROVIDER_CONFIG, type NangoFileRecord, type SupportedProvider, type SyncStats } from './types';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { nangoOwnerScope, queueConfigFromProcessEnv, scopeKey, softDeleteLineage } from '@/lib/rag';
import { removeDocumentObjects, type DocumentObjectRow } from '@/lib/rag/ingest/remove-document-objects';

const SUPPORTED_EXTENSIONS = (env.NANGO_SUPPORTED_FILE_TYPES || 'pdf,doc,docx,txt,md').split(',');
const MAX_FILES_PER_SYNC = parseInt(env.NANGO_MAX_FILES_PER_SYNC || '100');
const DELETION_BATCH_SIZE = 50; // Process deletions in batches to avoid timeouts

// Google Drive MIME types that we can process
const GOOGLE_DRIVE_SUPPORTED_MIMETYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/html',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Google Docs native formats (will be exported)
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
];

/**
 * Check if a file has a supported extension
 */
function isSupportedFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * Check if a Google Drive file is supported by MIME type
 */
function isSupportedGoogleDriveFile(mimeType: string, name: string): boolean {
    // Check by MIME type first
    if (GOOGLE_DRIVE_SUPPORTED_MIMETYPES.includes(mimeType)) {
        return true;
    }
    // Fallback to extension check
    return isSupportedFile(name);
}

/**
 * Google Drive file record from API
 */
interface GoogleDriveFile {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime?: string;
    size?: string;
    parents?: string[];
    webViewLink?: string;
}

/** Most listing pages one run reads; a folder with more than this many pages is treated as cut short. */
const MAX_LISTING_PAGES = 200;

/**
 * Fetch every file of a Google Drive folder through the proxy API, following nextPageToken. `complete` is false when a later page failed
 * or the page limit was reached: the list is then a prefix of the folder and must not be used to decide that a file is gone.
 */
async function fetchGoogleDriveFiles(
    connectionId: string,
    folderId?: string
): Promise<{ files: GoogleDriveFile[]; complete: boolean }> {
    const nango = getNango();

    // Build query - get files from specific folder or root
    let query = "trashed = false";
    if (folderId) {
        query += ` and '${folderId}' in parents`;
    }

    const files: GoogleDriveFile[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LISTING_PAGES; page++) {
        try {
            const response = await nango.proxy({
                providerConfigKey: 'google-drive',
                connectionId: connectionId,
                method: 'GET',
                endpoint: '/drive/v3/files',
                params: {
                    q: query,
                    pageSize: MAX_FILES_PER_SYNC.toString(),
                    fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,webViewLink)',
                    orderBy: 'modifiedTime desc',
                    ...(pageToken ? { pageToken } : {}),
                },
            });
            const data = response.data as { files?: GoogleDriveFile[]; nextPageToken?: string };
            files.push(...(data.files || []));
            if (!data.nextPageToken) return { files, complete: true };
            pageToken = data.nextPageToken;
        } catch (error) {
            logger.error('Nango', 'Failed to fetch Google Drive files', error);
            if (page === 0) throw error;
            return { files, complete: false };
        }
    }
    logger.error('Nango', `Google Drive listing stopped after ${MAX_LISTING_PAGES} pages`);
    return { files, complete: false };
}

function orphanUsesSoftDelete(): boolean {
    if (nangoPipeline() !== 'unified') return false;
    try {
        return queueConfigFromProcessEnv().ingestAsync;
    } catch {
        return false;
    }
}

async function collectNangoLineageIds(
    supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
    tenantKey: string,
    connectionId: string,
    fileId: string
): Promise<string[]> {
    const lineageIds = new Set<string>();
    for (const column of ['source_key', 'source_file_id'] as const) {
        const { data, error } = await supabaseAdmin
            .from('documents')
            .select('id, lineage_id')
            .eq('tenant_key', tenantKey)
            .eq('source', 'nango')
            .eq('source_connection_id', connectionId)
            .eq(column, fileId);
        if (error) throw error;
        for (const row of (data ?? []) as Array<{ id: string; lineage_id: string | null }>) {
            lineageIds.add(row.lineage_id ?? row.id);
        }
    }
    return Array.from(lineageIds);
}

async function softDeleteNangoLineages(
    supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
    tenantKey: string,
    connectionId: string,
    fileId: string,
    userId: string
): Promise<boolean> {
    try {
        const lineages = await collectNangoLineageIds(supabaseAdmin, tenantKey, connectionId, fileId);
        if (lineages.length === 0) return true;
        const owner = nangoOwnerScope({ ownerUserId: userId });
        if (!owner.ok) return false;
        const signal = AbortSignal.timeout(120_000);
        for (const lineageId of lineages) {
            const result = await softDeleteLineage(owner.scope, lineageId, 'nango', { signal });
            if (!result.ok) return false;
        }
        return true;
    } catch (error) {
        logger.error('Nango', `Failed to soft-delete the lineage of ${fileId}`, error);
        return false;
    }
}

/**
 * Delete every version of the files a source no longer has, inside one tenant. A file is found by its identity
 * (the provider file id of this connection), never by the document id a sync record holds: that id can name another
 * lineage when ingest reported a duplicate of an older, unrelated document. Returns false when a delete failed, so
 * the caller keeps the sync record and the next sync retries.
 */
async function deleteNangoLineages(
    supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
    tenantKey: string,
    connectionId: string,
    fileId: string
): Promise<boolean> {
    try {
        const lineages = await collectNangoLineageIds(supabaseAdmin, tenantKey, connectionId, fileId);
        if (lineages.length === 0) return true;
        const { data: versions, error: versionsError } = await supabaseAdmin
            .from('documents')
            .select('id, version, lineage_id, original_path, processing_state')
            .in('lineage_id', lineages)
            .eq('tenant_key', tenantKey)
            .eq('source', 'nango');
        if (versionsError) throw versionsError;
        const versionRows = (versions ?? []) as DocumentObjectRow[];
        const versionIds = versionRows.map((version) => version.id);

        if (versionIds.length > 0) {
            const { error: chunksError } = await supabaseAdmin.from('document_chunks').delete().in('document_id', versionIds);
            if (chunksError) throw chunksError;
        }
        const { error: documentsError } = await supabaseAdmin
            .from('documents')
            .delete()
            .in('lineage_id', lineages)
            .eq('tenant_key', tenantKey)
            .eq('source', 'nango');
        if (documentsError) throw documentsError;
        // Best effort and after the rows: the originals and parse files of the removed versions leave the private bucket.
        await removeDocumentObjects({ tenantKey, rows: versionRows });
        return true;
    } catch (error) {
        logger.error('Nango', `Failed to delete the lineage of ${fileId}`, error);
        return false;
    }
}

/**
 * Delete documents that no longer exist in the source (Google Drive)
 * This handles the case where files are deleted from Google Drive
 * and we need to clean up our database to stay in sync.
 */
async function deleteOrphanedDocuments(
    connectionId: string,
    userId: string,
    currentFileIds: Set<string>,
    supabaseAdmin: ReturnType<typeof getSupabaseAdmin>
): Promise<number> {
    if (!supabaseAdmin) {
        throw new Error('Supabase admin client not available');
    }

    let deletedCount = 0;

    // Unified: lineages are removed inside the tenant of the connection owner only. An owner that cannot be a tenant
    // deletes nothing.
    let tenantKey: string | null = null;
    if (nangoPipeline() === 'unified') {
        const owner = nangoOwnerScope({ ownerUserId: userId });
        if (!owner.ok) {
            logger.error('Nango', `Orphan deletion skipped: owner scope refused (${owner.reason})`);
            return 0;
        }
        tenantKey = scopeKey(owner.scope);
    }

    try {
        // Get all previously synced files for this connection
        const { data: syncRecords, error: fetchError } = await supabaseAdmin
            .from('nango_sync_records')
            .select('id, file_id, file_name, document_id')
            .eq('connection_id', connectionId)
            .eq('user_id', userId)
            .in('status', ['completed', 'processing']); // Only consider successfully synced or in-progress files

        if (fetchError) {
            logger.error('Nango', 'Failed to fetch sync records for deletion check', fetchError);
            throw fetchError;
        }

        if (!syncRecords || syncRecords.length === 0) {
            logger.debug('Nango', 'No existing sync records found - nothing to delete');
            return 0;
        }

        // Find orphaned records (files that exist in our DB but not in Google Drive anymore)
        const orphanedRecords = syncRecords.filter((record: { file_id: string }) => !currentFileIds.has(record.file_id));

        if (orphanedRecords.length === 0) {
            logger.debug('Nango', 'No orphaned documents found - all synced files still exist in source');
            return 0;
        }

        logger.info('Nango', `Found ${orphanedRecords.length} orphaned documents to delete`);

        // Process deletions in batches to avoid timeouts
        for (let i = 0; i < orphanedRecords.length; i += DELETION_BATCH_SIZE) {
            const batch = orphanedRecords.slice(i, i + DELETION_BATCH_SIZE);

            for (const record of batch) {
                try {
                    if (tenantKey !== null) {
                        const removed = orphanUsesSoftDelete()
                            ? await softDeleteNangoLineages(supabaseAdmin, tenantKey, connectionId, record.file_id, userId)
                            : await deleteNangoLineages(supabaseAdmin, tenantKey, connectionId, record.file_id);
                        if (!removed) {
                            continue;
                        }
                    } else if (record.document_id) {
                        // Delete the document if it exists (CASCADE will handle chunks)
                        const { error: docDeleteError } = await supabaseAdmin
                            .from('documents')
                            .delete()
                            .eq('id', record.document_id)
                            .eq('user_id', userId) // Safety: ensure user owns the document
                            .eq('source', 'nango'); // Safety: only delete Nango-sourced documents

                        if (docDeleteError) {
                            logger.error('Nango', `Failed to delete document ${record.document_id}`, docDeleteError);
                            // Continue with other deletions even if one fails
                        } else {
                            logger.debug('Nango', `Deleted document: ${record.file_name} (${record.document_id})`);
                        }
                    }

                    // Delete the sync record
                    const { error: syncDeleteError } = await supabaseAdmin
                        .from('nango_sync_records')
                        .delete()
                        .eq('id', record.id)
                        .eq('user_id', userId); // Safety: ensure user owns the record

                    if (syncDeleteError) {
                        logger.error('Nango', `Failed to delete sync record ${record.id}`, syncDeleteError);
                    } else {
                        deletedCount++;
                        logger.debug('Nango', `Deleted sync record for: ${record.file_name}`);
                    }

                } catch (recordError) {
                    logger.error('Nango', `Error deleting orphaned record ${record.file_name}`, recordError);
                    // Continue with other deletions
                }
            }
        }

        logger.info('Nango', `Successfully deleted ${deletedCount} orphaned documents`);
        return deletedCount;

    } catch (error) {
        logger.error('Nango', 'Error during orphaned document deletion', error);
        // Don't throw - return what we managed to delete
        return deletedCount;
    }
}

/**
 * Sync documents from Google Drive using proxy API
 */
async function syncGoogleDriveDocuments(
    connectionId: string,
    userId: string,
    supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
    folderId?: string | null,
    skipOrphanDeletion: boolean = false
): Promise<SyncStats & { fileIds?: string[]; listingComplete?: boolean }> {
    const stats: SyncStats & { fileIds?: string[]; listingComplete?: boolean } = { processed: 0, failed: 0, skipped: 0, deleted: 0 };

    if (!supabaseAdmin) {
        throw new Error('Supabase admin client not available');
    }

    // Require folder selection for Google Drive
    if (!folderId) {
        throw new Error('No folder selected. Please select a folder to sync from in the Connectors tab.');
    }

    try {
        // Fetch files from the selected Google Drive folder
        const listing = await fetchGoogleDriveFiles(connectionId, folderId);
        stats.listingComplete = listing.complete;
        logger.debug('Nango', `Found ${listing.files.length} files in Google Drive folder ${folderId}`);

        // Deletion detection sees every listed file; the files that are synced stay the first page, as before pagination.
        const files = listing.files.slice(0, MAX_FILES_PER_SYNC);

        // Build set of current file IDs for deletion detection
        const currentFileIds = new Set(listing.files.map(f => f.id));

        // Delete documents that no longer exist in Google Drive
        // This handles the case where user deleted files from Google Drive
        // Skip if called from multi-folder mode (will be done once at the end)
        if (!skipOrphanDeletion) {
            if (listing.complete) {
                stats.deleted = await deleteOrphanedDocuments(
                    connectionId,
                    userId,
                    currentFileIds,
                    supabaseAdmin
                );
            } else {
                logger.error('Nango', `Orphan deletion skipped: the listing of folder ${folderId} is incomplete`);
            }
        } else {
            // Return file IDs for multi-folder mode to aggregate
            stats.fileIds = listing.files.map(f => f.id);
        }

        // Filter to supported file types
        const supportedFiles = files.filter(file =>
            isSupportedGoogleDriveFile(file.mimeType, file.name)
        );
        logger.debug('Nango', `${supportedFiles.length} files are supported types`);

        for (const file of supportedFiles) {
            try {
                // Check if already synced and not modified
                const { data: existing } = await supabaseAdmin
                    .from('nango_sync_records')
                    .select('id, last_synced_at, metadata, document_id')
                    .eq('user_id', userId)
                    .eq('file_id', file.id)
                    .single();

                logger.debug('Nango', `File ${file.name}: existing=${existing?.id ? 'yes' : 'no'}, last_synced=${existing?.last_synced_at || 'never'}, modifiedTime=${file.modifiedTime || 'unknown'}, document_id=${existing?.document_id || 'none'}`);

                if (existing?.last_synced_at && file.modifiedTime) {
                    // Check if the document still exists before skipping
                    let documentExists = false;
                    if (existing.document_id) {
                        const { data: doc } = await supabaseAdmin
                            .from('documents')
                            .select('id')
                            .eq('id', existing.document_id)
                            .single();
                        documentExists = !!doc;
                    }

                    const lastSync = new Date(existing.last_synced_at);
                    const fileModified = new Date(file.modifiedTime);

                    if (fileModified <= lastSync && documentExists) {
                        logger.debug('Nango', `Skipping ${file.name}: not modified since last sync and document exists`);
                        stats.skipped++;
                        continue;
                    } else if (!documentExists && existing.document_id) {
                        logger.debug('Nango', `Re-syncing ${file.name}: document was deleted`);
                    }
                }

                // Create/update sync record as processing
                await supabaseAdmin.from('nango_sync_records').upsert({
                    user_id: userId,
                    connection_id: connectionId,
                    provider: 'google-drive',
                    file_id: file.id,
                    file_name: file.name,
                    status: 'processing',
                    metadata: {
                        mime_type: file.mimeType,
                        size: file.size ? parseInt(file.size) : undefined,
                        modified_at: file.modifiedTime,
                        web_url: file.webViewLink,
                    },
                    updated_at: new Date().toISOString(),
                }, {
                    onConflict: 'user_id,file_id',
                });

                // Convert to NangoFileRecord format for file fetcher
                const fileRecord: NangoFileRecord = {
                    id: file.id,
                    name: file.name,
                    mime_type: file.mimeType,
                    size: file.size ? parseInt(file.size) : undefined,
                    modified_at: file.modifiedTime,
                    web_url: file.webViewLink,
                };

                // Download file content via Nango proxy
                const fileBuffer = await fetchFileContent(
                    'google-drive',
                    connectionId,
                    fileRecord
                );

                // Process through existing RAG pipeline with source metadata
                const documentId = await processDocumentWithMetadata(file.name, fileBuffer, {
                    userId,
                    source: 'nango',
                    sourceProvider: 'google-drive',
                    sourceFileId: file.id,
                    sourceConnectionId: connectionId,
                    nangoConnectionId: connectionId,
                    nangoFolderId: folderId ?? undefined,
                    mimeType: file.mimeType,
                });

                // Update sync record as completed
                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        document_id: documentId,
                        status: 'completed',
                        last_synced_at: new Date().toISOString(),
                        error_message: null,
                    })
                    .eq('user_id', userId)
                    .eq('file_id', file.id);

                stats.processed++;
                logger.debug('Nango', `Processed: ${file.name}`);

            } catch (fileError) {
                logger.error('Nango', `Failed to process: ${file.name}`, fileError);

                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        status: 'failed',
                        error_message: fileError instanceof Error ? fileError.message : 'Unknown error',
                    })
                    .eq('user_id', userId)
                    .eq('file_id', file.id);

                stats.failed++;
            }
        }

        return stats;
    } catch (error) {
        logger.error('Nango', 'Google Drive sync failed', error);
        throw error;
    }
}

/**
 * Sync specific Google Drive files by their IDs
 */
async function syncGoogleDriveFilesByIds(
    connectionId: string,
    userId: string,
    supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
    fileIds: string[]
): Promise<SyncStats> {
    const stats: SyncStats = { processed: 0, failed: 0, skipped: 0, deleted: 0 };

    if (!supabaseAdmin) {
        throw new Error('Supabase admin client not available');
    }

    try {
        logger.debug('Nango', `Syncing ${fileIds.length} specific files from Google Drive`);

        // Fetch each file's metadata
        const nango = getNango();
        const files: GoogleDriveFile[] = [];

        for (const fileId of fileIds) {
            try {
                const response = await nango.proxy({
                    providerConfigKey: 'google-drive',
                    connectionId: connectionId,
                    method: 'GET',
                    endpoint: `/drive/v3/files/${fileId}`,
                    params: {
                        fields: 'id,name,mimeType,modifiedTime,size,parents,webViewLink',
                    },
                });

                files.push(response.data as GoogleDriveFile);
            } catch (error) {
                logger.error('Nango', `Failed to fetch file ${fileId}`, error);
                stats.failed++;
            }
        }

        logger.debug('Nango', `Successfully fetched ${files.length} file metadata records`);

        // Filter to supported file types
        const supportedFiles = files.filter(file =>
            isSupportedGoogleDriveFile(file.mimeType, file.name)
        );
        logger.debug('Nango', `${supportedFiles.length} files are supported types`);

        for (const file of supportedFiles) {
            try {
                // Check if already synced and not modified
                const { data: existing } = await supabaseAdmin
                    .from('nango_sync_records')
                    .select('id, last_synced_at, metadata')
                    .eq('user_id', userId)
                    .eq('file_id', file.id)
                    .single();

                if (existing?.last_synced_at && file.modifiedTime) {
                    const lastSync = new Date(existing.last_synced_at);
                    const fileModified = new Date(file.modifiedTime);
                    if (fileModified <= lastSync) {
                        stats.skipped++;
                        continue;
                    }
                }

                // Create/update sync record as processing
                await supabaseAdmin.from('nango_sync_records').upsert({
                    user_id: userId,
                    connection_id: connectionId,
                    provider: 'google-drive',
                    file_id: file.id,
                    file_name: file.name,
                    status: 'processing',
                    metadata: {
                        mime_type: file.mimeType,
                        size: file.size ? parseInt(file.size) : undefined,
                        modified_at: file.modifiedTime,
                        web_url: file.webViewLink,
                    },
                    updated_at: new Date().toISOString(),
                }, {
                    onConflict: 'user_id,file_id',
                });

                // Convert to NangoFileRecord format for file fetcher
                const fileRecord: NangoFileRecord = {
                    id: file.id,
                    name: file.name,
                    mime_type: file.mimeType,
                    size: file.size ? parseInt(file.size) : undefined,
                    modified_at: file.modifiedTime,
                    web_url: file.webViewLink,
                };

                // Download file content via Nango proxy
                const fileBuffer = await fetchFileContent(
                    'google-drive',
                    connectionId,
                    fileRecord
                );

                // Process through existing RAG pipeline with source metadata
                const documentId = await processDocumentWithMetadata(file.name, fileBuffer, {
                    userId,
                    source: 'nango',
                    sourceProvider: 'google-drive',
                    sourceFileId: file.id,
                    sourceConnectionId: connectionId,
                    nangoConnectionId: connectionId,
                    nangoFolderId: file.parents?.[0],
                    mimeType: file.mimeType,
                });

                // Update sync record as completed
                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        document_id: documentId,
                        status: 'completed',
                        last_synced_at: new Date().toISOString(),
                        error_message: null,
                    })
                    .eq('user_id', userId)
                    .eq('file_id', file.id);

                stats.processed++;
                logger.debug('Nango', `Processed: ${file.name}`);

            } catch (fileError) {
                logger.error('Nango', `Failed to process: ${file.name}`, fileError);

                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        status: 'failed',
                        error_message: fileError instanceof Error ? fileError.message : 'Unknown error',
                    })
                    .eq('user_id', userId)
                    .eq('file_id', file.id);

                stats.failed++;
            }
        }

        return stats;
    } catch (error) {
        logger.error('Nango', 'Google Drive file sync failed', error);
        throw error;
    }
}

/**
 * Sync specific Notion pages by their IDs (subpage mode)
 */
async function syncNotionPagesByIds(
    connectionId: string,
    userId: string,
    supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
    pageIds: string[],
    folderId?: string
): Promise<SyncStats> {
    const stats: SyncStats = { processed: 0, failed: 0, skipped: 0, deleted: 0 };

    if (!supabaseAdmin) {
        throw new Error('Supabase admin client not available');
    }

    const nango = getNango();

    try {
        logger.debug('Nango', `Syncing ${pageIds.length} specific Notion pages`);

        for (const pageId of pageIds) {
            try {
                // Fetch page metadata from Notion
                const pageResponse = await nango.proxy({
                    providerConfigKey: 'notion',
                    connectionId: connectionId,
                    method: 'GET',
                    endpoint: `/v1/pages/${pageId}`,
                });

                const page = pageResponse.data as any;
                const pageName = page.properties?.title?.title?.[0]?.plain_text ||
                    page.properties?.Name?.title?.[0]?.plain_text ||
                    'Untitled';
                const modifiedAt = page.last_edited_time;

                // Check if already synced and not modified
                const { data: existing } = await supabaseAdmin
                    .from('nango_sync_records')
                    .select('id, last_synced_at, document_id, metadata')
                    .eq('user_id', userId)
                    .eq('file_id', pageId)
                    .single();

                if (existing?.last_synced_at && modifiedAt && existing?.document_id) {
                    // Verify the document still exists
                    const { data: docExists } = await supabaseAdmin
                        .from('documents')
                        .select('id')
                        .eq('id', existing.document_id)
                        .single();

                    if (docExists) {
                        const lastSync = new Date(existing.last_synced_at);
                        const pageModified = new Date(modifiedAt);
                        if (pageModified <= lastSync) {
                            stats.skipped++;
                            logger.debug('Nango', `Skipping unchanged page: ${pageName}`);
                            continue;
                        }
                    } else {
                        logger.debug('Nango', `Document was deleted, re-syncing page: ${pageName}`);
                    }
                }

                // Create/update sync record as processing
                await supabaseAdmin.from('nango_sync_records').upsert({
                    user_id: userId,
                    connection_id: connectionId,
                    provider: 'notion',
                    file_id: pageId,
                    file_name: pageName,
                    status: 'processing',
                    metadata: {
                        modified_at: modifiedAt,
                        web_url: page.url,
                    },
                    updated_at: new Date().toISOString(),
                }, {
                    onConflict: 'user_id,file_id',
                });

                // Fetch page content via file-fetcher
                const fileRecord: NangoFileRecord = {
                    id: pageId,
                    name: pageName,
                    mime_type: 'text/plain',
                    web_url: page.url,
                    modified_at: modifiedAt,
                };

                const fileBuffer = await fetchFileContent('notion', connectionId, fileRecord);

                // Process through RAG pipeline
                const documentId = await processDocumentWithMetadata(pageName, fileBuffer, {
                    userId,
                    source: 'nango',
                    sourceProvider: 'notion',
                    sourceFileId: pageId,
                    sourceConnectionId: connectionId,
                    nangoConnectionId: connectionId,
                    nangoFolderId: folderId,
                    mimeType: fileRecord.mime_type,
                });

                // Update sync record as completed
                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        document_id: documentId,
                        status: 'completed',
                        last_synced_at: new Date().toISOString(),
                        error_message: null,
                    })
                    .eq('user_id', userId)
                    .eq('file_id', pageId);

                stats.processed++;
                logger.debug('Nango', `Processed Notion page: ${pageName}`);

            } catch (pageError) {
                logger.error('Nango', `Failed to process Notion page ${pageId}`, pageError);

                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        status: 'failed',
                        error_message: pageError instanceof Error ? pageError.message : 'Unknown error',
                    })
                    .eq('user_id', userId)
                    .eq('file_id', pageId);

                stats.failed++;
            }
        }

        logger.debug('Nango', `Notion sync complete: ${stats.processed} processed, ${stats.failed} failed, ${stats.skipped} skipped`);
        return stats;

    } catch (error) {
        logger.error('Nango', 'Notion page sync failed', error);
        throw error;
    }
}

/**
 * Sync a Notion page and all its children (top-level mode)
 */
async function syncNotionPageWithChildren(
    connectionId: string,
    userId: string,
    supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
    parentPageId: string
): Promise<SyncStats> {
    const stats: SyncStats = { processed: 0, failed: 0, skipped: 0, deleted: 0 };

    if (!supabaseAdmin) {
        throw new Error('Supabase admin client not available');
    }

    const nango = getNango();

    try {
        logger.debug('Nango', `Syncing Notion page ${parentPageId} with children`);

        // Collect all page IDs to sync (parent + children)
        const pageIds: string[] = [parentPageId];

        // Recursively fetch child page IDs
        const childPages = await fetchNotionChildPages(nango, connectionId, parentPageId, 'Parent', 0);
        pageIds.push(...childPages.map(p => p.id));

        logger.debug('Nango', `Found ${pageIds.length} total pages to sync (1 parent + ${childPages.length} children)`);

        // Use syncNotionPagesByIds for actual syncing
        const syncResult = await syncNotionPagesByIds(connectionId, userId, supabaseAdmin, pageIds, parentPageId);

        return syncResult;

    } catch (error) {
        logger.error('Nango', 'Notion page with children sync failed', error);
        throw error;
    }
}

/**
 * Fetch files from a provider using the appropriate method
 * Some providers have configured syncs, others require direct API access
 */
async function fetchFilesForProvider(
    nango: ReturnType<typeof getNango>,
    provider: string,
    connectionId: string,
    folderId: string
): Promise<NangoFileRecord[]> {
    try {
        // Try to use Nango's listRecords first (for providers with configured syncs)
        if (provider === 'google-drive') {
            return await listGoogleDriveFilesViaProxy(nango, connectionId, folderId);
        } else if (provider === 'dropbox') {
            return await listDropboxFilesViaProxy(nango, connectionId, folderId);
        } else if (provider === 'notion') {
            return await listNotionPages(nango, connectionId);
        } else {
            // Try default listRecords for unknown providers
            const providerConfig = PROVIDER_CONFIG[provider as SupportedProvider];
            const fileModel = providerConfig?.fileModel || 'files';
            try {
                const filesResponse = await nango.listRecords<NangoFileRecord>({
                    providerConfigKey: provider,
                    connectionId: connectionId,
                    model: fileModel,
                    limit: MAX_FILES_PER_SYNC,
                });
                return filesResponse.records || [];
            } catch (e) {
                logger.warn('Nango', `Could not list records for ${provider}, returning empty list`, e);
                return [];
            }
        }
    } catch (error) {
        logger.error('Nango', `Failed to fetch files for ${provider}`, error);
        throw error;
    }
}

/**
 * List Google Drive files via Nango proxy API
 */
async function listGoogleDriveFilesViaProxy(
    nango: ReturnType<typeof getNango>,
    connectionId: string,
    folderId: string
): Promise<NangoFileRecord[]> {
    const query = folderId === 'root'
        ? "mimeType != 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents"
        : `mimeType != 'application/vnd.google-apps.folder' and trashed = false and '${folderId}' in parents`;

    const response = await nango.proxy({
        providerConfigKey: 'google-drive',
        connectionId,
        method: 'GET',
        endpoint: '/drive/v3/files',
        params: {
            q: query,
            pageSize: '100',
            fields: 'files(id,name,mimeType,size,modifiedTime)',
        },
    });

    const data = response.data as { files?: any[] };
    const files = data.files || [];

    return files.map(file => ({
        id: file.id,
        name: file.name,
        path: file.name,
        mime_type: file.mimeType,
        size: file.size ? parseInt(file.size) : undefined,
        modified_at: file.modifiedTime,
    })) as NangoFileRecord[];
}

/**
 * List Dropbox files via Nango proxy API
 */
async function listDropboxFilesViaProxy(
    nango: ReturnType<typeof getNango>,
    connectionId: string,
    folderId: string
): Promise<NangoFileRecord[]> {
    const path = folderId === 'root' ? '' : folderId;

    const response = await nango.proxy({
        providerConfigKey: 'dropbox',
        connectionId,
        method: 'POST',
        endpoint: '/2/files/list_folder',
        data: {
            path,
            limit: MAX_FILES_PER_SYNC,
        },
    });

    const data = response.data as { entries?: any[] };
    const entries = data.entries || [];

    // Filter to files only (not folders)
    const files = entries.filter(entry => entry['.tag'] === 'file');

    return files.map(file => {
        // Ensure path starts with '/' as required by Dropbox API
        let filePath = file.path_display || file.path_lower || file.name;
        if (!filePath.startsWith('/')) {
            filePath = `/${filePath}`;
        }

        return {
            id: file.id,
            name: file.name,
            path: filePath,
            mime_type: getMimeTypeFromFilename(file.name),
            size: file.size,
            modified_at: file.client_modified,
        };
    }) as NangoFileRecord[];
}

/**
 * List Notion pages and databases via Nango listRecords
 */
async function listNotionPages(
    nango: ReturnType<typeof getNango>,
    connectionId: string
): Promise<NangoFileRecord[]> {
    try {
        logger.debug('Nango', `Attempting to list Notion pages for connection: ${connectionId}`);

        // Use Nango proxy to fetch pages directly from Notion API
        const response = await nango.proxy({
            providerConfigKey: 'notion',
            connectionId: connectionId,
            method: 'POST',
            endpoint: '/v1/search',
            data: {
                page_size: MAX_FILES_PER_SYNC,
                sort: {
                    direction: 'descending',
                    timestamp: 'last_edited_time',
                },
                filter: {
                    value: 'page',
                    property: 'object',
                },
            },
        });

        logger.debug('Nango', `Notion search response: ${JSON.stringify(response.data).substring(0, 500)}`);

        const data = response.data as { results?: any[] };
        const results = data.results || [];

        if (!results || !Array.isArray(results)) {
            logger.warn('Nango', 'No pages returned from Notion search');
            return [];
        }

        logger.info('Nango', `Found ${results.length} Notion pages`);

        // Map Notion pages to NangoFileRecord format
        const pages = results.map(page => ({
            id: page.id,
            name: page.properties?.title?.title?.[0]?.plain_text ||
                page.properties?.Name?.title?.[0]?.plain_text ||
                page.properties?.Name?.rich_text?.[0]?.plain_text ||
                'Untitled',
            mime_type: 'text/plain',
            web_url: page.url,
            modified_at: page.last_edited_time,
        })) as NangoFileRecord[];

        // Recursively fetch child pages for each parent page
        const allPages: NangoFileRecord[] = [...pages];

        for (const page of pages) {
            try {
                const childPages = await fetchNotionChildPages(nango, connectionId, page.id, page.name);
                allPages.push(...childPages);
            } catch (childError) {
                logger.warn('Nango', `Failed to fetch children for page ${page.id}`, childError);
            }
        }

        logger.info('Nango', `Total pages including children: ${allPages.length}`);
        return allPages;
    } catch (error) {
        const axiosError = error as any;
        logger.error('Nango', 'Failed to list Notion pages - Status:', axiosError?.status);
        logger.error('Nango', 'Failed to list Notion pages - Error:', error);
        return [];
    }
}

/**
 * Recursively fetch child pages from a Notion page
 */
async function fetchNotionChildPages(
    nango: ReturnType<typeof getNango>,
    connectionId: string,
    parentPageId: string,
    parentPageName: string,
    depth: number = 0
): Promise<NangoFileRecord[]> {
    // Limit recursion depth to prevent infinite loops
    const MAX_DEPTH = 5;
    if (depth >= MAX_DEPTH) {
        logger.debug('Nango', `Max recursion depth reached for page ${parentPageId}`);
        return [];
    }

    try {
        // Use proxy to fetch child pages via Notion API
        const response = await nango.proxy({
            providerConfigKey: 'notion',
            connectionId: connectionId,
            method: 'GET',
            endpoint: `/v1/blocks/${parentPageId}/children`,
            params: {
                page_size: MAX_FILES_PER_SYNC.toString(),
            },
        });

        const data = response.data as { results?: any[] };
        const blocks = data.results || [];

        // Filter for child page blocks
        const childPages: NangoFileRecord[] = [];

        for (const block of blocks) {
            if (block.type === 'child_page') {
                const childPage: NangoFileRecord = {
                    id: block.id,
                    name: block.child_page?.title || 'Untitled',
                    mime_type: 'text/plain',
                    web_url: undefined,
                    modified_at: block.last_edited_time,
                };
                childPages.push(childPage);

                // Recursively fetch grandchildren
                const grandchildren = await fetchNotionChildPages(
                    nango,
                    connectionId,
                    block.id,
                    childPage.name,
                    depth + 1
                );
                childPages.push(...grandchildren);
            }
        }

        if (childPages.length > 0) {
            logger.debug('Nango', `Found ${childPages.length} child pages under "${parentPageName}"`);
        }

        return childPages;
    } catch (error) {
        logger.warn('Nango', `Failed to fetch child pages for ${parentPageId}`, error);
        return [];
    }
}

/**
 * Helper to guess MIME type from filename extension
 */
function getMimeTypeFromFilename(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt: 'text/plain',
        md: 'text/markdown',
        html: 'text/html',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
}

/**
 * Sync documents from a Nango connection into the RAG pipeline
 */
export async function syncDocumentsForConnection(
    connectionId: string,
    provider: string
): Promise<SyncStats> {
    const nango = getNango();
    const supabaseAdmin = getSupabaseAdmin();

    if (!supabaseAdmin) {
        throw new Error('Supabase admin client not available');
    }

    const stats: SyncStats = { processed: 0, failed: 0, skipped: 0, deleted: 0 };

    try {
        // Get the user_id and sync settings from the connection record
        // connection_id is unique, so this is the one row that binds the connection to its owner. The owner is read here and
        // nowhere else: not from the webhook body, the request or Nango metadata. A missing row or a failed lookup stops the sync.
        const { data: connRecord, error: connError } = await supabaseAdmin
            .from('nango_connections')
            .select('user_id, sync_folder_id, sync_folder_name, sync_file_ids, sync_file_names')
            .eq('connection_id', connectionId)
            .single();

        if (connError || !connRecord || typeof connRecord.user_id !== 'string' || connRecord.user_id === '') {
            throw new Error(`Connection not found: ${connectionId}`);
        }

        const userId = connRecord.user_id;
        if (nangoPipeline() === 'unified') {
            const owner = nangoOwnerScope({ ownerUserId: userId });
            if (!owner.ok) {
                throw new Error(`Connection owner cannot be a tenant (${owner.reason}): ${connectionId}`);
            }
        }
        const folderId = connRecord.sync_folder_id;
        const fileIds = connRecord.sync_file_ids;

        // Enhanced debug logging to trace the issue
        logger.debug('Nango', `Connection record: folderId="${folderId}", fileIds=${JSON.stringify(fileIds)}`);
        logger.debug('Nango', `Starting sync for ${provider}, connection: ${connectionId}, folder: ${folderId || 'none'}, files: ${fileIds?.length || 0}`);

        // Use provider-specific sync strategies
        if (provider === 'google-drive') {
            // Check for multi-folder mode (marker + folder IDs in fileIds)
            if (folderId === 'multi-folder-mode' && fileIds && fileIds.length > 0) {
                // Multi-folder mode: sync files from each folder
                logger.debug('Nango', `Syncing ${fileIds.length} Google Drive folders`);
                const combinedStats: SyncStats = { processed: 0, failed: 0, skipped: 0, deleted: 0 };
                const allFileIds: string[] = [];
                let listingsComplete = true;

                for (const folderIdItem of fileIds) {
                    try {
                        // Skip orphan deletion for individual folders - we'll do it once at the end
                        const folderStats = await syncGoogleDriveDocuments(connectionId, userId, supabaseAdmin, folderIdItem, true);
                        combinedStats.processed += folderStats.processed;
                        combinedStats.failed += folderStats.failed;
                        combinedStats.skipped += folderStats.skipped;
                        // Collect file IDs from this folder
                        if (folderStats.fileIds) {
                            allFileIds.push(...folderStats.fileIds);
                        }
                        if (folderStats.listingComplete === false) listingsComplete = false;
                    } catch (folderError) {
                        logger.error('Nango', `Failed to sync Google Drive folder ${folderIdItem}`, folderError);
                        combinedStats.failed++;
                        listingsComplete = false;
                    }
                }

                // Now do orphan deletion once with ALL file IDs from ALL folders, and only when every folder was listed to the end:
                // the files of a folder that failed or was cut short are not in the set and would be deleted as orphans.
                if (listingsComplete) {
                    const allFileIdsSet = new Set(allFileIds);
                    combinedStats.deleted = await deleteOrphanedDocuments(connectionId, userId, allFileIdsSet, supabaseAdmin);
                } else {
                    logger.error('Nango', 'Orphan deletion skipped: a Google Drive folder listing was incomplete');
                }

                logger.debug('Nango', `Multi-folder Google Drive sync complete: ${combinedStats.processed} processed, ${combinedStats.failed} failed, ${combinedStats.skipped} skipped`);
                return combinedStats;
            }

            // Legacy: If file IDs are specified (not folder IDs), sync those specific files
            if (fileIds && fileIds.length > 0 && folderId !== 'multi-folder-mode') {
                return await syncGoogleDriveFilesByIds(connectionId, userId, supabaseAdmin, fileIds);
            }

            // Single folder mode (backwards compatibility)
            return await syncGoogleDriveDocuments(connectionId, userId, supabaseAdmin, folderId);
        }

        // Notion-specific sync
        if (provider === 'notion') {
            // Check for multi-page top-level mode (marker + file IDs)
            if (folderId === 'top-level-mode' && fileIds && fileIds.length > 0) {
                // Multi-page top-level mode: sync each page with its children
                logger.debug('Nango', `Syncing ${fileIds.length} top-level Notion pages with children`);
                const combinedStats: SyncStats = { processed: 0, failed: 0, skipped: 0, deleted: 0 };

                for (const pageId of fileIds) {
                    try {
                        const pageStats = await syncNotionPageWithChildren(connectionId, userId, supabaseAdmin, pageId);
                        combinedStats.processed += pageStats.processed;
                        combinedStats.failed += pageStats.failed;
                        combinedStats.skipped += pageStats.skipped;
                        combinedStats.deleted += pageStats.deleted;
                    } catch (pageError) {
                        logger.error('Nango', `Failed to sync top-level page ${pageId}`, pageError);
                        combinedStats.failed++;
                    }
                }

                logger.debug('Nango', `Multi-page Notion sync complete: ${combinedStats.processed} processed, ${combinedStats.failed} failed, ${combinedStats.skipped} skipped`);
                return combinedStats;
            }

            // Regular subpage mode: sync specific pages without their children
            if (fileIds && fileIds.length > 0) {
                return await syncNotionPagesByIds(connectionId, userId, supabaseAdmin, fileIds);
            }

            // Legacy single top-level page mode (for backwards compatibility)
            if (folderId) {
                return await syncNotionPageWithChildren(connectionId, userId, supabaseAdmin, folderId);
            }

            // No selection - return empty stats
            logger.debug('Nango', 'No Notion pages selected for sync');
            return { processed: 0, failed: 0, skipped: 0, deleted: 0 };
        }

        // Default: Use Nango's listRecords for other providers
        const providerConfig = PROVIDER_CONFIG[provider as SupportedProvider];
        const fileModel = providerConfig?.fileModel || 'files';

        // Check for multi-folder mode (Dropbox, OneDrive, etc.)
        if (folderId === 'multi-folder-mode' && fileIds && fileIds.length > 0) {
            logger.debug('Nango', `Syncing ${fileIds.length} folders for ${provider}`);

            // Collect all files from all folders first
            const allFiles: { id: string; name: string; path?: string; mime_type?: string; size?: number; modified_at?: string }[] = [];
            const folderOfFile = new Map<string, string>();
            for (const folderPath of fileIds) {
                try {
                    const files = await fetchFilesForProvider(nango, provider, connectionId, folderPath || 'root');
                    logger.debug('Nango', `Found ${files.length} files in folder ${folderPath}`);
                    for (const listed of files) folderOfFile.set(listed.id, folderPath || 'root');
                    allFiles.push(...files);
                } catch (folderError) {
                    logger.error('Nango', `Failed to fetch files from folder ${folderPath} for ${provider}`, folderError);
                }
            }

            logger.debug('Nango', `Total ${allFiles.length} files from ${fileIds.length} folders for ${provider}`);

            // Now process all files using the same logic as single-folder mode
            // (the code below will handle them)
            // We'll use allFiles instead of fetching again
            const combinedStats: SyncStats = { processed: 0, failed: 0, skipped: 0, deleted: 0 };

            // Build set of current file IDs for deletion detection
            const currentFileIds = new Set(allFiles.map(f => f.id));
            combinedStats.deleted = await deleteOrphanedDocuments(connectionId, userId, currentFileIds, supabaseAdmin);

            // Filter to supported file types
            const supportedFiles = allFiles.filter(file => provider === 'notion' || isSupportedFile(file.name));
            logger.debug('Nango', `${supportedFiles.length} files have supported extensions`);

            // Process each file (reusing the same logic pattern)
            for (const file of supportedFiles) {
                try {
                    const { data: existing } = await supabaseAdmin
                        .from('nango_sync_records')
                        .select('id, last_synced_at, metadata')
                        .eq('user_id', userId)
                        .eq('file_id', file.id)
                        .single();

                    if (existing?.last_synced_at && file.modified_at) {
                        const lastSync = new Date(existing.last_synced_at);
                        const fileModified = new Date(file.modified_at);
                        if (fileModified <= lastSync) {
                            combinedStats.skipped++;
                            continue;
                        }
                    }

                    await supabaseAdmin.from('nango_sync_records').upsert({
                        user_id: userId,
                        connection_id: connectionId,
                        provider: provider,
                        file_id: file.id,
                        file_name: file.name,
                        status: 'processing',
                        metadata: { path: file.path, mime_type: file.mime_type, size: file.size, modified_at: file.modified_at },
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'user_id,file_id' });

                    const fileBuffer = await fetchFileContent(provider, connectionId, file);
                    const documentId = await processDocumentWithMetadata(file.name, fileBuffer, {
                        userId,
                        source: 'nango',
                        sourceProvider: provider,
                        sourceFileId: file.id,
                        sourceConnectionId: connectionId,
                        nangoConnectionId: connectionId,
                        nangoFolderId: folderOfFile.get(file.id),
                        mimeType: file.mime_type,
                    });

                    await supabaseAdmin.from('nango_sync_records').update({
                        document_id: documentId,
                        // The legacy value is not one nango_sync_records.status accepts, so that update never applied; kept
                        // as it was for the legacy pipeline, while the unified pipeline writes the value the table allows.
                        status: nangoPipeline() === 'unified' ? 'completed' : 'synced',
                        last_synced_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    }).eq('user_id', userId).eq('file_id', file.id);

                    combinedStats.processed++;
                } catch (fileError) {
                    logger.error('Nango', `Failed to sync file ${file.name}`, fileError);
                    await supabaseAdmin.from('nango_sync_records').update({
                        status: 'failed',
                        error_message: fileError instanceof Error ? fileError.message : 'Unknown error',
                        updated_at: new Date().toISOString(),
                    }).eq('user_id', userId).eq('file_id', file.id);
                    combinedStats.failed++;
                }
            }

            logger.debug('Nango', `Multi-folder ${provider} sync complete: ${combinedStats.processed} processed, ${combinedStats.failed} failed`);
            return combinedStats;
        }

        // Fetch files - use provider-specific methods instead of listRecords
        // (listRecords requires a configured sync which not all providers have)
        const files = await fetchFilesForProvider(
            nango,
            provider,
            connectionId,
            folderId || 'root'
        );
        logger.debug('Nango', `Found ${files.length} files for ${provider}`);

        // Build set of current file IDs for deletion detection
        const currentFileIds = new Set(files.map(f => f.id));

        // Delete documents that no longer exist in the source
        // This handles the case where user deleted files from Dropbox/OneDrive/etc
        stats.deleted = await deleteOrphanedDocuments(
            connectionId,
            userId,
            currentFileIds,
            supabaseAdmin
        );

        // Filter to supported file types
        // For Notion, all pages are supported (no extension check needed)
        const supportedFiles = files.filter(file =>
            provider === 'notion' || isSupportedFile(file.name)
        );
        logger.debug('Nango', `${supportedFiles.length} files have supported extensions`);

        for (const file of supportedFiles) {
            try {
                // Check if already synced and not modified
                const { data: existing } = await supabaseAdmin
                    .from('nango_sync_records')
                    .select('id, last_synced_at, metadata')
                    .eq('user_id', userId)
                    .eq('file_id', file.id)
                    .single();

                if (existing?.last_synced_at && file.modified_at) {
                    const lastSync = new Date(existing.last_synced_at);
                    const fileModified = new Date(file.modified_at);
                    if (fileModified <= lastSync) {
                        stats.skipped++;
                        continue;
                    }
                }

                // Create/update sync record as processing
                await supabaseAdmin.from('nango_sync_records').upsert({
                    user_id: userId,
                    connection_id: connectionId,
                    provider: provider,
                    file_id: file.id,
                    file_name: file.name,
                    status: 'processing',
                    metadata: {
                        path: file.path,
                        mime_type: file.mime_type,
                        size: file.size,
                        modified_at: file.modified_at,
                    },
                    updated_at: new Date().toISOString(),
                }, {
                    onConflict: 'user_id,file_id',
                });

                // Download file content via Nango proxy
                const fileBuffer = await fetchFileContent(
                    provider,
                    connectionId,
                    file
                );

                // Process through existing RAG pipeline with source metadata
                const documentId = await processDocumentWithMetadata(file.name, fileBuffer, {
                    userId,
                    source: 'nango',
                    sourceProvider: provider,
                    sourceFileId: file.id,
                    sourceConnectionId: connectionId,
                    nangoConnectionId: connectionId,
                    nangoFolderId: folderId || 'root',
                    mimeType: file.mime_type,
                });

                // Update sync record as completed
                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        document_id: documentId,
                        status: 'completed',
                        last_synced_at: new Date().toISOString(),
                        error_message: null,
                    })
                    .eq('user_id', userId)
                    .eq('file_id', file.id);

                stats.processed++;
                logger.debug('Nango', `Processed: ${file.name}`);

            } catch (fileError) {
                logger.error('Nango', `Failed to process: ${file.name}`, fileError);

                await supabaseAdmin
                    .from('nango_sync_records')
                    .update({
                        status: 'failed',
                        error_message: fileError instanceof Error ? fileError.message : 'Unknown error',
                    })
                    .eq('user_id', userId)
                    .eq('file_id', file.id);

                stats.failed++;
            }
        }

        logger.debug('Nango', `Sync complete: ${stats.processed} processed, ${stats.failed} failed, ${stats.skipped} skipped`);
        return stats;

    } catch (error) {
        logger.error('Nango', 'Sync failed', error);
        throw error;
    }
}

/**
 * Trigger a sync for all connections of a user
 */
export async function syncAllUserConnections(userId: string): Promise<SyncStats[]> {
    const supabaseAdmin = getSupabaseAdmin();

    if (!supabaseAdmin) {
        throw new Error('Supabase admin client not available');
    }

    const { data: connections } = await supabaseAdmin
        .from('nango_connections')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'connected');

    const results: SyncStats[] = [];

    for (const conn of connections || []) {
        try {
            const stats = await syncDocumentsForConnection(
                conn.connection_id,
                conn.provider
            );
            results.push(stats);
        } catch (error) {
            logger.error('Nango', `Sync failed for ${conn.provider}`, error);
            results.push({ processed: 0, failed: 1, skipped: 0, deleted: 0 });
        }
    }

    return results;
}
