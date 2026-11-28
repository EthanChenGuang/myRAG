import { createHash } from 'node:crypto';
import type { RetrievalFilters } from '../backend/types';
import type { ScopeAccessFilter } from '../tenant/access';
import type { CacheKeyParts } from './types';

const KEY_PARTS: readonly (keyof CacheKeyParts)[] = [
  'accessGroupSetHash',
  'answerLanguage',
  'entryProfile',
  'generatorModel',
  'queryFramework',
  'ragMode',
  'retrievalConfigHash',
  'systemPromptHash',
];

function sortKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * D-23, A-05: the access key part of a scope's access filter: the set hash of the caller's effective keys, the constant admin_all for an
 * admin and off while the switch is off. Pure; cacheAccessKeyPart in ./access-key reads the filter from a TenantScope.
 */
export function accessKeyPartOf(filter: ScopeAccessFilter): string {
  if (filter.mode === 'keys') return filter.setHash;
  return filter.mode;
}

/** The request filters that change which chunks can be retrieved, as optional key parts (D-39, D-44). */
export function cacheKeyFilterParts(filters: RetrievalFilters): Pick<CacheKeyParts, 'scopes' | 'scopesIncludeUntagged' | 'effectiveOn'> {
  const scopes = filters.scopes && filters.scopes.length > 0 ? [...new Set(filters.scopes)].sort() : null;
  return {
    ...(scopes ? { scopes } : {}),
    ...(scopes && filters.scopesIncludeUntagged === true ? { scopesIncludeUntagged: true } : {}),
    ...(filters.effectiveOn ? { effectiveOn: filters.effectiveOn } : {}),
  };
}

/**
 * SHA-256 over canonical sorted-key JSON of exactly the key parts; a missing or non-string part throws. The optional filter
 * parts join only when set, so a filter-free key is unchanged; scope tags are sorted, so their order never splits a key.
 */
export function computeCacheKeyHash(parts: CacheKeyParts): string {
  const canonical: Record<string, unknown> = {};
  for (const key of KEY_PARTS) {
    const value = (parts as unknown as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`semantic cache key part ${key} is missing`);
    }
    canonical[key] = value;
  }
  if (parts.effectiveOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parts.effectiveOn)) throw new TypeError('semantic cache key part effectiveOn is malformed');
    canonical.effectiveOn = parts.effectiveOn;
  }
  const scopes = parts.scopes && parts.scopes.length > 0 ? [...new Set(parts.scopes)].sort() : null;
  if (scopes) {
    canonical.scopes = scopes;
    if (parts.scopesIncludeUntagged === true) canonical.scopesIncludeUntagged = true;
  }
  return sha256Hex(JSON.stringify(sortKeys(canonical)));
}

/** Callers pass the template before {{context}} substitution. */
export function hashSystemPromptTemplate(template: string): string {
  return sha256Hex(template);
}

/**
 * 06.2 G2: systemPromptHash with the switch-gated prompt blocks the entry point adds after the template. Each block enters only
 * while present, so with none the caller's hash is returned unchanged.
 */
export function systemPromptHashWithBlocks(systemPromptHash: string, blocks: { decomposedAnswer?: string | null }): string {
  const parts = Object.entries(blocks)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => a.localeCompare(b));
  if (parts.length === 0) return systemPromptHash;
  return sha256Hex([systemPromptHash, ...parts.map(([name, text]) => `${name}:${sha256Hex(text)}`)].join('\u0000'));
}
