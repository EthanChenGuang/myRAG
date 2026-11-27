import type { PostPublishEvent } from '../ingest/post-publish';

export const SCOPE_CENTROIDS_HOOK = 'scope_centroids';

export async function runScopeCentroidsHook(_event: PostPublishEvent, _signal: AbortSignal): Promise<void> {}
