import { get_encoding, type Tiktoken } from 'tiktoken';

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) encoder = get_encoding('cl100k_base');
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Cuts text to at most maxTokens tokens. A cut inside a multi-byte character drops the broken tail.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  const enc = getEncoder();
  const ids = enc.encode(text);
  if (ids.length <= maxTokens) return text;
  const bytes = enc.decode(ids.slice(0, maxTokens));
  return new TextDecoder('utf-8').decode(bytes).replace(/�+$/u, '');
}
