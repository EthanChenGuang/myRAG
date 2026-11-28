import { logger } from '@/lib/logger';
import { isPurgeTombstoned, nangoOwnerScope } from '@/lib/rag';
import type { SyncStats } from './types';

/** clear: ingest; withdrawn: an admin purged this file (D-35); unknown: the lookup failed, skip for this sync (fail closed). */
export type TombstoneVerdict = 'clear' | 'withdrawn' | 'unknown';

const TOMBSTONE_TIMEOUT_MS = 10_000;

/**
 * The admin-purge tombstone check before a connector file is ingested (D-35). The tenant is the connection owner's
 * (nangoOwnerScope), resolved once per sync; the source key is the provider file id as documents.source_file_id
 * stores it, inside the Nango connection id. Source-sync purges leave no tombstone, so a restored file comes back.
 */
export function purgeTombstoneCheck(userId: string, connectionId: string): (fileId: string) => Promise<TombstoneVerdict> {
    const owner = nangoOwnerScope({ ownerUserId: userId });
    return async (fileId: string) => {
        if (!owner.ok) {
            logger.error('Nango', 'Tombstone check failed: owner scope refused', { connectionId });
            return 'unknown';
        }
        try {
            const answer = await isPurgeTombstoned(owner.scope, connectionId, fileId, { signal: AbortSignal.timeout(TOMBSTONE_TIMEOUT_MS) });
            if (answer.ok) return answer.tombstoned ? 'withdrawn' : 'clear';
            logger.error('Nango', 'Tombstone check failed', { connectionId, reason: answer.reason });
        } catch (error) {
            logger.error('Nango', 'Tombstone check failed', { connectionId, error: error instanceof Error ? error.name : 'unknown' });
        }
        return 'unknown';
    };
}

/** Counts a skipped file: withdrawn files go to `withdrawn`, failed lookups to `skipped`. True when the file must not be ingested. */
export function skipByTombstone(verdict: TombstoneVerdict, stats: SyncStats): boolean {
    if (verdict === 'clear') return false;
    if (verdict === 'withdrawn') stats.withdrawn = (stats.withdrawn ?? 0) + 1;
    else stats.skipped++;
    return true;
}
