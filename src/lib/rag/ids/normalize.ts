import { splitAtIdentifiers } from './shapes';

/** Per-call input cap for identifier extraction: tenant patterns run on every chunk and query (T-04.2-14). */
export const MAX_IDENTIFIER_INPUT_CHARS = 32_768;

const IDENTIFIER_SEPARATORS = /[\s\-_./]/gu;

export interface IdentifierEntry {
  /** The matched spelling after NFKC; case and separators kept. */
  raw: string;
  norm: string;
}

/**
 * One normalization for index and query (D-28): NFKC, then lower case, then whitespace and - _ . / removed.
 */
export function normalizeIdentifier(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(IDENTIFIER_SEPARATORS, '');
}

/**
 * Restricted Damerau-Levenshtein (optimal string alignment) over code points. With `max`, returns max + 1
 * as soon as the distance is known to exceed it.
 */
export function damerauLevenshtein(a: string, b: string, max?: number): number {
  const s = Array.from(a);
  const t = Array.from(b);
  const limit = max === undefined ? Number.POSITIVE_INFINITY : Math.max(0, max);
  if (Math.abs(s.length - t.length) > limit) return limit + 1;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const row = new Array<number>(t.length + 1);
    row[0] = i;
    let rowMin = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) value = Math.min(value, prev2[j - 2]! + 1);
      row[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = row;
  }
  const distance = prev[t.length]!;
  return distance > limit ? limit + 1 : distance;
}

/** D-31: at most 1 edit for asked forms of up to 6 code points, at most 2 above; equal forms are not near-misses. */
export function isNearMissIdentifier(askedNorm: string, otherNorm: string): boolean {
  if (askedNorm === '' || askedNorm === otherNorm) return false;
  const limit = Array.from(askedNorm).length <= 6 ? 1 : 2;
  return damerauLevenshtein(askedNorm, otherNorm, limit) <= limit;
}

/** Identifiers of a text (built-in shape plus tenant patterns), de-duplicated by normalized form. */
export function extractIdentifierEntries(text: string, extraPatterns?: readonly RegExp[]): IdentifierEntry[] {
  const input = text.slice(0, MAX_IDENTIFIER_INPUT_CHARS).normalize('NFKC');
  const seen = new Set<string>();
  const out: IdentifierEntry[] = [];
  for (const piece of splitAtIdentifiers(input, extraPatterns)) {
    if (!piece.identifier) continue;
    const norm = normalizeIdentifier(piece.text);
    if (norm === '' || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ raw: piece.text, norm });
  }
  return out;
}
