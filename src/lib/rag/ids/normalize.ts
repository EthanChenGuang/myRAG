export const MAX_IDENTIFIER_INPUT_CHARS = 32_768;

export interface IdentifierEntry {
  raw: string;
  norm: string;
}

export function normalizeIdentifier(raw: string): string {
  return raw;
}

export function damerauLevenshtein(a: string, b: string, max?: number): number {
  void a;
  void b;
  void max;
  return 0;
}

export function isNearMissIdentifier(askedNorm: string, otherNorm: string): boolean {
  void askedNorm;
  void otherNorm;
  return false;
}

export function extractIdentifierEntries(text: string, extraPatterns?: readonly RegExp[]): IdentifierEntry[] {
  void text;
  void extraPatterns;
  return [];
}
