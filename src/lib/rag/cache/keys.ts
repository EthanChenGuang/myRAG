import { createHash } from 'node:crypto';
import type { CacheKeyParts } from './types';

const KEY_PARTS: readonly (keyof CacheKeyParts)[] = [
  'answerLanguage',
  'entryProfile',
  'generatorModel',
  'queryFramework',
  'ragMode',
  'retrievalConfigHash',
  'systemPromptHash',
];

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 over canonical sorted-key JSON of exactly the key parts; a missing or non-string part throws. */
export function computeCacheKeyHash(parts: CacheKeyParts): string {
  const canonical: Record<string, string> = {};
  for (const key of KEY_PARTS) {
    const value = (parts as unknown as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`semantic cache key part ${key} is missing`);
    }
    canonical[key] = value;
  }
  return sha256Hex(JSON.stringify(canonical));
}

/** Callers pass the template before {{context}} substitution. */
export function hashSystemPromptTemplate(template: string): string {
  return sha256Hex(template);
}
