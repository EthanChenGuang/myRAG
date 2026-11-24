import { describe, expect, it } from 'vitest';
import { LEXICAL_VERSION, lexicalText, lexicalTokens, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';

const FORBIDDEN = /['\\\s]/;

describe('tokenizer v2 (D-07)', () => {
  it('carries lexical version 2', () => {
    expect(LEXICAL_VERSION).toBe(2);
  });

  it('tokenizes model numbers with whole, joined and part forms plus Han', () => {
    const tokens = lexicalTokens('型号XR-2000/A_v2.1的保修期');
    expect(tokens).toContain('xr-2000/a_v2.1');
    expect(tokens).toContain('xr2000av21');
    expect(tokens).toContain('xr');
    expect(tokens).toContain('2000');
    expect(tokens).toContain('a_v2.1');
    expect(tokens).toContain('型号');
    expect(tokens).toContain('保修');
    expect(tokens).toContain('修期');
    expect(tokens).not.toContain('的');
  });

  it('NFKC maps full-width Latin to the same code tokens as ASCII', () => {
    expect(lexicalTokens('ＸＲ－２０００').filter((t) => /xr|2000/.test(t))).toEqual(
      expect.arrayContaining(['xr-2000', 'xr2000', 'xr', '2000']),
    );
    expect(lexicalTokens('ＸＲ－２０００').sort()).toEqual(lexicalTokens('XR-2000').sort());
  });

  it('keeps a USCC-style code whole', () => {
    const tokens = lexicalTokens('统一社会信用代码91310000MA1FL0XX0T');
    expect(tokens).toContain('91310000ma1fl0xx0t');
  });

  it('emits overlapping Han bigrams for names split differently by the segmenter', () => {
    expect(lexicalTokens('请问王小明先生负责什么')).toEqual(
      expect.arrayContaining(['王小', '小明', '请问', '先生', '负责', '什么']),
    );
  });

  it('folds Italian elisions and diacritics', () => {
    expect(lexicalTokens("l'azienda dell'anno perché società")).toEqual(
      expect.arrayContaining(['azienda', 'anno', 'perche', 'societa']),
    );
    expect(lexicalTokens("l'azienda dell'anno perché società")).not.toContain("l'");
    expect(lexicalTokens("Customer's")).not.toContain('s');
    expect(lexicalTokens("Customer's")).toEqual(expect.arrayContaining(['customer']));
  });

  it('query side dedupes and caps at 64 tokens', () => {
    const query = `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')} repeat repeat`;
    const tokens = queryLexicalTokens(query);
    expect(tokens.length).toBeLessThanOrEqual(64);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('returns no query tokens when the question is only stopwords', () => {
    expect(queryLexicalTokens('the and or')).toEqual([]);
    expect(queryLexicalTokens('的 了 在')).toEqual([]);
  });

  it('lexicalText keeps order and duplicates', () => {
    const text = lexicalText(['refund refund'], 'policy policy');
    const parts = text.split(' ');
    expect(parts.filter((p) => p === 'refund').length).toBe(2);
    expect(parts.filter((p) => p === 'policy').length).toBe(2);
  });

  it('rejects forbidden characters and long tokens', () => {
    for (const tokens of [lexicalTokens('a\\b'), lexicalTokens(`a${'x'.repeat(200)}`), lexicalTokens("O'Brien")]) {
      for (const token of tokens) {
        expect(token).not.toMatch(FORBIDDEN);
        expect(token.length).toBeLessThanOrEqual(64);
      }
    }
    const blob = 'A'.repeat(3000);
    for (const token of lexicalTokens(blob)) {
      expect(token.length).toBeLessThanOrEqual(64);
      expect(token).not.toMatch(FORBIDDEN);
    }
  });

  it('pins zh sentences to expected tokens on this runtime', () => {
    const cases: Array<{ text: string; expect: string[] }> = [
      { text: '适用范围', expect: ['适用', '范围'] },
      { text: '请问王小明先生负责什么', expect: ['请问', '王小', '小明', '先生', '负责', '什么'] },
      { text: '保修期多长', expect: ['保修', '修期', '多长'] },
    ];
    for (const { text, expect: wanted } of cases) {
      const got = lexicalTokens(text);
      for (const token of wanted) {
        expect(got, text).toContain(token);
      }
    }
  });
});