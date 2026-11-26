import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { effectiveLexicalVersion, lexicalVersionFor, loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { LEXICAL_VERSION, effectiveLexicalVersion as reexported } from '@/lib/rag';

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  resetRagConfigForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('effective lexical version (D-42)', () => {
  test('LEXICAL_VERSION stays 2', () => {
    expect(LEXICAL_VERSION).toBe(2);
  });

  test.each([
    [{}, 2],
    [{ RAG_LEXICAL_DICTIONARY: 'false', RAG_LEXICAL_STEM_IT: 'false' }, 2],
    [{ RAG_LEXICAL_DICTIONARY: 'true' }, 3],
    [{ RAG_LEXICAL_STEM_IT: 'true' }, 4],
    [{ RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_STEM_IT: 'true' }, 5],
    [{ RAG_LEXICAL_QUANTITY: 'true' }, 6],
    [{ RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_QUANTITY: 'true' }, 7],
    [{ RAG_LEXICAL_STEM_IT: 'true', RAG_LEXICAL_QUANTITY: 'true' }, 8],
    [{ RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_STEM_IT: 'true', RAG_LEXICAL_QUANTITY: 'true' }, 9],
  ])('%o gives version %i', (env, version) => {
    const config = loadRagConfig(env);
    expect(config.v2.lexicalVersion).toBe(version);
    expect(effectiveLexicalVersion(config)).toBe(version);
    expect(reexported(config)).toBe(version);
  });

  test('an invalid switch value counts as off', () => {
    const config = loadRagConfig({ RAG_LEXICAL_DICTIONARY: 'yes', RAG_LEXICAL_STEM_IT: '1' });
    expect(config.v2.lexicalVersion).toBe(2);
  });

  test('lexicalVersionFor with two arguments is unchanged; the quantity bit adds 4', () => {
    expect([lexicalVersionFor(false, false), lexicalVersionFor(true, false), lexicalVersionFor(false, true), lexicalVersionFor(true, true)]).toEqual([2, 3, 4, 5]);
    expect([lexicalVersionFor(false, false, true), lexicalVersionFor(true, true, true)]).toEqual([6, 9]);
  });
});
