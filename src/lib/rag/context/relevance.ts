import type { KeptBy } from '../types';

export interface LegacyKeepFloors {
  text: number;
  image: number;
}

export interface LegacyKeepCandidate {
  similarity: number | null;
  hasImage: boolean;
  filename: string | null | undefined;
  text: string | null | undefined;
}

export type LegacyKeepReason = Extract<KeptBy, 'similarity' | 'name' | 'image'>;

const LEGACY_KEEP_FLOORS: LegacyKeepFloors = { text: 0.65, image: 0.25 };

export function normalizeQueryText(input: unknown): string {
  if (typeof input === 'string') {
    return input.toLowerCase();
  }
  if (Array.isArray(input) && input.length > 0) {
    const textPart = input.find((part) => part.type === 'text');
    return textPart && typeof textPart.text === 'string' ? textPart.text.toLowerCase() : '';
  }
  return '';
}

/** Legacy query terms: words longer than 3 characters, then stripped to [a-z0-9] (a long non-Latin word becomes ''). */
export function legacyQueryTerms(queryText: unknown): string[] {
  return normalizeQueryText(queryText)
    .split(/\s+/)
    .filter((term) => term.length > 3)
    .map((term) => term.replace(/[^a-z0-9]/g, ''));
}

export function legacyKeepReason(
  candidate: LegacyKeepCandidate,
  terms: readonly string[],
  floors: LegacyKeepFloors = LEGACY_KEEP_FLOORS,
): LegacyKeepReason | null {
  const similarity = candidate.similarity;
  const scored = typeof similarity === 'number';
  if (scored && similarity > floors.text) return 'similarity';
  if (terms.length > 0) {
    const name = (candidate.filename ?? '').toLowerCase();
    const text = candidate.text ? candidate.text.toLowerCase() : '';
    if (terms.some((term) => name.includes(term) || (text !== '' && text.includes(term)))) return 'name';
  }
  if (candidate.hasImage && scored && similarity > floors.image) return 'image';
  return null;
}
