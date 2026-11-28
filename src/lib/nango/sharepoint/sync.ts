import type { getSupabaseAdmin } from '@/lib/supabase';
import type { ProcessDocumentOptions } from '../document-adapter';
import type { NangoFileRecord, SyncStats } from '../types';
import type { SharePointProvider } from './config';
import type { GraphTransport } from './graph';

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface SharePointSyncHooks {
    markSourceSeen: (admin: SupabaseAdmin, input: { userId: string; connectionId: string; fileId: string; documentId: string | null | undefined; modifiedAt?: string | null; etag?: string | null }) => Promise<void>;
    isSupportedFile: (name: string) => boolean;
    ownerOnlyLabel: (userId: string) => string[];
    processDocument: (name: string, content: Buffer, options: ProcessDocumentOptions) => Promise<string>;
    fetchContent: (provider: SharePointProvider, connectionId: string, file: NangoFileRecord) => Promise<Buffer>;
}

export interface SharePointSyncOptions {
    deadlineMs?: number;
    signal?: AbortSignal;
    transport?: GraphTransport;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SharePointSyncResult extends SyncStats {
    committedDrives: string[];
    paused: boolean;
}

export async function syncSharePointConnection(
    _connectionId: string,
    _admin: SupabaseAdmin,
    _hooks: SharePointSyncHooks,
    _options: SharePointSyncOptions = {},
): Promise<SharePointSyncResult> {
    return { processed: 0, failed: 0, skipped: 0, deleted: 0, failClosed: 0, committedDrives: [], paused: false };
}

export async function listSharePointFiles(
    _connection: unknown,
    _admin: SupabaseAdmin | null,
    _options: SharePointSyncOptions = {},
): Promise<{ fileIds: string[]; complete: boolean }> {
    return { fileIds: [], complete: true };
}
