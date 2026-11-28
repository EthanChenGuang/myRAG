export type SourceSyncFailure = 'not_found' | 'invalid_argument' | 'run_not_pending' | 'confirmation_expired' | 'unavailable';
export type SourceSyncResult<T> = ({ ok: true } & T) | { ok: false; reason: SourceSyncFailure };

export async function confirmReconcileRun(_input: { runId: string; actorUserId: string; signal?: AbortSignal }): Promise<SourceSyncResult<{ runId: string; removed: number; failed: number }>> {
    return { ok: false, reason: 'unavailable' };
}

export async function dismissReconcileRun(_input: { runId: string; actorUserId: string; signal?: AbortSignal }): Promise<SourceSyncResult<{ runId: string; status: string }>> {
    return { ok: false, reason: 'unavailable' };
}

export async function setDeletionMode(_input: { connectionId: string; mode: 'soft' | 'purge' | null; actorUserId: string; signal?: AbortSignal }): Promise<SourceSyncResult<{ connectionId: string; mode: 'soft' | 'purge' | null }>> {
    return { ok: false, reason: 'unavailable' };
}
