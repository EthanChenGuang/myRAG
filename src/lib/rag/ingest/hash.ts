import { createHash } from 'node:crypto';

export const HASH_NORMALIZATION_VERSION = 1;

/**
 * The persisted dedup rule: NFKC, CRLF and CR to LF, whitespace runs to one space,
 * spaces around newlines removed, newline runs to one, trimmed, case kept.
 */
export function normalizeForHash(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}

export function fileSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
