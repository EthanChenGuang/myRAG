import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { effectiveLexicalVersion, loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
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
});
