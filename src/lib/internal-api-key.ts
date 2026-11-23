import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison; both sides are hashed so the buffers have equal length. */
export function internalApiKeyMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(sha256(provided), sha256(expected));
}
