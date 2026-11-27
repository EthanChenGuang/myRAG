import type { DeletionOrigin } from './change-feed';

export interface SourceConnectionRow {
    id: string;
    connection_id: string;
    user_id: string;
    provider: string;
    deletion_mode?: string | null;
}

export interface SourceDeletionResult {
    removed: number;
    failed: number;
    deferred: number;
}

export async function applySourceDeletions(
    _connection: SourceConnectionRow,
    _fileIds: readonly string[],
    _origin: DeletionOrigin,
    _options: { admin?: unknown } = {}
): Promise<SourceDeletionResult> {
    return { removed: 0, failed: 0, deferred: 0 };
}
