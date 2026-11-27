import { describe, expect, it } from 'vitest';
import { measureAnswerStructure } from '@/lib/rag/generation/answer-structure';
import { fixedText } from '@/lib/rag/lang/texts';

const ALIASES = new Set(['S1', 'S2', 'S3']);

describe('measureAnswerStructure (06.2 D-12)', () => {
  it('counts parts and per-part citations in an English answer', () => {
    const answer = [
      'Short overview first [S9].',
      '1. The first part holds the stated value [S1].',
      '2. The second part holds another value [S2, S3].',
      `3. Third part: ${fixedText('labels.not_covered', 'en')}.`,
    ].join('\n');
    expect(measureAnswerStructure({ answer, subQuestionCount: 3, language: 'en', aliases: ALIASES })).toEqual({
      parts: 3,
      cited_parts: 2,
      uncovered_parts: 1,
    });
  });

  it('counts headed parts in a Chinese answer', () => {
    const answer = [
      '## 1、第一部分',
      '第一部分的内容【S1】。',
      '## 2、第二部分',
      `第二部分：${fixedText('labels.not_covered', 'zh')}。`,
    ].join('\n');
    expect(measureAnswerStructure({ answer, subQuestionCount: 2, language: 'zh', aliases: ALIASES })).toEqual({
      parts: 2,
      cited_parts: 1,
      uncovered_parts: 1,
    });
  });

  it('counts bold-numbered parts in an Italian answer and ignores numbers beyond the sub-questions', () => {
    const answer = [
      '**1)** La prima parte riporta il valore indicato [S1].',
      '**2)** La seconda parte riporta un altro valore [S3].',
      '3) Un elenco interno non è una parte.',
    ].join('\n');
    expect(measureAnswerStructure({ answer, subQuestionCount: 2, language: 'it', aliases: ALIASES })).toEqual({
      parts: 2,
      cited_parts: 2,
      uncovered_parts: 0,
    });
  });

  it('records cited_parts as not measured without a labeller', () => {
    const answer = '1. First [S1].\n2. Second.';
    expect(measureAnswerStructure({ answer, subQuestionCount: 2, language: 'en', aliases: null })).toEqual({
      parts: 2,
      cited_parts: null,
      uncovered_parts: 0,
    });
    expect(measureAnswerStructure({ answer, subQuestionCount: 2, language: 'en', aliases: new Set() }).cited_parts).toBeNull();
  });

  it('counts an unknown alias as no citation and an unnumbered answer as zero parts', () => {
    expect(measureAnswerStructure({ answer: '1. First [S7].\n2. Second [S2].', subQuestionCount: 2, language: 'en', aliases: ALIASES }).cited_parts).toBe(1);
    expect(measureAnswerStructure({ answer: 'One paragraph [S1].', subQuestionCount: 2, language: 'en', aliases: ALIASES })).toEqual({
      parts: 0,
      cited_parts: 0,
      uncovered_parts: 0,
    });
  });
});
