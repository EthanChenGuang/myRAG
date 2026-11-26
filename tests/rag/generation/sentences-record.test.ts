import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { answerTextHash, buildSentenceRecords, isExemptSentence, exemptionTexts } from '@/lib/rag/generation/sentences-record';
import { fixedText } from '@/lib/rag/lang/texts';
import { splitAnswerSentences } from '@/lib/rag/lang/sentences';
import { AnswerSentenceSchema } from '@/lib/rag-eval/contracts.generated';

const ALIASES: ReadonlySet<string> = new Set(['S1', 'S2']);

function records(text: string, options: Partial<Parameters<typeof buildSentenceRecords>[0]> = {}) {
  const out = buildSentenceRecords({ text, part: 0, language: 'en', aliases: ALIASES, ...options });
  for (const record of out) expect(() => AnswerSentenceSchema.parse(record)).not.toThrow();
  return out;
}

const flags = (text: string, options: Partial<Parameters<typeof buildSentenceRecords>[0]> = {}) =>
  records(text, options).map((record) => [text.slice(record.start, record.end).trim(), record.factual, record.cited]);

describe('buildSentenceRecords (D-19, D-23)', () => {
  it('marks a sentence with a valid marker after its end punctuation as factual and cited', () => {
    expect(flags('Value is A.[S1] Next is B.')).toEqual([
      ['Value is A.[S1]', true, true],
      ['Next is B.', true, false],
    ]);
  });

  it('does not count a marker whose alias is not in the AliasMap', () => {
    expect(flags('Value is A [S9]. Value is B [S2].')).toEqual([
      ['Value is A [S9].', true, false],
      ['Value is B [S2].', true, true],
    ]);
  });

  it('exempts headings, questions, colon lead-ins, notices and the not_covered statement', () => {
    const notCovered = fixedText('labels.not_covered', 'en');
    const notice = fixedText('notices.kb_unavailable', 'en');
    const text = `## Overview\n\nWhat is A? A is one thing [S1]. The parts are:\n\nB: ${notCovered}.\n\n${notice}`;
    expect(flags(text)).toEqual([
      ['## Overview', false, false],
      ['What is A?', false, false],
      ['A is one thing [S1].', true, true],
      ['The parts are:', false, false],
      [`B: ${notCovered}.`, false, false],
      ...splitAnswerSentences(notice, 'en').map((unit) => [unit.text.trim(), false, false]),
    ]);
  });

  it('exempts a notice with a placeholder and a label phrase', () => {
    const corrected = fixedText('notices.calc_corrected', 'en', { value: '42' });
    const version = fixedText('labels.version', 'en', { version: '3' });
    expect(flags(`${corrected}\n\n${version}\n\nA plain fact holds.`)).toEqual([
      [corrected, false, false],
      [version, false, false],
      ['A plain fact holds.', true, false],
    ]);
  });

  it('exempts every sentence after a web or general-knowledge label line until the next label line', () => {
    const web = fixedText('labels.from_web', 'en');
    const general = fixedText('labels.general_knowledge', 'en');
    const docs = fixedText('labels.from_documents', 'en');
    const text = [
      `**${docs}**`,
      'A is one thing [S1].',
      '',
      `**${web}**`,
      'The web says C. It also says D.',
      '',
      `**${docs}**`,
      'B is another thing.',
      '',
      `**${general}**`,
      '- Item from memory.',
      '',
      '**Not a label**',
      'Still general knowledge.',
    ].join('\n');
    expect(flags(text)).toEqual([
      [`**${docs}**`, false, false],
      ['A is one thing [S1].', true, true],
      [`**${web}**`, false, false],
      ['The web says C.', false, false],
      ['It also says D.', false, false],
      [`**${docs}**`, false, false],
      ['B is another thing.', true, false],
      [`**${general}**`, false, false],
      ['- Item from memory.', false, false],
      ['**Not a label**', false, false],
      ['Still general knowledge.', false, false],
    ]);
  });

  it('counts a table with one marked row as one cited unit and never counts a code block as factual', () => {
    const text = '| Col | Val |\n| --- | --- |\n| a | 1 [S2] |\n| b | 2 |\n\n```\nvalue = 1 [S1]\n```';
    expect(records(text).map((record) => [record.kind, record.factual, record.cited])).toEqual([
      ['table', true, true],
      ['code', false, true],
    ]);
  });

  it('records the last unit of a truncated answer as truncated and not factual', () => {
    const out = records('First fact holds [S1]. The second one is cut sho', { truncated: true });
    expect(out.map((record) => [record.kind, record.factual])).toEqual([
      ['sentence', true],
      ['truncated', false],
    ]);
  });

  it('on the Claude path cites a sentence that a source range overlaps', () => {
    const text = 'First fact holds. Second fact holds. Third fact holds.';
    const second = text.indexOf('Second');
    expect(flags(text, { aliases: new Set(), sourceRanges: [{ start: second + 2, end: second + 8 }] })).toEqual([
      ['First fact holds.', true, false],
      ['Second fact holds.', true, true],
      ['Third fact holds.', true, false],
    ]);
  });

  it('works in Chinese with full-width markers and the zh labels', () => {
    const web = fixedText('labels.from_web', 'zh');
    const text = `数值为甲。【S1】下一句是乙。\n\n**${web}**\n网络上说丙。`;
    expect(flags(text, { language: 'zh' })).toEqual([
      ['数值为甲。【S1】', true, true],
      ['下一句是乙。', true, false],
      [`**${web}**`, false, false],
      ['网络上说丙。', false, false],
    ]);
  });

  it('carries index, part, offsets and the SHA-256 hex of the part text', () => {
    const text = 'One fact [S1]. 😀 Two facts.';
    const out = records(text, { part: 3 });
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    expect(answerTextHash(text)).toBe(hash);
    expect(out).toEqual([
      { index: 0, part: 3, start: 0, end: 15, kind: 'sentence', text_hash: hash, factual: true, cited: true, support: 'not_checked', scorer: null, reason: null },
      { index: 1, part: 3, start: 15, end: text.length, kind: 'sentence', text_hash: hash, factual: true, cited: false, support: 'not_checked', scorer: null, reason: null },
    ]);
  });

  it('isExemptSentence follows the part context', () => {
    const [unit] = splitAnswerSentences('A plain fact holds.', 'en');
    const texts = exemptionTexts('en');
    expect(isExemptSentence(unit!, { texts, inUnsourcedPart: false })).toBe(false);
    expect(isExemptSentence(unit!, { texts, inUnsourcedPart: true })).toBe(true);
  });

  it('returns no records for an empty answer', () => {
    expect(records('')).toEqual([]);
  });
});
