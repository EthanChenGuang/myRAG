import { describe, expect, test } from 'vitest';
import { splitFollowups } from '@/lib/chat/followups';

const BODY = 'The answer text.\n\n**Source:** Doc-A.pdf';

describe('splitFollowups', () => {
  test('splits a valid tail into body and follow-ups', () => {
    const text = `${BODY}\n\n---\n↳ First question?\n↳ Second question?\n`;
    expect(splitFollowups(text)).toEqual({ body: BODY, followups: ['First question?', 'Second question?'] });
  });

  test('allows blank lines and trailing whitespace inside the tail', () => {
    const text = `${BODY}\n\n---   \n\n↳ First question?   \n\n↳ Second question?\n\n  \n`;
    expect(splitFollowups(text)).toEqual({ body: BODY, followups: ['First question?', 'Second question?'] });
  });

  test('returns text unchanged when there is no tail', () => {
    expect(splitFollowups(BODY)).toEqual({ body: BODY, followups: [] });
    expect(splitFollowups('')).toEqual({ body: '', followups: [] });
  });

  test('does not trigger on --- in the middle of the text', () => {
    const text = 'Part one.\n\n---\n\nPart two continues here.';
    expect(splitFollowups(text)).toEqual({ body: text, followups: [] });
  });

  test('does not trigger when follow-up lines are followed by other text', () => {
    const text = `${BODY}\n\n---\n↳ First question?\nMore prose after it.`;
    expect(splitFollowups(text)).toEqual({ body: text, followups: [] });
  });

  test('does not trigger on follow-up lines without a preceding --- line', () => {
    const text = `${BODY}\n\n↳ First question?`;
    expect(splitFollowups(text)).toEqual({ body: text, followups: [] });
  });

  test('accepts up to 5 lines and rejects more than 5', () => {
    const five = Array.from({ length: 5 }, (_, i) => `↳ Question ${i + 1}?`).join('\n');
    expect(splitFollowups(`${BODY}\n\n---\n${five}`).followups).toHaveLength(5);
    const six = Array.from({ length: 6 }, (_, i) => `↳ Question ${i + 1}?`).join('\n');
    const text = `${BODY}\n\n---\n${six}`;
    expect(splitFollowups(text)).toEqual({ body: text, followups: [] });
  });

  test('does not trigger inside an unclosed code fence', () => {
    const text = 'Example:\n\n```md\nIntro\n---\n↳ Inside a fence?';
    expect(splitFollowups(text)).toEqual({ body: text, followups: [] });
    const tilde = 'Example:\n\n~~~\n---\n↳ Inside a fence?';
    expect(splitFollowups(tilde)).toEqual({ body: tilde, followups: [] });
  });

  test('a closed code fence with --- before the tail still splits the real tail', () => {
    const body = 'Example:\n\n```\n---\n```';
    expect(splitFollowups(`${body}\n\n---\n↳ Real question?`)).toEqual({ body, followups: ['Real question?'] });
  });

  test('accepts -> and → arrow variants', () => {
    const text = `${BODY}\n\n---\n-> Ascii arrow?\n→ Unicode arrow?\n↳ Hook arrow?`;
    expect(splitFollowups(text).followups).toEqual(['Ascii arrow?', 'Unicode arrow?', 'Hook arrow?']);
  });

  test('handles CRLF line endings', () => {
    const text = 'The answer text.\r\n\r\n---\r\n↳ First question?\r\n↳ Second question?\r\n';
    expect(splitFollowups(text)).toEqual({ body: 'The answer text.', followups: ['First question?', 'Second question?'] });
  });

  test('ignores an arrow line with no question text', () => {
    const text = `${BODY}\n\n---\n↳ \n`;
    expect(splitFollowups(text)).toEqual({ body: text, followups: [] });
  });
});
