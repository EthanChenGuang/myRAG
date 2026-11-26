import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { AnswerSentence } from '@/lib/rag-eval/contracts.generated';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';
import { clientText } from '@/lib/chat/answer-texts';
import {
  MARK_HREF_PREFIX,
  insertSentenceMarks,
  markFromHref,
  markHref,
  planSentenceMarks,
  sentenceMarkKinds,
  verifySentenceRecords,
  verifySentenceRecordsSync,
} from '@/lib/chat/sentence-marks';
import { answerDisplayText } from '@/lib/chat/answer-display-text';
import { renderCitationMarkers } from '@/lib/chat/citation-markers';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function record(text: string, sentence: string, overrides: Partial<AnswerSentence> = {}): AnswerSentence {
  const start = text.indexOf(sentence);
  if (start < 0) throw new Error('sentence not in text');
  return {
    index: 0,
    part: 0,
    start,
    end: start + sentence.length,
    kind: 'sentence',
    text_hash: sha(text),
    factual: true,
    cited: false,
    support: 'not_checked',
    scorer: null,
    reason: null,
    ...overrides,
  };
}

const uncited = (records: AnswerSentence[]) => sentenceMarkKinds(records, []);

describe('clientText', () => {
  test('returns the value of the requested language', () => {
    expect(clientText('notices.uncited', 'it')).toBe(FIXED_TEXTS.it.notices.uncited);
    expect(clientText('notices.not_confirmed', 'zh')).toBe(FIXED_TEXTS.zh.notices.not_confirmed);
  });

  test('an unknown language or a region subtag falls back to en or the base language', () => {
    expect(clientText('notices.uncited', 'xx')).toBe(FIXED_TEXTS.en.notices.uncited);
    expect(clientText('notices.uncited', 'it-IT')).toBe(FIXED_TEXTS.it.notices.uncited);
    expect(clientText('notices.uncited', '__proto__')).toBe(FIXED_TEXTS.en.notices.uncited);
  });

  test('an unknown key is empty', () => {
    expect(clientText('notices.not_a_key', 'en')).toBe('');
  });
});

describe('verifySentenceRecords', () => {
  const text = 'Alpha one is first. Beta two is second.';
  const a = record(text, 'Alpha one is first. ', { index: 0 });
  const b = record(text, 'Beta two is second.', { index: 1 });

  test('keeps the records whose part text hashes to text_hash (crypto.subtle)', async () => {
    expect(await verifySentenceRecords([text], [a, b])).toEqual([a, b]);
  });

  test('a changed text, an unknown part or offsets outside the part verify nothing', async () => {
    expect(await verifySentenceRecords([text + ' Edited.'], [a, b])).toEqual([]);
    expect(await verifySentenceRecords([text], [{ ...a, part: 3 }])).toEqual([]);
    expect(await verifySentenceRecords([text], [{ ...a, end: text.length + 4 }])).toEqual([]);
    expect(await verifySentenceRecords([text], [{ ...a, start: 9, end: 4 }])).toEqual([]);
  });

  test('the sync check is undefined before the hash is known and cached after', async () => {
    const fresh = 'Gamma three is third.';
    const r = record(fresh, fresh);
    expect(verifySentenceRecordsSync([fresh], [r])).toBeUndefined();
    await verifySentenceRecords([fresh], [r]);
    expect(verifySentenceRecordsSync([fresh], [r])).toEqual([r]);
  });

  test('an offset that splits a surrogate pair does not verify', async () => {
    const t = 'Delta 𝟘 four.';
    const r = record(t, t);
    const split = { ...r, end: t.indexOf('𝟘') + 1 };
    expect(await verifySentenceRecords([t], [r, split])).toEqual([r]);
  });
});

describe('insertSentenceMarks', () => {
  test('places a mark after the sentence, its markers and horizontal whitespace, last record first', () => {
    const text = 'Alpha is first [S1]. Beta is second. Gamma is third.';
    const r0 = record(text, 'Alpha is first [S1]. ', { index: 0, cited: true });
    const r1 = record(text, 'Beta is second. ', { index: 1 });
    const r2 = record(text, 'Gamma is third.', { index: 2 });
    const out = insertSentenceMarks(text, [r0, r1, r2], uncited([r0, r1, r2]));
    expect(out).toBe(
      `Alpha is first [S1]. Beta is second.⁠[](${markHref('uncited', 0, 1)}) Gamma is third.⁠[](${markHref('uncited', 0, 2)})`,
    );
  });

  test('a mark follows markers written after the end punctuation and keeps chips before it', () => {
    const text = 'Alpha is first. [S1] Beta.';
    const r0 = { ...record(text, 'Alpha is first.', { index: 0 }), support: 'unsupported' as const };
    const kinds = sentenceMarkKinds([r0], [r0]);
    const out = insertSentenceMarks(text, [r0], kinds);
    expect(out).toBe(
      `Alpha is first. [S1]⁠[](${markHref('uncited', 0, 0)})[](${markHref('unsupported', 0, 0)}) Beta.`,
    );
    const rendered = renderCitationMarkers(out, { citations: [{ n: 1, alias: 'S1' }], phase: 'final' });
    expect(rendered.indexOf('(#cite-S1)')).toBeLessThan(rendered.indexOf(MARK_HREF_PREFIX));
  });

  test('never inserts inside a code span or a fence', () => {
    const text = 'Use `a. b` here.\n\n```\nx = 1. y = 2.\n```\n';
    const span = record(text, 'Use `a.', { index: 0 });
    const fence = { ...record(text, '```\nx = 1. y = 2.\n```\n', { index: 1 }) };
    const out = insertSentenceMarks(text, [span, fence], uncited([span, fence]));
    expect(out).toBe(text);
  });

  test('a list item mark lands at the end of its text; a table mark on its own line under the table', () => {
    const text = '- First item text\n- Second item text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.';
    const li = record(text, '- First item text\n', { index: 0, kind: 'list_item' });
    const table = record(text, '| a | b |\n|---|---|\n| 1 | 2 |\n\n', { index: 2, kind: 'table' });
    const out = insertSentenceMarks(text, [li, table], uncited([li, table]));
    expect(out).toBe(
      `- First item text⁠[](${markHref('uncited', 0, 0)})\n- Second item text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[](${markHref('uncited', 0, 2)})\n\nAfter.`,
    );
  });

  test('text outside the BMP keeps every mark at its sentence end', async () => {
    const text = 'Emoji 😀 one. Math 𝟙 two.';
    const r0 = record(text, 'Emoji 😀 one. ', { index: 0 });
    const r1 = record(text, 'Math 𝟙 two.', { index: 1 });
    const verified = await verifySentenceRecords([text], [r0, r1]);
    const out = insertSentenceMarks(text, verified, uncited(verified));
    expect(out).toBe(`Emoji 😀 one.⁠[](${markHref('uncited', 0, 0)}) Math 𝟙 two.⁠[](${markHref('uncited', 0, 1)})`);
  });

  test('a two-part message places each mark in its own part', async () => {
    const parts = ['Part one fact.', 'Part two fact. More.'];
    const p0 = record(parts[0], parts[0], { part: 0, index: 0 });
    const p1 = { ...record(parts[1], 'Part two fact. ', { index: 0 }), part: 1 };
    const verified = await verifySentenceRecords(parts, [p0, p1]);
    const kinds = uncited(verified);
    expect(insertSentenceMarks(parts[0], verified.filter((r) => r.part === 0), kinds)).toBe(
      `Part one fact.⁠[](${markHref('uncited', 0, 0)})`,
    );
    expect(insertSentenceMarks(parts[1], verified.filter((r) => r.part === 1), kinds)).toBe(
      `Part two fact.⁠[](${markHref('uncited', 1, 0)}) More.`,
    );
  });

  test('cited, non-factual and truncated records get no uncited mark; both kinds are uncited first', () => {
    const text = 'One. Two. Three. Four.';
    const recs = [
      record(text, 'One. ', { index: 0, cited: true }),
      record(text, 'Two. ', { index: 1, factual: false }),
      record(text, 'Three. ', { index: 2, kind: 'truncated' }),
      record(text, 'Four.', { index: 3 }),
    ];
    const kinds = sentenceMarkKinds(recs, [{ ...recs[3], support: 'unsupported' }, { ...recs[0], support: 'supported' }]);
    expect([...kinds.entries()]).toEqual([['0:3', ['uncited', 'unsupported']]]);
  });

  test('planSentenceMarks lists only the marks that can be placed', () => {
    const text = 'Use `a. b` here. Next.';
    const span = record(text, 'Use `a.', { index: 0 });
    const next = record(text, 'Next.', { index: 1 });
    expect(planSentenceMarks(text, [span, next], uncited([span, next])).map((m) => m.id)).toEqual(['uncited-0-1']);
  });
});

describe('markFromHref', () => {
  const shown = new Set(['uncited-0-2', 'unsupported-1-4']);
  test('maps a shown mark href to its kind and index', () => {
    expect(markFromHref(markHref('uncited', 0, 2), shown)).toEqual({ kind: 'uncited', part: 0, index: 2 });
    expect(markFromHref(markHref('unsupported', 1, 4), shown)).toEqual({ kind: 'unsupported', part: 1, index: 4 });
  });

  test.each([
    ['#cite-S1'],
    ['https://example.com/#mark-uncited-0-2'],
    [`${MARK_HREF_PREFIX}uncited-0-3`],
    [`${MARK_HREF_PREFIX}other-0-2`],
    [`${MARK_HREF_PREFIX}uncited-0-2x`],
    [undefined],
  ])('%s -> null', (href) => {
    expect(markFromHref(href, shown)).toBeNull();
  });
});

describe('answerDisplayText', () => {
  const text = 'Keep this. Remove this sentence. Keep that.';
  const range = (start: number, end: number, overrides = {}) => ({ part: 0, start, end, text_hash: sha(text), ...overrides });
  const start = text.indexOf('Remove');
  const end = start + 'Remove this sentence.'.length;

  test('replaces a verified blocked range with the registry text', async () => {
    await verifySentenceRecords([text], [range(start, end)]);
    expect(answerDisplayText([text], [range(start, end)], 'en')).toEqual([
      `Keep this. ${FIXED_TEXTS.en.notices.credential_request_blocked} Keep that.`,
    ]);
    expect(answerDisplayText([text], [range(start, end)], 'it')[0]).toContain(FIXED_TEXTS.it.notices.credential_request_blocked!);
  });

  test('leaves the text unchanged when a range does not verify', async () => {
    await verifySentenceRecords([text], [range(start, end)]);
    expect(answerDisplayText([text], [range(start, end, { text_hash: 'c'.repeat(64) })], 'en')).toEqual([text]);
    expect(answerDisplayText([text], [range(start, end, { part: 2 })], 'en')).toEqual([text]);
    expect(answerDisplayText([text], [], 'en')).toEqual([text]);
  });

  test('a mark inside a replaced range is dropped and the original sentence is gone', async () => {
    const r = record(text, 'Remove this sentence. ', { index: 1 });
    const out = insertSentenceMarks(text, [r], uncited([r]), [{ start, end, text: 'X' }]);
    expect(out).toBe('Keep this. X Keep that.');
    expect(out).not.toContain('Remove');
  });
});

describe('records from the server builder', () => {
  test('marks land at the sentence ends the server recorded', async () => {
    const { buildSentenceRecords } = await import('@/lib/rag/generation/sentences-record');
    const text = 'The first value is seven [S1]. The second value is nine.\n\n- A listed value is three.\n';
    const records = buildSentenceRecords({ text, part: 0, language: 'en', aliases: new Set(['S1']) });
    const verified = await verifySentenceRecords([text], records);
    expect(verified).toHaveLength(records.length);
    const out = insertSentenceMarks(text, verified, uncited(verified));
    const rendered = renderCitationMarkers(out, { citations: [{ n: 1, alias: 'S1' }], phase: 'final' });
    expect(rendered).toContain('seven[1](#cite-S1).');
    expect(rendered).toMatch(/is nine\.⁠\[\]\(#mark-uncited-0-\d+\)/);
    expect(rendered).toMatch(/is three\.⁠\[\]\(#mark-uncited-0-\d+\)\n$/);
    expect(rendered.match(/#mark-/g)).toHaveLength(2);
  });
});

describe('stripped trailing whitespace', () => {
  test('a shown text without the persisted trailing newline verifies, and its marks stay inside the shown text', async () => {
    const persisted = 'Alpha is one.\n\n| a |\n|---|\n| 1 |\n';
    const shown = persisted.replace(/\s+$/, '');
    const fact = record(persisted, 'Alpha is one.\n\n', { index: 0 });
    const table = record(persisted, '| a |\n|---|\n| 1 |\n', { index: 1, kind: 'table' });
    const verified = await verifySentenceRecords([shown], [fact, table]);
    expect(verified).toEqual([fact, table]);
    expect(insertSentenceMarks(shown, verified, uncited(verified))).toBe(
      `Alpha is one.⁠[](${markHref('uncited', 0, 0)})\n\n| a |\n|---|\n| 1 |\n\n[](${markHref('uncited', 0, 1)})`,
    );
  });

  test('a different text with the same prefix does not verify', async () => {
    const persisted = 'Alpha is one. Beta.';
    const fact = record(persisted, 'Alpha is one. ', { index: 0 });
    expect(await verifySentenceRecords(['Alpha is one.'], [fact])).toEqual([]);
  });
});
