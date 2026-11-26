import { describe, expect, test } from 'vitest';
import {
  createMarkerParser,
  parseAnswerMarkers,
  type MarkerParseResult,
} from '@/lib/rag/generation/citations/marker-parser';

const ALIASES = new Set(['S1', 'S2', 'S3', 'S12']);

function feedAll(parts: string[], aliases: ReadonlySet<string> = ALIASES, id = 't0'): MarkerParseResult {
  const parser = createMarkerParser({ aliases });
  for (const part of parts) parser.feed(id, part);
  parser.end(id);
  return parser.finish();
}

describe('createMarkerParser', () => {
  test('validates aliases against the request set', () => {
    const parser = createMarkerParser({ aliases: new Set(['S1', 'S2', 'S3']) });
    parser.feed('t0', 'See [S2] and [S1, S9].');
    expect(parser.finish()).toEqual({ valid: ['S2', 'S1'], invalidCitations: 1, invalidAliases: ['S9'] });
  });

  const SAMPLE = 'x [S12, S3] y【S2】z [S7] end ［S1，S12］';
  const whole = feedAll([SAMPLE]);

  test('one-delta result for the split sample', () => {
    expect(whole).toEqual({ valid: ['S12', 'S3', 'S2', 'S1'], invalidCitations: 1, invalidAliases: ['S7'] });
  });

  test('every two-way split gives the one-delta result', () => {
    for (let k = 0; k <= SAMPLE.length; k++) {
      expect(feedAll([SAMPLE.slice(0, k), SAMPLE.slice(k)]), `split at ${k}`).toEqual(whole);
    }
  });

  test('every three-way split gives the one-delta result', () => {
    for (let i = 0; i <= SAMPLE.length; i++) {
      for (let j = i; j <= SAMPLE.length; j++) {
        const parts = [SAMPLE.slice(0, i), SAMPLE.slice(i, j), SAMPLE.slice(j)];
        expect(feedAll(parts), `split at ${i},${j}`).toEqual(whole);
      }
    }
  });

  test('character-by-character feeding gives the one-delta result', () => {
    expect(feedAll([...SAMPLE])).toEqual(whole);
  });

  test('a repeated valid alias is listed once; a repeated invalid alias counts every time', () => {
    expect(feedAll(['[S3] a [S1] b [S3, S1] c [S9] [S9][S9, S8]'])).toEqual({
      valid: ['S3', 'S1'],
      invalidCitations: 4,
      invalidAliases: ['S9', 'S8'],
    });
  });

  test('an unmatched opener is released after 16 characters and never becomes a marker', () => {
    const text = '[S1, S2, S3, S12, S1] then [S2';
    expect(feedAll([text])).toEqual({ valid: [], invalidCitations: 0, invalidAliases: [], truncatedMarkers: 1 });
    expect(feedAll([...text])).toEqual({ valid: [], invalidCitations: 0, invalidAliases: [], truncatedMarkers: 1 });
    expect(feedAll([...'[S1, S2, S3, S12, S2] [S2]'])).toEqual({ valid: ['S2'], invalidCitations: 0, invalidAliases: [] });
  });

  test('text ids are parsed independently and a marker split across ids is not joined', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    parser.feed('a', 'first [S');
    parser.feed('b', '1] second [S2');
    parser.feed('a', '3]');
    parser.feed('b', ']');
    expect(parser.finish()).toEqual({ valid: ['S3', 'S2'], invalidCitations: 0, invalidAliases: [] });
  });

  test('end(id) flushes a pending opener of that id', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    parser.feed('a', 'tail [S1');
    parser.end('a');
    parser.feed('a', ']');
    expect(parser.finish()).toEqual({ valid: [], invalidCitations: 0, invalidAliases: [], truncatedMarkers: 1 });
  });

  test('finish is idempotent and ignores later input', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    parser.feed('a', '[S1]');
    const first = parser.finish();
    parser.feed('a', '[S2]');
    expect(parser.finish()).toEqual(first);
    expect(first.valid).toEqual(['S1']);
  });

  test('the parser only observes: input deltas are never altered', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    const deltas = ['a [S', '1] b'];
    const copy = [...deltas];
    for (const d of deltas) parser.feed('t', d);
    expect(deltas).toEqual(copy);
    expect(parser.finish().valid).toEqual(['S1']);
  });

  test('neutralized markers in quoted block text are not citations', () => {
    expect(feedAll(['quoted [S​1] text'])).toEqual({ valid: [], invalidCitations: 0, invalidAliases: [] });
  });
});

describe('parseAnswerMarkers', () => {
  test('equals feeding the whole text at once', () => {
    const texts = ['See [S2] and [S1, S9].', 'x [S12, S3] y【S2】z', '[S1, S2, S3, S12, S1] [S3', ''];
    for (const text of texts) {
      expect(parseAnswerMarkers(text, ALIASES)).toEqual(feedAll([text]));
    }
    expect(parseAnswerMarkers('See [S2] and [S1, S9].', ALIASES)).toEqual({
      valid: ['S2', 'S1'],
      invalidCitations: 1,
      invalidAliases: ['S9'],
    });
  });
});

test('random marker-like text gives the same result for random splits', () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pieces = ['[', ']', '【', '】', '［', '］', 'S', '1', '2', '0', ',', '，', '、', ' ', 'x', '\n'];
  for (let round = 0; round < 300; round++) {
    let text = '';
    const len = 5 + rand(60);
    for (let i = 0; i < len; i++) text += pieces[rand(pieces.length)];
    const expected = parseAnswerMarkers(text, ALIASES);
    const parts: string[] = [];
    let rest = text;
    while (rest.length > 0) {
      const cut = 1 + rand(Math.min(rest.length, 8));
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    expect(feedAll(parts), JSON.stringify(parts)).toEqual(expected);
  }
});
