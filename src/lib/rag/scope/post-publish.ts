import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import type { PostPublishEvent, PostPublishHook, PostPublishHookOptions } from '../ingest/post-publish';
import { storeScopeForTenantKey } from '../tenant/store-scope';
import { ScopeRebuildError, rebuildScopeCentroids } from './build';

/**
 * D-25: after a unified-pipeline publish, rebuild the tenant's scope centroids for the active embedding profile and drop its cache
 * entry. Registered through registerPostPublishHook only while RAG_SCOPE_GATE is effective; it runs within its own time budget, never
 * fails or delays the publish, and logs one line per failure code with no text. Examples are re-embedded only by the CLI.
 */
export const SCOPE_CENTROIDS_HOOK = 'scope_centroids';
export const SCOPE_CENTROIDS_HOOK_TIMEOUT_MS = 10_000;

const loggedProblems = new Set<string>();

function problem(key: string, message: string): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[Scope Gate] ${message}`);
}

/** RAG_SCOPE_GATE as the pipeline reads it (inert while the query layer is off); false when the config cannot be read. */
export function scopeCentroidsAfterPublishOn(): boolean {
  try {
    return loadRagConfig(getRagDeps().ragEnv()).queryAdditions.effective.scopeGate;
  } catch {
    return false;
  }
}

export async function runScopeCentroidsHook(event: PostPublishEvent, signal: AbortSignal): Promise<void> {
  if (!scopeCentroidsAfterPublishOn()) return;
  let scope;
  try {
    scope = storeScopeForTenantKey(event.tenantKey);
  } catch {
    problem('tenant_key', 'centroid_rebuild_skipped code=malformed_tenant_key');
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([rebuildScopeCentroids(scope, { signal }), aborted]);
  } catch (error) {
    const code = signal.aborted
      ? 'timeout'
      : error instanceof ScopeRebuildError
        ? `${error.code}${error.sqlState ? `:${error.sqlState}` : ''}`
        : 'unknown';
    problem(`rebuild:${code}`, `centroid_rebuild_failed code=${code}`);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

type Register = (name: string, run: PostPublishHook, options?: PostPublishHookOptions) => void;

/** The caller passes registerPostPublishHook (ingest/post-publish.ts), so this module does not import the registry itself. */
export function registerScopeCentroidsHook(registerPostPublishHook: Register): void {
  registerPostPublishHook(SCOPE_CENTROIDS_HOOK, runScopeCentroidsHook, { timeoutMs: SCOPE_CENTROIDS_HOOK_TIMEOUT_MS });
}

export function resetScopeCentroidsHookForTests(): void {
  loggedProblems.clear();
}
