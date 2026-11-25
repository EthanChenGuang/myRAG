import { describe, expect, test } from 'vitest';
import { isCitationAware, renderCitationMarkers } from '@/lib/chat/citation-markers';
import { answerQualityStrings } from '@/translations/answer-quality';

const CITATIONS = [
  { n: 1, alias: 'S1' },
  { n: 2, alias: 'S2' },
];

const final = (text: string, citations = CITATIONS) => renderCitationMarkers(text, { citations, phase: 'final' });
const streaming = (text: string, citations = CITATIONS) => renderCitationMarkers(text, { citations, phase: 'streaming' });

describe('isCitationAware', () => {
  test.each([
    [{ citations: [] }, true],
    [{ answerId: '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f' }, true],
    [{ citationStrategy: 'chunk-alias' }, true],
    [{ ragTraceId: 'trace-1' }, false],
    [{ citations: 'no' }, false],
    [undefined, false],
    [null, false],
    ['text', false],
  ])('%j -> %s', (metadata, expected) => {
    expect(isCitationAware(metadata)).toBe(expected);
  });
});

describe('renderCitationMarkers, final phase', () => {
  test('validated markers become numbered chip links, unvalidated ones disappear', () => {
    expect(final('Paris [S1] is big [S2][S9].')).toBe('Paris[1](#cite-S1) is big[2](#cite-S2).');
  });

  test('a marker with several aliases becomes adjacent chips', () => {
    expect(final('Both [S1, S2] agree.')).toBe('Both[1](#cite-S1)[2](#cite-S2) agree.');
  });

  test('full-width forms follow the server grammar', () => {
    expect(final('巴黎很大【S2】。罗马【S1，S2】。')).toBe('巴黎很大[2](#cite-S2)。罗马[1](#cite-S1)[2](#cite-S2)。');
  });

  test('the chip number is the citation n, not the alias number', () => {
    expect(final('x [S7] y [S3]', [{ n: 1, alias: 'S7' }, { n: 2, alias: 'S3' }])).toBe('x[1](#cite-S7) y[2](#cite-S3)');
  });

  test('unknown aliases are dropped from a mixed marker', () => {
    expect(final('a [S9, S2] b')).toBe('a[2](#cite-S2) b');
  });

  test('an unvalidated marker alone is removed with its whitespace tidied', () => {
    expect(final('Rome [S9] is old.')).toBe('Rome is old.');
    expect(final('[S9] Rome.\n[S9] Milan.')).toBe('Rome.\nMilan.');
  });

  test('a removed marker after inline code keeps the space before the next word', () => {
    expect(final('`x` [S9] y')).toBe('`x` y');
  });

  test('with an empty validated list every marker is removed', () => {
    expect(final('a [S1] b [S2].', [])).toBe('a b.');
  });

  test('markers inside fenced code blocks and inline code are untouched', () => {
    const text = 'Use `arr[S1]` here [S1].\n\n```\nconst x = [S2];\n```\n\n~~~\n[S9]\n~~~\nend [S9]';
    expect(final(text)).toBe('Use `arr[S1]` here[1](#cite-S1).\n\n```\nconst x = [S2];\n```\n\n~~~\n[S9]\n~~~\nend');
  });

  test('an unclosed fence protects the rest of the text', () => {
    expect(final('a [S1]\n```\n[S2]')).toBe('a[1](#cite-S1)\n```\n[S2]');
  });

  test('double-backtick inline code is untouched', () => {
    expect(final('``x [S1] ` y`` [S2]')).toBe('``x [S1] ` y``[2](#cite-S2)');
  });

  test('text without markers is returned as is', () => {
    const text = 'No citations [here] or [S] or [S0].';
    expect(final(text)).toBe(text);
  });
});

describe('renderCitationMarkers, streaming phase', () => {
  test('a citation-aware message hides every marker while it streams', () => {
    expect(streaming('Paris [S1] is big [S2][S9].')).toBe('Paris is big.');
  });

  test('a trailing partial marker is hidden while it streams', () => {
    expect(streaming('Paris is big [S1')).toBe('Paris is big');
    expect(streaming('Paris is big 【S')).toBe('Paris is big');
  });

  test('code is untouched while streaming', () => {
    expect(streaming('`[S1]` [S1]')).toBe('`[S1]`');
  });
});

describe('renderCitationMarkers, messages that are not citation-aware', () => {
  test.each(['final', 'streaming'] as const)('the same string comes back in the %s phase', (phase) => {
    const text = 'Paris [S1] is big [S2][S9]. [S3';
    expect(renderCitationMarkers(text, { citations: undefined, phase })).toBe(text);
  });
});

describe('answerQualityStrings', () => {
  test.each(['en', 'zh', 'it'])('%s has every chip and panel string', (language) => {
    const strings = answerQualityStrings(language);
    expect(strings.documentUpdatedOrRemoved.length).toBeGreaterThan(0);
    expect(strings.citationsHeading.length).toBeGreaterThan(0);
    expect(strings.citedLabel.length).toBeGreaterThan(0);
    expect(strings.chipAriaLabel(3)).toContain('3');
    expect(strings.pageLabel(4)).toContain('4');
  });

  test('each language has its own wording', () => {
    const en = answerQualityStrings('en');
    const zh = answerQualityStrings('zh');
    const it = answerQualityStrings('it');
    expect(en.documentUpdatedOrRemoved).toMatch(/updated or removed/i);
    expect(zh.documentUpdatedOrRemoved).toMatch(/[一-鿿]/);
    expect(it.documentUpdatedOrRemoved).toMatch(/aggiornato|rimosso/i);
    expect(new Set([en.citationsHeading, zh.citationsHeading, it.citationsHeading]).size).toBe(3);
  });

  test.each(['fr', 'xx', '', '__proto__', 'constructor'])('%j falls back to English', (language) => {
    expect(answerQualityStrings(language)).toEqual(answerQualityStrings('en'));
    expect(answerQualityStrings(language).chipAriaLabel(2)).toBe(answerQualityStrings('en').chipAriaLabel(2));
  });
});
