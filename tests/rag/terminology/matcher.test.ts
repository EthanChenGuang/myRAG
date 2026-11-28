import { describe, expect, it } from 'vitest';
import { normalizeLexical, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { expandMatches, terminologyParams } from '@/lib/rag/terminology/expand';
import { buildMatcher, type RawTermMatch, type TermEntry, type TermKind, type TermMode } from '@/lib/rag/terminology/matcher';

let nextId = 0;
function entry(canonical: string, variants: string[], extra: Partial<TermEntry> = {}): TermEntry {
  nextId += 1;
  return {
    entryId: `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`,
    layer: 'shared',
    canonical,
    variants,
    normalizedVariants: variants.map((variant) => normalizeLexical(variant)),
    language: 'any',
    kind: 'synonym',
    mode: 'one_way',
    sourceLanguage: null,
    targetLanguage: null,
    ...extra,
  };
}

const MIN_HAN = terminologyParams().min_han_chars;

function matchesOf(query: string, entries: TermEntry[]): RawTermMatch[] {
  return buildMatcher(entries, { minHanChars: MIN_HAN }).match(query);
}

function canonicals(query: string, entries: TermEntry[]): string[] {
  return matchesOf(query, entries).map((match) => match.entry.canonical);
}

describe('terminology matcher: Han (D-10)', () => {
  const short = entry('术语甲乙丙', ['术语甲']);
  const long = entry('术语丁戊己', ['新版术语甲']);

  it('takes the longest variant at a position', () => {
    const found = matchesOf('新版术语甲怎么处理', [short, long]);
    expect(found.map((match) => match.entry.entryId)).toEqual([long.entryId]);
    expect(found[0]!.surface).toBe('新版术语甲');
  });

  it('matches the shorter variant on its own', () => {
    expect(canonicals('术语甲', [short, long])).toEqual(['术语甲乙丙']);
  });

  it('ignores a Han variant shorter than min_han_chars', () => {
    const one = entry('术语丁戊己', ['甲']);
    expect(matchesOf('术语甲', [one])).toEqual([]);
  });

  it('matches full-width spellings after NFKC', () => {
    const id = entry('CD-5678-E', ['AB-1234-C'], { kind: 'identifier' });
    expect(canonicals('ＡＢ－１２３４－Ｃ', [id])).toEqual(['CD-5678-E']);
  });
});

describe('terminology matcher: Latin script (D-11)', () => {
  it('matches a two-word variant on token boundaries only', () => {
    const two = entry('term gamma delta', ['alpha beta']);
    expect(canonicals('what about alpha beta today', [two])).toEqual(['term gamma delta']);
    expect(matchesOf('alphabeta', [two])).toEqual([]);
    expect(matchesOf('xalpha betax', [two])).toEqual([]);
  });

  it('strips the possessive suffix the tokenizer strips', () => {
    const one = entry('term alpha beta', ['termalpha']);
    expect(canonicals("termalpha's", [one])).toEqual(['term alpha beta']);
  });

  it('matches across a possessive inside a multi-word variant', () => {
    const two = entry('term gamma delta', ['alpha beta']);
    expect(canonicals("alpha's beta", [two])).toEqual(['term gamma delta']);
  });

  it('matches a variant inside a longer sentence', () => {
    const it1 = entry('termine alfa beta', ['voce alfa']);
    expect(canonicals('dove trovo la voce alfa per favore', [it1])).toEqual(['termine alfa beta']);
  });

  it('matches after an elided article', () => {
    const it1 = entry('termine alfa beta', ['alfa beta']);
    expect(canonicals("l'alfa beta", [it1])).toEqual(['termine alfa beta']);
    expect(canonicals("dell'alfa beta", [it1])).toEqual(['termine alfa beta']);
  });

  it('folds an elided article inside the variant the same way', () => {
    const it1 = entry('termine alfa beta', ["l'alfa beta"]);
    expect(canonicals('alfa beta', [it1])).toEqual(['termine alfa beta']);
  });

  it('is accent-insensitive in both directions', () => {
    const accented = entry('termine alfa beta', ['vocé alfa']);
    const plain = entry('termine alfa beta', ['voce alfa']);
    expect(canonicals('voce alfa', [accented])).toEqual(['termine alfa beta']);
    expect(canonicals('vocé alfa', [plain])).toEqual(['termine alfa beta']);
  });

  it('collapses whitespace and punctuation between words', () => {
    const two = entry('term gamma delta', ['alpha beta']);
    expect(canonicals('alpha   beta', [two])).toEqual(['term gamma delta']);
    expect(canonicals('alpha-beta', [two])).toEqual(['term gamma delta']);
  });
});

describe('terminology matcher: identifiers (D-12)', () => {
  const id = entry('CD-5678-E', ['AB-1234-C'], { kind: 'identifier' });

  it.each(['AB-1234-C', 'AB 1234 C', 'ab-1234-c', 'AB1234C', 'see ab 1234 c please'])('matches %s', (query) => {
    expect(canonicals(query, [id])).toEqual(['CD-5678-E']);
  });

  it('does not match inside a longer identifier', () => {
    expect(matchesOf('AB-1234-C-9', [id])).toEqual([]);
    expect(matchesOf('XAB-1234-C', [id])).toEqual([]);
    expect(matchesOf('AB-12345-C', [id])).toEqual([]);
  });

  it('keeps a Latin entry out of identifier text', () => {
    const latin = entry('term alpha beta', ['ab']);
    expect(canonicals('AB-1234-C', [latin, id])).toEqual(['CD-5678-E']);
    expect(matchesOf('AB-1234-C', [latin])).toEqual([]);
    expect(canonicals('ab termalpha', [latin])).toEqual(['term alpha beta']);
  });

  it('emits identifier forms as expansion', () => {
    const query = 'AB 1234 C';
    const expansion = expandMatches(query, matchesOf(query, [id]), terminologyParams());
    expect(expansion.tokens).toEqual(['cd-5678-e', 'cd5678e']);
  });
});

describe('terminology matcher: mixed scripts and translation pairs', () => {
  it('matches each script with its own rule, in order', () => {
    const id = entry('CD-5678-E', ['AB-1234-C'], { kind: 'identifier' });
    const han = entry('术语甲乙丙', ['术语甲']);
    const latin = entry('term gamma delta', ['alpha beta']);
    const found = matchesOf('AB-1234-C 术语甲 alpha beta', [han, latin, id]);
    expect(found.map((match) => match.entry.entryId)).toEqual([id.entryId, han.entryId, latin.entryId]);
  });

  it('never matches a translation pair', () => {
    const pair = entry('termalpha', ['术语甲乙丙'], {
      kind: 'translation',
      language: 'zh',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
    });
    expect(matchesOf('术语甲乙丙', [pair])).toEqual([]);
    expect(buildMatcher([pair], { minHanChars: MIN_HAN }).size).toBe(0);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HAN_POOL = [...'术语甲乙丙丁戊己新版'];
const WORD_POOL = ['alpha', 'beta', 'gamma', 'delta', 'termalpha', 'term', 'voce', 'alfa', 'vocé', 'termine'];
const ID_POOL = ['AB-1234-C', 'CD-5678-E', 'AB1234C', 'ab 1234 c', 'ＡＢ－１２３４－Ｃ'];
const GLUE = [' ', '  ', "l'", "'s ", ', ', '-', '', '？', ' 的 '];
const KINDS: TermKind[] = ['synonym', 'abbreviation', 'alias', 'identifier', 'translation', 'misspelling'];
const MODES: TermMode[] = ['one_way', 'equivalent'];

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

function term(rand: () => number): string {
  const shape = rand();
  if (shape < 0.35) {
    const length = 1 + Math.floor(rand() * 4);
    return Array.from({ length }, () => pick(rand, HAN_POOL)).join('');
  }
  if (shape < 0.75) {
    const length = 1 + Math.floor(rand() * 3);
    return Array.from({ length }, () => pick(rand, WORD_POOL)).join(' ');
  }
  return pick(rand, ID_POOL);
}

describe('terminology matcher: properties over generated dictionaries', () => {
  it('holds the matching invariants for 2,000 seeded cases', () => {
    const rand = mulberry32(0x0411_0006);
    const params = terminologyParams();
    for (let round = 0; round < 2000; round += 1) {
      const entries = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => {
        const kind = pick(rand, KINDS);
        const variants = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => term(rand));
        return entry(term(rand), variants, { kind, mode: pick(rand, MODES) });
      });
      const parts = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => (rand() < 0.5 ? term(rand) : pick(rand, GLUE)));
      const query = parts.join(pick(rand, GLUE));
      const normalized = normalizeLexical(query);
      const context = { round, query, entries: entries.map((value) => [value.kind, value.mode, value.canonical, value.variants]) };

      let found: RawTermMatch[] = [];
      expect(() => {
        found = buildMatcher(entries, { minHanChars: params.min_han_chars }).match(query);
      }, JSON.stringify(context)).not.toThrow();

      let lastEnd = 0;
      let lastSpan = '';
      for (const match of found) {
        const span = `${match.start}:${match.end}`;
        if (span !== lastSpan) {
          expect(match.start, JSON.stringify(context)).toBeGreaterThanOrEqual(lastEnd);
          lastSpan = span;
        }
        lastEnd = match.end;
        expect(match.end).toBeGreaterThan(match.start);
        expect(normalized.slice(match.start, match.end), JSON.stringify(context)).toBe(match.surface);
        expect(match.entry.kind).not.toBe('translation');
      }

      const original = new Set(queryLexicalTokens(query));
      const expansion = expandMatches(query, found, params);
      for (const token of expansion.tokens) expect(original.has(token), JSON.stringify({ ...context, token })).toBe(false);
    }
  });
});
