import { describe, expect, test } from 'vitest';
import { IDENTIFIER_PATTERN_LIMITS, validateIdentifierPattern, type IdentifierPatternFindingCode } from '@/lib/rag/identifiers/validate';

function codes(pattern: string, flags = 'u'): IdentifierPatternFindingCode[] {
  const result = validateIdentifierPattern(pattern, flags);
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

describe('validateIdentifierPattern static rules (D-29, D-52)', () => {
  test('an ordinary shape is accepted with g and u forced', () => {
    const result = validateIdentifierPattern('[A-Z]{2}-[0-9]{4}', 'u');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toBe('gu');
      expect(result.storedFlags).toBe('u');
      expect(result.witnesses[0]).toBe('AA-0000');
    }
  });

  test('i is kept when given', () => {
    const result = validateIdentifierPattern('[a-z]{3}[0-9]{3}', 'iu');
    expect(result.ok && result.flags).toBe('giu');
  });

  test.each([
    ['u', true],
    ['iu', true],
    ['', false],
    ['i', false],
    ['gu', false],
    ['ui', false],
    ['mu', false],
    ['yu', false],
    ['su', false],
  ])('flags %j accepted: %s', (flags, accepted) => {
    expect(codes('[A-Z][0-9]{3}', flags).includes('invalid_flags')).toBe(!accepted);
  });

  test('too_long: 200 characters pass, 201 do not', () => {
    const at = `[A-Z]${'9'.repeat(IDENTIFIER_PATTERN_LIMITS.maxPatternLength - 5)}`;
    expect(at).toHaveLength(200);
    expect(codes(at)).toEqual([]);
    expect(codes(`${at}9`)).toContain('too_long');
  });

  test('invalid_regex: a pattern that does not compile with u', () => {
    expect(codes('[A-Z')).toEqual(['invalid_regex']);
    expect(codes('\\-x9')).toEqual(['invalid_regex']);
    expect(codes('(?:ab9')).toEqual(['invalid_regex']);
    expect(codes('[A-Z]\\d+')).toEqual([]);
  });

  test('backreference: numbered and named references are rejected; an escaped zero and digits in a class are not', () => {
    expect(codes('([A-Z])\\1[0-9]')).toContain('backreference');
    expect(codes('(?<p>[A-Z])\\k<p>[0-9]')).toContain('backreference');
    expect(codes('(?<p>[A-Z])[0-9]')).toEqual([]);
    expect(codes('[\\d][0-9]')).toEqual([]);
    expect(codes('X\\0Y')).toEqual([]);
  });

  test('lookbehind: positive and negative lookbehind are rejected; a lookahead is not', () => {
    expect(codes('(?<=Q)[0-9]{3}')).toContain('lookbehind');
    expect(codes('(?<!Q)[0-9]{3}')).toContain('lookbehind');
    expect(codes('[0-9]{3}(?=Q)')).toEqual([]);
    expect(codes('[0-9]{3}(?!Q)')).toEqual([]);
  });

  test('nested_unbounded_quantifier: a repeating group that contains a quantifier is rejected', () => {
    expect(codes('(?:[A-Z]+)+9')).toContain('nested_unbounded_quantifier');
    expect(codes('([0-9]{2}-)*X')).toContain('nested_unbounded_quantifier');
    expect(codes('(?:a?b)*9')).toContain('nested_unbounded_quantifier');
    expect(codes('(?:(?:x[0-9]+)?y){2}')).toContain('nested_unbounded_quantifier');
    expect(codes('(?:[0-9]{2}){3}')).toContain('nested_unbounded_quantifier');
    expect(codes('(?:Q(?=[0-9]+))*9')).toContain('nested_unbounded_quantifier');
  });

  test('nested_unbounded_quantifier: groups without an inner quantifier, and optional groups, are accepted', () => {
    expect(codes('(?:AB|CD)+[0-9]{3}')).toEqual([]);
    expect(codes('[A-Z]{2}(?:-[0-9]{4})?')).toEqual([]);
    expect(codes('(?:[0-9]{2}-)?[0-9]{4}')).toEqual([]);
    expect(codes('[A-Z]+-[0-9]+')).toEqual([]);
  });

  test('matches_empty: patterns that can match the empty string are rejected', () => {
    for (const pattern of ['', '[0-9]*', 'x?', '(?:[0-9]{3})?', '\\b', '^', '(?=[0-9])', 'A|[0-9]*', '(?:)', '[A-Z]{0,3}', 'A?B?']) {
      expect(codes(pattern), pattern).toContain('matches_empty');
    }
    for (const pattern of ['A', '[0-9]+', '\\bQ[0-9]', '(?:A|B)C?', 'A?B', '(?=[0-9])[0-9]{2}']) {
      expect(codes(pattern), pattern).not.toContain('matches_empty');
    }
  });

  test('one code per rule and several findings together', () => {
    expect(codes('([A-Z])?\\1*', 'gu').sort()).toEqual(['backreference', 'invalid_flags', 'matches_empty'].sort());
  });

  test('probe characters and witnesses come from the pattern, never from execution', () => {
    const result = validateIdentifierPattern('(?:QR|ST)[0-9]{2}\\.[^A-Za-z]', 'u');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.probeChars).toEqual(expect.arrayContaining(['Q', 'R', '0', '.']));
      expect(result.witnesses).toEqual(['QR00.0']);
    }
  });
});
