import { describe, expect, it } from 'vitest';
import { IDENTIFIER_PATTERN, extractIdentifiers } from '@/lib/rag/ids/shapes';
import { STEM_TOKEN_PREFIX } from '@/lib/rag/lexical/options';
import lexicalRules from '@/lib/rag/lexical/rules.json';
import {
  LEXICAL_VERSION,
  lexicalRegistryRules,
  lexicalStemmerAvailable,
  lexicalText,
  lexicalTokens,
  queryLexicalTokens,
} from '@/lib/rag/lexical/tokenize';

describe('lexical tokenizer (D-32)', () => {
  it('carries its version', () => {
    expect(LEXICAL_VERSION).toBe(2);
  });

  it('keeps a Chinese invoice number whole and segments the words around it', () => {
    const tokens = lexicalTokens('发票号码FP-2025-0042不得转让');
    expect(tokens.filter((t) => t === 'fp-2025-0042')).toHaveLength(1);
    expect(tokens).toEqual(expect.arrayContaining(['发票', '号码', 'fp-2025-0042', '不得', '转让']));
  });

  it('keeps an Italian invoice number verbatim and lowercases the words', () => {
    const tokens = lexicalTokens('Fattura N. FT-2025-00417 del 15/03/2025');
    expect(tokens).toContain('ft-2025-00417');
    expect(tokens).toContain('fattura');
    expect(tokens).not.toContain('Fattura');
  });

  it('folds diacritics in Latin text', () => {
    expect(lexicalTokens('Società Città')).toEqual(['societa', 'citta']);
    expect(lexicalTokens('Città')).toEqual(['citta']);
  });

  it('keeps tax ids and model numbers verbatim', () => {
    const tokens = lexicalTokens('Partita IVA IT99999999990, USCC 91000000MA0000000N, modello XR-500B.');
    expect(tokens).toContain('it99999999990');
    expect(tokens).toContain('91000000ma0000000n');
    expect(tokens).toContain('xr-500b');
  });

  it('applies NFKC before anything else', () => {
    expect(lexicalTokens('ＦＰ－２０２５－００４２')).toEqual(
      expect.arrayContaining(['fp-2025-0042', 'fp20250042']),
    );
  });

  it('splits Latin text on whitespace and punctuation', () => {
    expect(lexicalTokens("Refund within 15 days; l'anno e-mail")).toEqual([
      'refund',
      'within',
      '15',
      'days',
      'anno',
      'mail',
    ]);
  });

  it('puts the path tokens first, then the content tokens, joined by single spaces', () => {
    const path = ['第三章 合同条款', '第5条 适用范围'];
    const content = '本合同适用于 FP-2025-0042';
    const expected = [...lexicalTokens(path[0]!), ...lexicalTokens(path[1]!), ...lexicalTokens(content)].join(' ');
    const text = lexicalText(path, content);
    expect(text).toBe(expected);
    expect(text.startsWith(lexicalTokens(path[0]!).join(' '))).toBe(true);
    expect(text).not.toMatch(/ {2}/);
    expect(text).toContain('fp-2025-0042');
  });

  it('uses only the content tokens when the path is empty', () => {
    expect(lexicalText([], 'Refund Policy')).toBe('refund policy');
    expect(lexicalText([], '')).toBe('');
  });

  it('returns no tokens for empty or punctuation-only text', () => {
    expect(lexicalTokens('')).toEqual([]);
    expect(lexicalTokens('—— ,;:!? ——')).toEqual([]);
  });
});

describe('identifier shapes', () => {
  it('returns identifier tokens in order of appearance and the tokenizer keeps the same ones', () => {
    const text = '发票FP-2025-0042 对应订单 PO_778/9, 税号 IT99999999990.';
    const ids = extractIdentifiers(text);
    expect(ids).toEqual(['FP-2025-0042', 'PO_778/9', 'IT99999999990']);
    const tokens = lexicalTokens(text);
    const lowered = ids.map((id) => id.toLowerCase());
    expect(tokens.filter((t) => lowered.includes(t)).sort()).toEqual(lowered.sort());
  });

  it('requires a digit and drops trailing punctuation', () => {
    expect(extractIdentifiers('Fattura del marzo e-mail well-known')).toEqual([]);
    expect(extractIdentifiers('See FT-1. Then v2.3.1, ok')).toEqual(['FT-1', 'v2.3.1']);
  });

  it('exposes a global pattern that matches an identifier', () => {
    expect('ref FP-2025-0042 end'.match(IDENTIFIER_PATTERN)).toEqual(['FP-2025-0042']);
  });
});

describe('hostile input (T-03-15)', () => {
  const size = 200 * 1024;
  const inputs: Array<[string, string]> = [
    ['letters without digits', 'a'.repeat(size)],
    ['one long digit run', '1'.repeat(size)],
    ['punctuated run without digits', 'a-'.repeat(size / 2)],
    ['identifier-like run with a trailing tail', `${'a.'.repeat(size / 4)}1${'.'.repeat(size / 2)}`],
    ['Chinese text', '合同条款'.repeat(size / 4)],
  ];

  for (const [name, input] of inputs) {
    it(`finishes under one second: ${name}`, () => {
      const started = performance.now();
      extractIdentifiers(input);
      lexicalTokens(input);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }
});

describe('per-token cost (CI timing failure on PR #23)', () => {
  it('does not compile regular expressions per token', () => {
    const Original = globalThis.RegExp;
    let built = 0;
    const Counting = new Proxy(Original, {
      construct(target, args, newTarget) {
        built += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    globalThis.RegExp = Counting;
    try {
      lexicalTokens("l'acqua dell'anno a-b c-d ".repeat(500));
    } finally {
      globalThis.RegExp = Original;
    }
    expect(built).toBeLessThan(50);
  });
});

describe('Italian stem tokens (D-10, D-55)', () => {
  const on = { language: 'it', stemIt: true } as const;
  const stems = (tokens: string[]) => tokens.filter((token) => token.startsWith(STEM_TOKEN_PREFIX));

  it('adds one prefixed stem per Latin word and keeps the surface words', () => {
    const tokens = lexicalTokens('Zorvello verde', on);
    expect(tokens).toEqual(['zorvello', `${STEM_TOKEN_PREFIX}zorvell`, 'verde', `${STEM_TOKEN_PREFIX}verd`]);
    expect(tokens.filter((token) => !token.startsWith(STEM_TOKEN_PREFIX))).toEqual(lexicalTokens('Zorvello verde'));
  });

  it('the singular and plural of one synthetic pair share the stem token', () => {
    expect(stems(lexicalTokens('zorvello', on))).toEqual(stems(lexicalTokens('zorvelli', on)));
    expect(stems(queryLexicalTokens('zorvelli', on))).toEqual([`${STEM_TOKEN_PREFIX}zorvell`]);
  });

  it('the stemmer reads the accent and the emitted stem is folded', () => {
    expect(lexicalTokens('Zorverò', on)).toEqual(['zorvero', `${STEM_TOKEN_PREFIX}zorv`]);
    expect(lexicalTokens('Zorvero', on)).toEqual(['zorvero', `${STEM_TOKEN_PREFIX}zorver`]);
    expect(stems(lexicalTokens('Zorvellità', on)).every((token) => !/\p{M}|[àèìòù]/u.test(token))).toBe(true);
  });

  it('emits no stem token for other languages, no language, or with the switch off', () => {
    for (const options of [
      { language: 'en', stemIt: true },
      { language: 'zh', stemIt: true },
      { language: null, stemIt: true },
      { language: 'it', stemIt: false },
      { language: 'it' },
    ]) {
      expect(stems(lexicalTokens('zorvello verde', options))).toEqual([]);
    }
  });

  it('adds no stem for stopwords, numbers, identifiers or Han text', () => {
    expect(stems(lexicalTokens('della 2025 ZP-1234 规则', on))).toEqual([]);
  });

  it('compiles no regular expression per token with stemming on', () => {
    const Original = globalThis.RegExp;
    let built = 0;
    const Counting = new Proxy(Original, {
      construct(target, args, newTarget) {
        built += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    globalThis.RegExp = Counting;
    try {
      lexicalTokens("l'acqua dell'anno zorvelli verdi ".repeat(500), on);
    } finally {
      globalThis.RegExp = Original;
    }
    expect(built).toBeLessThan(50);
  });
});

describe('per-language rules read from the language registry (D-11)', () => {
  it('equal the constants the tokenizer used before', () => {
    const rules = lexicalRegistryRules();
    expect(rules.stopwords).toEqual(
      new Set([...lexicalRules.stopwords.zh, ...lexicalRules.stopwords.en, ...lexicalRules.stopwords.it]),
    );
    expect(rules.hanStopwords).toEqual(new Set(lexicalRules.stopwords.zh));
    expect(rules.elisionPrefixes).toEqual(lexicalRules.elisionPrefixes);
    expect(rules.elisionSuffixes).toEqual(["'s"]);
    expect(rules.foldAccents).toBe(true);
  });

  it('a stemmer is available for it only', () => {
    expect(lexicalStemmerAvailable('it')).toBe(true);
    expect(lexicalStemmerAvailable('en')).toBe(false);
    expect(lexicalStemmerAvailable('zh')).toBe(false);
    expect(lexicalStemmerAvailable('xx')).toBe(false);
  });
});
