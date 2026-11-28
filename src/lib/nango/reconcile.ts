import type { ListableConnectionRow } from './sync-manager';
import { getSupabaseAdmin } from '@/lib/supabase';

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface ReconcileConnectionRow extends ListableConnectionRow {
    status?: string | null;
    connected_at?: string | null;
    last_full_reconcile_at?: string | null;
    last_reconcile_status?: string | null;
}

export interface SourceReconcileDeps {
    admin?: SupabaseAdmin;
    listFiles?: (connection: ReconcileConnectionRow) => Promise<{ fileIds: string[]; complete: boolean }>;
}

export interface SourceReconcileOptions {
    deadlineMs: number;
    connectionId?: string;
    signal?: AbortSignal;
    now?: () => number;
    deps?: SourceReconcileDeps;
}

export interface SourceReconcileResult {
    processed: number;
    removed: number;
    paused: number;
    incomplete: number;
    failed: number;
    skipped: number;
    overdue: number;
}

export async function runSourceReconcile(_options: SourceReconcileOptions): Promise<SourceReconcileResult> {
    return { processed: 0, removed: 0, paused: 0, incomplete: 0, failed: 0, skipped: 0, overdue: 0 };
}
