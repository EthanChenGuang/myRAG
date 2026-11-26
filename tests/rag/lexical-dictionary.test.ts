import { describe, expect, it } from 'vitest';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { DICT_TOKEN_PREFIX, STEM_TOKEN_PREFIX, type LexicalOptions } from '@/lib/rag/lexical/options';
import {
  MAX_ADDITIVE_QUERY_TOKENS,
  identifierLexicalLookupForms,
  lexicalText,
  lexicalTokens,
  queryLexicalTokens,
} from '@/lib/rag/lexical/tokenize';

// Synthetic, neutral vocabulary only (D-11): an invented Han term, an invented two-word Latin term.
const HAN_TERM = '星蓝矩';
const LATIN_TERM = 'zento prisma';

/** Stub of the 4.1.1 matcher contract: longest match first, non-overlapping, on normalized text. */
function stubDictionary(terms: string[]): NonNullable<LexicalOptions['dictionary']> {
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  return {
    version: 's1.w1',
    match(normalized: string) {
      const out: Array<{ term: string; start: number }> = [];
      const taken: Array<[number, number]> = [];
      for (const term of sorted) {
        let from = 0;
        for (;;) {
          const at = normalized.indexOf(term, from);
          if (at < 0) break;
          const end = at + term.length;
          if (!taken.some(([s, e]) => at < e && end > s)) {
            taken.push([at, end]);
            out.push({ term, start: at });
          }
          from = at + 1;
        }
      }
      return out.sort((a, b) => a.start - b.start).map(({ term }) => ({ term }));
    },
  };
}

const dictTokens = (tokens: string[]) => tokens.filter((token) => token.startsWith(DICT_TOKEN_PREFIX));

describe('prefixes (T-04.2-13)', () => {
  it('start with an underscore and hold no quote, backslash or whitespace', () => {
    for (const prefix of [DICT_TOKEN_PREFIX, STEM_TOKEN_PREFIX]) {
      expect(prefix.startsWith('_')).toBe(true);
      expect(prefix).not.toMatch(/['\\\s]/u);
    }
    expect(DICT_TOKEN_PREFIX).not.toBe(STEM_TOKEN_PREFIX);
  });
});

describe('dictionary tokens (D-08)', () => {
  const options: LexicalOptions = { dictionary: stubDictionary([HAN_TERM, LATIN_TERM]) };

  it('a three-character Han term adds exactly one prefixed token and keeps every natural token', () => {
    const text = `规则${HAN_TERM}说明`;
    const plain = lexicalTokens(text);
    const withDict = lexicalTokens(text, options);
    expect(dictTokens(withDict)).toEqual([`${DICT_TOKEN_PREFIX}${HAN_TERM}`]);
    expect(withDict.filter((token) => !token.startsWith(DICT_TOKEN_PREFIX))).toEqual(plain);
  });

  it('a two-word Latin term gives one token with the words joined by an underscore', () => {
    const text = 'The Zento Prisma panel';
    const withDict = lexicalTokens(text, options);
    expect(dictTokens(withDict)).toEqual([`${DICT_TOKEN_PREFIX}zento_prisma`]);
    expect(withDict.filter((token) => !token.startsWith(DICT_TOKEN_PREFIX))).toEqual(lexicalTokens(text));
  });

  it('replaces an apostrophe in a term by an underscore', () => {
    const elided = { dictionary: stubDictionary(["l'orvo blu"]) };
    expect(dictTokens(lexicalTokens("Vedi l'orvo blu.", elided))).toEqual([`${DICT_TOKEN_PREFIX}l_orvo_blu`]);
  });

  it('two non-overlapping matches give two tokens', () => {
    expect(dictTokens(lexicalTokens(`${HAN_TERM} and zento prisma`, options))).toEqual([
      `${DICT_TOKEN_PREFIX}${HAN_TERM}`,
      `${DICT_TOKEN_PREFIX}zento_prisma`,
    ]);
  });

  it('emits per occurrence on the chunk side and once on the query side', () => {
    const text = 'zento prisma, then zento prisma again';
    expect(dictTokens(lexicalTokens(text, options))).toHaveLength(2);
    expect(dictTokens(queryLexicalTokens(text, options))).toEqual([`${DICT_TOKEN_PREFIX}zento_prisma`]);
  });

  it('ignores single words and single Han characters: they are natural tokens already', () => {
    const narrow = { dictionary: stubDictionary(['zento', '星']) };
    expect(dictTokens(lexicalTokens('zento 星', narrow))).toEqual([]);
  });

  it('drops a token longer than the token length cap instead of truncating it', () => {
    const long = `${'zentoprisma '.repeat(6)}end`;
    const tokens = lexicalTokens(long, { dictionary: stubDictionary([long]) });
    expect(dictTokens(tokens)).toEqual([]);
  });

  it('lexicalText and chunkLexicalText pass the options through', () => {
    expect(lexicalText(['Zento Prisma'], 'body', options).split(' ')).toContain(`${DICT_TOKEN_PREFIX}zento_prisma`);
    const chunk = chunkLexicalText({ sectionPath: [], content: `说明${HAN_TERM}` }, options);
    expect(chunk.split(' ')).toContain(`${DICT_TOKEN_PREFIX}${HAN_TERM}`);
    expect(chunkLexicalText({ sectionPath: [], content: `说明${HAN_TERM}` })).not.toContain(DICT_TOKEN_PREFIX);
  });

  it('identifier lookup forms never include additive tokens', () => {
    expect(identifierLexicalLookupForms('ZP-1234', options)).toEqual(identifierLexicalLookupForms('ZP-1234'));
  });
});

describe('query order (D-55, T-04.2-15)', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `zq${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`);

  it('a long query keeps its dictionary token within the first 16 entries and at most 64 in total', () => {
    const text = `${filler.join(' ')} zento prisma`;
    expect(queryLexicalTokens(text)).toHaveLength(64);
    expect(queryLexicalTokens(text)).not.toContain('zento');
    const tokens = queryLexicalTokens(text, { dictionary: stubDictionary([LATIN_TERM]) });
    expect(tokens.length).toBeLessThanOrEqual(64);
    expect(tokens.indexOf(`${DICT_TOKEN_PREFIX}zento_prisma`)).toBeGreaterThanOrEqual(0);
    expect(tokens.indexOf(`${DICT_TOKEN_PREFIX}zento_prisma`)).toBeLessThan(16);
  });

  it('caps additive tokens at 16 and fills the rest with natural tokens', () => {
    expect(MAX_ADDITIVE_QUERY_TOKENS).toBe(16);
    const text = `${filler.join(' ')} zento prisma`;
    const tokens = queryLexicalTokens(text, { language: 'it', stemIt: true, dictionary: stubDictionary([LATIN_TERM]) });
    const additive = tokens.filter((token) => token.startsWith('_'));
    expect(additive).toHaveLength(16);
    expect(additive[0]).toBe(`${DICT_TOKEN_PREFIX}zento_prisma`);
    expect(tokens.slice(0, 16)).toEqual(additive);
    expect(tokens).toHaveLength(64);
    expect(tokens.slice(16)).toEqual(queryLexicalTokens(text).slice(0, 48));
  });
});
