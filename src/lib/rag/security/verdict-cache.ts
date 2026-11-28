import { createHash } from 'node:crypto';
import { scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import type { DetectorId, DetectorVerdict } from './detectors';

export interface VerdictCache {
  get(key: string): Readonly<DetectorVerdict> | undefined;
  set(key: string, verdict: DetectorVerdict): void;
  readonly size: number;
  entries(): Array<[string, Readonly<DetectorVerdict>]>;
}

/**
 * The tenant comes first, so identical text in two tenants never shares an entry (no cross-tenant timing oracle).
 * The text is hashed here rather than trusting a stored content hash, and only its digest enters the key.
 */
export function verdictCacheKey(scope: TenantScope, detector: DetectorId, modelVersion: string, text: string): string {
  const tenant = scopeKey(scope);
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  return JSON.stringify([tenant, detector, modelVersion, digest]);
}

function copyVerdict(verdict: DetectorVerdict): Readonly<DetectorVerdict> {
  const copy: DetectorVerdict = { flagged: verdict.flagged === true, at: verdict.at };
  if (typeof verdict.score === 'number') copy.score = verdict.score;
  if (verdict.level !== undefined) copy.level = typeof verdict.level === 'string' ? verdict.level : null;
  return Object.freeze(copy);
}

/** A bounded LRU over Map insertion order: get and set move an entry to the newest position. */
export function createVerdictCache(options: { maxEntries: number }): VerdictCache {
  const { maxEntries } = options;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('[RAG Security] verdict cache maxEntries must be a positive integer');
  }
  const map = new Map<string, Readonly<DetectorVerdict>>();
  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, verdict) {
      map.delete(key);
      map.set(key, copyVerdict(verdict));
      while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    get size() {
      return map.size;
    },
    entries() {
      return [...map.entries()];
    },
  };
}
