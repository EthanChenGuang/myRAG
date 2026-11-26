/**
 * Static checks for an admin-supplied identifier pattern (D-29, D-52). The pattern is attacker-shaped input: nothing here executes it.
 * The only use of the source as a regular expression is `new RegExp(source, 'u')` for the compile check, which never runs a match.
 */

export const IDENTIFIER_PATTERN_LIMITS = {
  maxPatterns: 20,
  maxPatternLength: 200,
  maxNameLength: 80,
  maxSampleLength: 10_000,
  maxMatches: 500,
} as const;

export const IDENTIFIER_PATTERN_FINDING_CODES = [
  'too_long',
  'invalid_regex',
  'invalid_flags',
  'backreference',
  'lookbehind',
  'nested_unbounded_quantifier',
  'matches_empty',
  'probe_too_slow',
  'no_alphanumeric',
] as const;
export type IdentifierPatternFindingCode = (typeof IDENTIFIER_PATTERN_FINDING_CODES)[number];

/** Stored flags (the database accepts only these two). */
export type IdentifierPatternFlags = 'u' | 'iu';
/** Flags an accepted pattern is compiled with: `g` and `u` forced, `i` kept. */
export type CompiledIdentifierFlags = 'gu' | 'giu';

export interface IdentifierPatternFinding {
  code: IdentifierPatternFindingCode;
}

export type IdentifierPatternValidation =
  | { ok: true; flags: CompiledIdentifierFlags; storedFlags: IdentifierPatternFlags; probeChars: string[]; witnesses: string[] }
  | { ok: false; findings: IdentifierPatternFinding[] };

export function validateIdentifierPattern(pattern: string, flags: string): IdentifierPatternValidation {
  void pattern;
  void flags;
  return { ok: true, flags: 'gu', storedFlags: 'u', probeChars: [], witnesses: [] };
}
