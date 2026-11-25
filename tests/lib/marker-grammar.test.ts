import { describe, expect, test } from 'vitest';
import {
  MAX_MARKER_HOLD_CHARS,
  findCitationMarkers,
  neutralizeCitationMarkers,
  stripCitationMarkers,
} from '@/lib/citations/marker-grammar';

const aliasesOf = (text: string) => findCitationMarkers(text).map((m) => m.aliases);

describe('findCitationMarkers', () => {
  test('finds a single marker with its UTF-16 offsets', () => {
    expect(findCitationMarkers('a [S3] b')).toEqual([{ start: 2, end: 6, aliases: ['S3'] }]);
  });

  test.each(['[S3, S5]', '[S3，S5]', '[S3、S5]', '[S3,S5]', '[S3 , S5]'])(
    '%s is one marker with two aliases',
    (marker) => {
      expect(aliasesOf(`x ${marker} y`)).toEqual([['S3', 'S5']]);
    },
  );

  test('adjacent markers are separate markers', () => {
    expect(findCitationMarkers('[S3][S5]')).toEqual([
      { start: 0, end: 4, aliases: ['S3'] },
      { start: 4, end: 8, aliases: ['S5'] },
    ]);
  });

  test.each(['【S3】', '［S3］', '[S3】', '【S3]'])('%s is a marker', (marker) => {
    expect(aliasesOf(`前文${marker}后文`)).toEqual([['S3']]);
  });

  test('multi-digit aliases and offsets after non-BMP text', () => {
    const text = '😀 [S12]';
    expect(findCitationMarkers(text)).toEqual([{ start: 3, end: 8, aliases: ['S12'] }]);
  });

  test.each(['[S0]', '[S03]', '[s3]', '[S 3]', '[S3', '[Source 3]', '[S3 and S5]', '[S3,]', '[ S3]', '[S3a]', '[]', 'S3]'])(
    '%s is not a marker',
    (text) => {
      expect(findCitationMarkers(`a ${text} b`)).toEqual([]);
    },
  );

  test('a marker longer than the hold window is not a marker', () => {
    expect(aliasesOf('[S1, S2, S3, S4]')).toEqual([['S1', 'S2', 'S3', 'S4']]);
    expect(findCitationMarkers('[S1, S2, S3, S4, S5]')).toEqual([]);
  });

  test('a marker inside a stray bracket is still found', () => {
    expect(aliasesOf('[[S2]] and [see [S4]')).toEqual([['S2'], ['S4']]);
  });
});

describe('stripCitationMarkers', () => {
  test('removes markers, collapses the whitespace before them, keeps punctuation', () => {
    expect(stripCitationMarkers('Paris [S1] is big【S2】.')).toBe('Paris is big.');
  });

  test('removes every marker form, valid alias or not', () => {
    expect(stripCitationMarkers('A [S3, S5] B [S3][S5] C ［S9］, D [S2，S4、S6].')).toBe('A B C, D.');
  });

  test('leaves non-markers alone and keeps line structure', () => {
    expect(stripCitationMarkers('See [S 3] and [Source 1].\n[S2] Next line')).toBe(
      'See [S 3] and [Source 1].\nNext line',
    );
  });

  test('returns text without markers unchanged', () => {
    const text = 'nothing to strip [x]';
    expect(stripCitationMarkers(text)).toBe(text);
  });
});

describe('neutralizeCitationMarkers', () => {
  test.each(['The table [S1] says', '见【S12】', 'Both [S1, S2] and [S3][S4]', '［S7］ full width'])(
    'breaks the grammar in %s while keeping visible text',
    (text) => {
      const out = neutralizeCitationMarkers(text);
      expect(findCitationMarkers(out)).toEqual([]);
      expect(out.replace(/​/g, '')).toBe(text);
      const inserted = out.length - text.length;
      const aliasCount = findCitationMarkers(text).reduce((n, m) => n + m.aliases.length, 0);
      expect(inserted).toBe(aliasCount);
      expect(out).toContain('S​');
    },
  );

  test('one zero-width space per alias for a single marker', () => {
    expect(neutralizeCitationMarkers('[S1]')).toBe('[S​1]');
  });

  test('returns the same string when there is no marker', () => {
    const text = 'plain [S 3] text【note】';
    expect(neutralizeCitationMarkers(text)).toBe(text);
  });
});

test('MAX_MARKER_HOLD_CHARS is 16', () => {
  expect(MAX_MARKER_HOLD_CHARS).toBe(16);
});
