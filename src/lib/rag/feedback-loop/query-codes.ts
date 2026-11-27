import { createHash } from 'node:crypto';

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** The value when it is a language code, else null; text is never passed through. */
export function toLanguageCode(value: unknown): string | null {
  return typeof value === 'string' && LANGUAGE_CODE.test(value) ? value : null;
}

function normaliseForFingerprint(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The one query fingerprint: sha256 hex of the NFKC, lower-cased, whitespace-collapsed masked text. */
export function queryFingerprint(masked: string): string {
  return createHash('sha256').update(normaliseForFingerprint(masked)).digest('hex');
}
