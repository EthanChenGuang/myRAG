import { describe, expect, test } from 'vitest';
import {
  MAX_CHUNK_IDENTIFIERS,
  MAX_DOCUMENT_IDENTIFIERS,
  MAX_IDENTIFIER_CHARS,
  extractChunkIdentifiers,
  unionIdentifiers,
} from '@/lib/rag/identifiers/extract';
import { normalizeIdentifier } from '@/lib/rag/ids/normalize';

// Identifiers are described by shape only: letters, digits and separators of invented codes.
const SHAPE_A = 'QX-4471-B';
const SHAPE_A_VARIANT = 'qx 4471 b';
const SHAPE_A_WIDE = 'ＱＸ－４４７１－Ｂ';
const SHAPE_B = 'ZK.20.991';

describe('extractChunkIdentifiers (D-28)', () => {
  test('raw and norm arrays have equal length, first-seen order, de-duplicated by normalized form', () => {
    const result = extractChunkIdentifiers(`Vorsa ${SHAPE_A} tolde ${SHAPE_B} minka ${SHAPE_A}.`, []);
    expect(result.raw).toEqual([SHAPE_A, SHAPE_B]);
    expect(result.norm).toEqual([normalizeIdentifier(SHAPE_A), normalizeIdentifier(SHAPE_B)]);
    expect(result.raw.length).toBe(result.norm.length);
  });

  test('two spellings that differ by separators, case or width give one norm', () => {
    const result = extractChunkIdentifiers(`${SHAPE_A} plin ${SHAPE_A_WIDE} rosk QX_4471_b`, []);
    expect(result.norm).toEqual(['qx4471b']);
    expect(result.raw).toEqual([SHAPE_A]);
  });

  test('a text without identifier shapes gives empty arrays (indexed with none)', () => {
    expect(extractChunkIdentifiers('Vorsa minka tolde plin rosk.', [])).toEqual({ raw: [], norm: [], truncated: 0 });
  });

  test('a tenant pattern adds a digit-free shape; without it the shape is not an identifier', () => {
    const text = 'Vorsa KLOMP-RIVA tolde.';
    expect(extractChunkIdentifiers(text, []).norm).toEqual([]);
    const result = extractChunkIdentifiers(text, [/[A-Z]{5}-[A-Z]{4}/gu]);
    expect(result).toMatchObject({ raw: ['KLOMP-RIVA'], norm: ['klompriva'] });
  });

  test('a tenant-pattern match containing whitespace keeps its raw spelling and its normalized form', () => {
    const result = extractChunkIdentifiers('Vorsa LOT 77 AB tolde.', [/LOT \d+ [A-Z]{2}/gu]);
    expect(result.raw).toContain('LOT 77 AB');
    expect(result.norm[result.raw.indexOf('LOT 77 AB')]).toBe('lot77ab');
  });

  test('the number of identifiers per chunk and their length are bounded', () => {
    const many = Array.from({ length: MAX_CHUNK_IDENTIFIERS + 7 }, (_, i) => `QX-${1000 + i}`).join(' ');
    const result = extractChunkIdentifiers(many, []);
    expect(result.norm).toHaveLength(MAX_CHUNK_IDENTIFIERS);
    expect(result.truncated).toBe(7);
    const long = `A${'1'.repeat(MAX_IDENTIFIER_CHARS + 5)}`;
    const skipped = extractChunkIdentifiers(`${long} ${SHAPE_B}`, []);
    expect(skipped.norm).toEqual([normalizeIdentifier(SHAPE_B)]);
    expect(skipped.truncated).toBe(1);
  });
});

describe('unionIdentifiers (D-28)', () => {
  test('the document arrays are de-duplicated by norm in stable order', () => {
    const one = extractChunkIdentifiers(`${SHAPE_A} ${SHAPE_B}`, []);
    const two = extractChunkIdentifiers(`${SHAPE_A_VARIANT} QX-4471-C`, []);
    const union = unionIdentifiers([one, two]);
    expect(union.norm).toEqual(['qx4471b', 'zk20991', 'qx4471c']);
    expect(union.raw).toEqual([SHAPE_A, SHAPE_B, 'QX-4471-C']);
  });

  test('an empty list gives empty arrays; the union is bounded', () => {
    expect(unionIdentifiers([])).toEqual({ raw: [], norm: [], truncated: 0 });
    const parts = Array.from({ length: Math.ceil((MAX_DOCUMENT_IDENTIFIERS + 10) / 100) }, (_, p) => ({
      raw: Array.from({ length: 100 }, (_, i) => `R${p}-${i}`),
      norm: Array.from({ length: 100 }, (_, i) => `r${p}y${i}x`),
      truncated: 0,
    }));
    const union = unionIdentifiers(parts);
    expect(union.norm).toHaveLength(MAX_DOCUMENT_IDENTIFIERS);
    expect(union.truncated).toBe(parts.length * 100 - MAX_DOCUMENT_IDENTIFIERS);
  });
});
