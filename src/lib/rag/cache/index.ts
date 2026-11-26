import { createHash } from 'node:crypto';
import type { RpcClient } from '../backend/supabase-rpc';
import type { SemanticCacheBackend, SemanticCacheConfig } from '../config';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { createPgvectorSemanticCache } from './pgvector';
import { createRedisvlSemanticCache } from './redisvl-http';
import type { CacheCallOptions, CacheHit, CacheQuery, SemanticCache } from './types';
import { SemanticCacheBackendError } from './wire';

export type { CacheHit, CacheQuery, SemanticCache } from './types';

/** D-36: the cache never holds a request longer than this. */
export const SEMANTIC_CACHE_TIMEOUT_MS = 150;
/** Invalidation runs after the response (never on the request path), so it gets a longer, still bounded, deadline. */
export const SEMANTIC_CACHE_INVALIDATE_TIMEOUT_MS = 2000;

type BackendName = Exclude<SemanticCacheBackend, 'off'>;
type Operation = 'check' | 'store' | 'invalidate';

export interface SemanticCacheIo {
  /** The service-role client. */
  adminClient: () => RpcClient | null;
  fetch: typeof fetch;
  sidecarUrl: string;
  sidecarSecret: string;
}

export interface FailOpenOptions {
  timeoutMs?: number;
  invalidateTimeoutMs?: number;
}

const TIMEOUT = Symbol('semantic-cache-timeout');
const ABORTED = Symbol('semantic-cache-aborted');

/** The first 12 hex digits of sha256(tenant key); log lines never carry the key itself. */
export function hashedTenantKey(scope: TenantScope): string {
  try {
    return createHash('sha256').update(scopeKey(scope), 'utf8').digest('hex').slice(0, 12);
  } catch {
    return 'invalid';
  }
}

function reasonOf(failure: unknown): string {
  if (failure === TIMEOUT) return 'timeout';
  if (failure === ABORTED) return 'aborted';
  if (failure instanceof SemanticCacheBackendError) return failure.code ? `${failure.reason}:${failure.code}` : failure.reason;
  if (failure instanceof DOMException && (failure.name === 'AbortError' || failure.name === 'TimeoutError')) return 'aborted';
  if (failure instanceof Error) return failure.name.slice(0, 64);
  return 'unknown';
}

/** One line per failed event: the operation, the backend, a hashed tenant key and a reason. Never the query, answer or message text. */
function logFailure(backend: BackendName, op: Operation, scope: TenantScope, failure: unknown): void {
  console.warn(`[Semantic Cache] ${op} failed, served as ${op === 'check' ? 'a miss' : 'dropped'}`, {
    backend,
    op,
    reason: reasonOf(failure),
    tenant: hashedTenantKey(scope),
  });
}

/**
 * Runs one backend call under the request signal and a deadline. Any error, the deadline or an abort settles with the fallback;
 * a backend promise that settles later is observed so it never becomes an unhandled rejection.
 */
function guarded<T>(
  backend: BackendName,
  op: Operation,
  scope: TenantScope,
  outer: AbortSignal | undefined,
  timeoutMs: number,
  fallback: T,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (outer?.aborted) {
    logFailure(backend, op, scope, ABORTED);
    return Promise.resolve(fallback);
  }
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T, failure?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (failure !== undefined) {
        logFailure(backend, op, scope, failure);
        if (!controller.signal.aborted) controller.abort();
      }
      resolve(value);
    };
    const onAbort = (): void => finish(fallback, controller.signal.aborted ? TIMEOUT : ABORTED);
    const timer = setTimeout(() => {
      if (settled) return;
      controller.abort();
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = run(signal);
    } catch (error) {
      finish(fallback, error);
      return;
    }
    pending.then(
      (value) => finish(value),
      (error: unknown) => finish(fallback, error),
    );
  });
}

/** D-36: wraps a backend so that check misses, store drops and invalidate answers 0 on any error, deadline or abort. */
export function withFailOpen(backend: SemanticCache, name: BackendName, options: FailOpenOptions = {}): SemanticCache {
  const timeoutMs = options.timeoutMs ?? SEMANTIC_CACHE_TIMEOUT_MS;
  const invalidateTimeoutMs = options.invalidateTimeoutMs ?? SEMANTIC_CACHE_INVALIDATE_TIMEOUT_MS;
  return {
    check(q: CacheQuery): Promise<CacheHit | null> {
      return guarded<CacheHit | null>(name, 'check', q.scope, q.signal, timeoutMs, null, (signal) => backend.check({ ...q, signal }));
    },
    store(q, answer): Promise<void> {
      return guarded<void>(name, 'store', q.scope, q.signal, timeoutMs, undefined, (signal) => backend.store({ ...q, signal }, answer));
    },
    invalidateTenant(scope: TenantScope, documentIds?: string[], opts?: CacheCallOptions): Promise<number> {
      return guarded<number>(name, 'invalidate', scope, opts?.signal, invalidateTimeoutMs, 0, (signal) =>
        backend.invalidateTenant(scope, documentIds, { signal }),
      );
    },
  };
}

let warnedUnconfiguredSidecar = false;

/** The unwrapped backend RAG_SEMANTIC_CACHE selects: errors propagate. Null when the cache is off or RedisVL has no sidecar to call. */
export function createSemanticCacheBackend(
  config: SemanticCacheConfig,
  io: SemanticCacheIo,
): { name: BackendName; backend: SemanticCache } | null {
  if (config.backend === 'pgvector') {
    return { name: 'pgvector', backend: createPgvectorSemanticCache({ adminClient: io.adminClient, config }) };
  }
  if (config.backend === 'redisvl') {
    if (!io.sidecarUrl.trim() || !io.sidecarSecret.trim()) {
      if (!warnedUnconfiguredSidecar) {
        warnedUnconfiguredSidecar = true;
        console.warn('[Semantic Cache] RAG_SEMANTIC_CACHE=redisvl needs RAG_SIDECAR_URL and RAG_SIDECAR_SECRET; the cache stays off');
      }
      return null;
    }
    return {
      name: 'redisvl',
      backend: createRedisvlSemanticCache({
        url: io.sidecarUrl,
        secret: io.sidecarSecret,
        fetch: io.fetch,
        adminClient: io.adminClient,
        config,
      }),
    };
  }
  return null;
}

/** The backend RAG_SEMANTIC_CACHE selects, wrapped fail-open; null when the cache is off or RedisVL has no sidecar to call. */
export function getSemanticCache(config: SemanticCacheConfig, io: SemanticCacheIo): SemanticCache | null {
  const created = createSemanticCacheBackend(config, io);
  return created ? withFailOpen(created.backend, created.name) : null;
}
