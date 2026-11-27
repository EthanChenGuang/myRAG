import { describe, expect, it } from 'vitest';
import { splitAnswerSentences, type AnswerSentenceUnit } from '@/lib/rag/lang/sentences';

const texts = (units: AnswerSentenceUnit[]) => units.map((unit) => unit.text.trim());

function expectExactOffsets(text: string, units: AnswerSentenceUnit[]): void {
  let cursor = 0;
  units.forEach((unit, index) => {
    expect(unit.index).toBe(index);
    expect(unit.start).toBe(cursor);
    expect(unit.end).toBeGreaterThan(unit.start);
    expect(text.slice(unit.start, unit.end)).toBe(unit.text);
    cursor = unit.end;
  });
  expect(cursor).toBe(text.length);
}

describe('splitAnswerSentences (D-18)', () => {
  it('keeps decimals, versions, e.g. and lowercase continuations together in English', () => {
    const text = 'The value is 3.5 units [S1]. Version v2.1.0 applies! It applies e.g. to item A. See sec. 4 for more.';
    const units = splitAnswerSentences(text, 'en');
    expect(texts(units)).toEqual([
      'The value is 3.5 units [S1].',
      'Version v2.1.0 applies!',
      'It applies e.g. to item A.',
      'See sec. 4 for more.',
    ]);
    expectExactOffsets(text, units);
  });

  it('splits a question from its answer, question first', () => {
    const units = splitAnswerSentences('Is it so? Yes.', 'en');
    expect(texts(units)).toEqual(['Is it so?', 'Yes.']);
  });

  it('merges a piece with fewer than three letters into the next one', () => {
    expect(texts(splitAnswerSentences('Dr. X agreed [S2]. Next one follows.', 'en'))).toEqual(['Dr. X agreed [S2].', 'Next one follows.']);
  });

  it('attaches a marker that follows the end punctuation to the sentence before it', () => {
    expect(texts(splitAnswerSentences('Value is A.[S1] Next is B.', 'en'))).toEqual(['Value is A.[S1]', 'Next is B.']);
    expect(texts(splitAnswerSentences('Value is A. [S1] Next sentence is B.[S2] Third one.', 'en'))).toEqual([
      'Value is A. [S1]',
      'Next sentence is B.[S2]',
      'Third one.',
    ]);
  });

  it('splits Chinese at full-width ends without spaces and keeps markers in every opener form', () => {
    const text = '数值为甲。[S1]下一句是乙。【S2】第三句是丙！［S3］是否如此？';
    const units = splitAnswerSentences(text, 'zh');
    expect(texts(units)).toEqual(['数值为甲。[S1]', '下一句是乙。【S2】', '第三句是丙！［S3］', '是否如此？']);
    expectExactOffsets(text, units);
    expect(texts(splitAnswerSentences('数值为3.5单位[S1]。另见第4条！', 'zh'))).toEqual(['数值为3.5单位[S1]。', '另见第4条！']);
  });

  it('keeps Italian elision, abbreviations and number formats together', () => {
    const text = "Il valore è 3,5 unità [S1]. Vedi l'art. 4 per altro. L'importo è 1.234,56. Va bene?";
    expect(texts(splitAnswerSentences(text, 'it'))).toEqual([
      'Il valore è 3,5 unità [S1].',
      "Vedi l'art. 4 per altro.",
      "L'importo è 1.234,56.",
      'Va bene?',
    ]);
  });

  it('splits a mixed-script paragraph at the end characters of both scripts', () => {
    expect(texts(splitAnswerSentences('The first part is A. 第二部分是乙。The third part is C.', 'en'))).toEqual([
      'The first part is A.',
      '第二部分是乙。',
      'The third part is C.',
    ]);
  });

  it('never splits inside a URL or a quoted span', () => {
    expect(texts(splitAnswerSentences('See https://example.org/a.b?c=d. for detail. Then go on.', 'en'))).toEqual([
      'See https://example.org/a.b?c=d. for detail.',
      'Then go on.',
    ]);
    expect(texts(splitAnswerSentences('The note says "Stop here. Wait now." and ends. Last one.', 'en'))).toEqual([
      'The note says "Stop here. Wait now." and ends.',
      'Last one.',
    ]);
    expect(texts(splitAnswerSentences('Open https://example.org/x. Next one here.', 'en'))).toEqual(['Open https://example.org/x.', 'Next one here.']);
  });

  it('treats a fenced code block, a whole table, a heading and each list item as one unit with its kind', () => {
    const text = [
      '## Heading line',
      '',
      'Intro sentence one. Intro sentence two:',
      '',
      '- First item. Still the first item [S1].',
      '- Second item.',
      '1. Numbered item.',
      '',
      '| Col | Val |',
      '| --- | --- |',
      '| a. b | 1.5 [S2] |',
      '',
      '```',
      'code line. another. ',
      '```',
      '',
      '**Bold label**',
      'Closing sentence.',
    ].join('\n');
    const units = splitAnswerSentences(text, 'en');
    expect(units.map((unit) => [unit.kind, unit.text.trim()])).toEqual([
      ['heading', '## Heading line'],
      ['sentence', 'Intro sentence one.'],
      ['sentence', 'Intro sentence two:'],
      ['list_item', '- First item. Still the first item [S1].'],
      ['list_item', '- Second item.'],
      ['list_item', '1. Numbered item.'],
      ['table', '| Col | Val |\n| --- | --- |\n| a. b | 1.5 [S2] |'],
      ['code', '```\ncode line. another. \n```'],
      ['heading', '**Bold label**'],
      ['sentence', 'Closing sentence.'],
    ]);
    expectExactOffsets(text, units);
  });

  it('gives UTF-16 offsets that slice back to each unit, also outside the Basic Multilingual Plane', () => {
    const text = '𝐀 value 😀 is here [S1]. 第二句有𠀀字。【S2】 Last 🎉 part.';
    const units = splitAnswerSentences(text, 'en');
    expect(texts(units)).toEqual(['𝐀 value 😀 is here [S1].', '第二句有𠀀字。【S2】', 'Last 🎉 part.']);
    expectExactOffsets(text, units);
  });

  it('returns nothing for empty or blank text', () => {
    expect(splitAnswerSentences('', 'en')).toEqual([]);
    expect(splitAnswerSentences('  \n\n ', 'en')).toEqual([]);
  });

  it('splits a 200,000-character answer in under one second (T-05.2-071)', () => {
    const text = 'Plain words go here [S1]. '.repeat(4000) + 'x'.repeat(50000) + ' "open quote ' + '数值。'.repeat(10000);
    expect(text.length).toBeGreaterThan(150000);
    const started = performance.now();
    const units = splitAnswerSentences(text, 'en');
    expect(performance.now() - started).toBeLessThan(1000);
    expectExactOffsets(text, units);
  });

  it('cross-check: the platform segmenter cuts inside a marker where this splitter does not', () => {
    const text = '数值为甲。[S1]下一句是乙。';
    const platform = Array.from(new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(text), (s) => s.segment);
    expect(platform.some((segment) => segment.endsWith('['))).toBe(true);
    expect(texts(splitAnswerSentences(text, 'zh'))).toEqual(['数值为甲。[S1]', '下一句是乙。']);
  });
});
