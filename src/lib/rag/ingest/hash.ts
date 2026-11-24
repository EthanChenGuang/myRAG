export const HASH_NORMALIZATION_VERSION = 0;

export function normalizeForHash(text: string): string {
  return text;
}

export function contentHash(_text: string): string {
  return '';
}

export function fileSha256(_bytes: Uint8Array): string {
  return '';
}
