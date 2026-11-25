import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { getEmbeddingProfileCompleteness, getEmbeddingProfileStatus } from '@/lib/rag';
import type { ProfileCompleteness } from '@/lib/rag';
import { invalidRequest, jsonNoStore, profileUnavailable } from './_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({ completeness: z.enum(['true', 'false']).default('false') });

function completenessBody(entry: ProfileCompleteness | undefined): Record<string, unknown> {
  if (!entry || entry.state === 'unavailable') return { state: 'unavailable' };
  if (entry.state === 'legacy_column') return { state: 'legacy_column' };
  return { state: 'measured', chunks: entry.chunks, missing: entry.missing, percent: entry.percent };
}

/**
 * Every embedding profile with its status, storage and whether evidence exists; never an evidence body. `?completeness=true` also counts, per
 * vector-table profile, the current ready chunks that already have a vector, which scans the corpus and is left off by default.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  const parsed = QuerySchema.safeParse({ completeness: new URL(request.url).searchParams.get('completeness') ?? undefined });
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  try {
    const status = await getEmbeddingProfileStatus();
    const completeness = parsed.data.completeness === 'true' ? await getEmbeddingProfileCompleteness(status.profiles, request.signal) : null;
    console.log('[Embedding Profile] admin action', { action: 'list', count: status.profiles.length });
    return jsonNoStore({
      success: true,
      switch: status.switch,
      active: status.active.id,
      profiles: status.profiles.map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        model: profile.model,
        dims: profile.dims,
        storage: profile.storage,
        status: profile.status,
        has_evidence: profile.hasEvidence,
        activated_at: profile.activatedAt,
        activated_by: profile.activatedBy,
        previous_active_id: profile.previousActiveId,
        ...(completeness ? { completeness: completenessBody(completeness[profile.id]) } : {}),
      })),
    });
  } catch (error) {
    return profileUnavailable('list', null, error);
  }
}
