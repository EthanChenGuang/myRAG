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

export function legacyQueryTerms(_queryText: unknown): string[] {
  return [];
}

export function legacyKeepReason(
  _candidate: LegacyKeepCandidate,
  _terms: readonly string[],
  _floors?: LegacyKeepFloors,
): Extract<KeptBy, 'similarity' | 'name' | 'image'> | null {
  return null;
}
