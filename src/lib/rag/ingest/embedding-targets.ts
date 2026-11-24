import {
  LEGACY_PROFILE,
  getActiveProfile,
  getBackfillingProfiles,
  getPreviousActiveProfile,
  isEmbeddingProfilesEnabled,
  type EmbeddingProfile,
} from '../embeddings/active-profile';
import { IngestWriterError, type IngestWriter } from './writer';

export type EmbeddingTargetRole = 'active' | 'backfilling' | 'previous';

export interface EmbeddingTarget {
  profile: EmbeddingProfile;
  role: EmbeddingTargetRole;
  /** The backfill run a missing vector of this target is recorded against; null when there is none to use. */
  runId: string | null;
}

export type BackfillRunLookup = Pick<IngestWriter, 'findBackfillRuns'>;

/**
 * The profiles a new or replaced chunk must be embedded for. Off: the legacy profile alone, with no read. On: the active profile, every
 * backfilling profile, and the profile the active one replaced (so a rollback never meets a profile that lacks recent documents); a retired
 * previous profile is left out. A backfilling profile has a run only while one is running; the previous profile uses its newest run that was
 * not rolled back. A run lookup that fails leaves the runs unknown; a registry that cannot be read throws ProfileUnavailableError.
 */
export async function resolveEmbeddingTargets(writer: BackfillRunLookup): Promise<EmbeddingTarget[]> {
  if (!isEmbeddingProfilesEnabled()) return [{ profile: LEGACY_PROFILE, role: 'active', runId: null }];

  const active = await getActiveProfile();
  const targets: EmbeddingTarget[] = [{ profile: active, role: 'active', runId: null }];
  for (const profile of await getBackfillingProfiles()) {
    if (!targets.some((target) => target.profile.id === profile.id)) targets.push({ profile, role: 'backfilling', runId: null });
  }
  const previous = await getPreviousActiveProfile();
  if (previous && previous.status !== 'retired' && !targets.some((target) => target.profile.id === previous.id)) {
    targets.push({ profile: previous, role: 'previous', runId: null });
  }
  if (targets.length === 1) return targets;

  let runs: Awaited<ReturnType<BackfillRunLookup['findBackfillRuns']>> = [];
  try {
    runs = await writer.findBackfillRuns();
  } catch (error) {
    console.warn('[Embedding Targets] backfill run lookup failed', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof IngestWriterError ? { rpc: error.rpc, code: error.code } : {}),
    });
  }
  return targets.map((target) => {
    if (target.role === 'active') return target;
    const run = runs.find((candidate) => candidate.profileId === target.profile.id);
    const usable = run !== undefined && (target.role === 'backfilling' ? run.status === 'running' : run.status !== 'rolled_back');
    return usable ? { ...target, runId: run.runId } : target;
  });
}
