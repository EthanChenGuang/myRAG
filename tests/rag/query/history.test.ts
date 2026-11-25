import { describe, expect, it } from 'vitest';
import { buildHistoryWindow } from '@/lib/rag/query/history';

type Msg = { role: string; content?: unknown; parts?: unknown };

function conversation(turns: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` });
  }
  return out;
}

describe('buildHistoryWindow (D-16)', () => {
  it('keeps the last 6 turns before the current message, oldest first', () => {
    const messages = [...conversation(10), { role: 'user', content: 'current question' }];
    const window = buildHistoryWindow(messages);
    expect(window.map((turn) => turn.content)).toEqual(['turn 4', 'turn 5', 'turn 6', 'turn 7', 'turn 8', 'turn 9']);
    expect(window.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  it('honours custom limits', () => {
    const messages = [...conversation(10), { role: 'user', content: 'current question' }];
    expect(buildHistoryWindow(messages, { turns: 2, chars: 3 }).map((turn) => turn.content)).toEqual(['tur', 'tur']);
  });

  it('cuts a long turn to 1,000 characters without splitting a surrogate pair', () => {
    const long = 'x'.repeat(999) + '\u{1F600}'.repeat(1000);
    const window = buildHistoryWindow([{ role: 'user', content: long }, { role: 'user', content: 'now' }]);
    expect(Array.from(window[0].content)).toHaveLength(1000);
    expect(window[0].content.endsWith('\u{1F600}')).toBe(true);
    expect(/[\uD800-\uDBFF]$/u.test(window[0].content.slice(-1))).toBe(false);

    const plain = buildHistoryWindow([{ role: 'assistant', content: 'y'.repeat(3000) }, { role: 'user', content: 'now' }]);
    expect(plain[0].content).toHaveLength(1000);
  });

  it('strips citation markers, a sources list and source_images from assistant turns', () => {
    const assistant: Msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'The setting is enabled by default [S3]. It can be changed later 【S2】 and reset [S3, S5].\n\nSources:\n- alpha.pdf\n- beta.pdf' },
        { type: 'source_images', source_images: [{ url: 'https://example.invalid/a.png', name: 'a.png' }] },
        { type: 'tool_result', text: 'raw tool output' },
      ],
    };
    const window = buildHistoryWindow([{ role: 'user', content: 'first' }, assistant, { role: 'user', content: 'follow-up' }]);
    expect(window).toHaveLength(2);
    const text = window[1].content;
    expect(text).toBe('The setting is enabled by default. It can be changed later and reset.');
    expect(text).not.toMatch(/S\d/);
    expect(text).not.toMatch(/Sources/i);
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('raw tool output');
  });

  it('strips markdown images and a localized sources heading from string content', () => {
    const window = buildHistoryWindow([
      { role: 'assistant', content: '![chart](https://example.invalid/c.png)\nAnswer text [S1][S2].\n\n**来源：**\n1. gamma.md' },
      { role: 'user', content: 'next' },
    ]);
    expect(window).toEqual([{ role: 'assistant', content: 'Answer text.' }]);
  });

  it('reads serialized content parts and UI message parts', () => {
    const serialized = JSON.stringify({ __content_parts__: true, parts: [{ type: 'text', text: 'serialized answer' }] });
    const window = buildHistoryWindow([
      { role: 'assistant', content: serialized },
      { role: 'user', parts: [{ type: 'text', text: 'ui part question' }] },
      { role: 'user', content: 'current' },
    ]);
    expect(window).toEqual([
      { role: 'assistant', content: 'serialized answer' },
      { role: 'user', content: 'ui part question' },
    ]);
  });

  it('drops system and tool messages and turns that are empty after stripping', () => {
    const window = buildHistoryWindow([
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'question one' },
      { role: 'tool', content: 'tool text' },
      { role: 'assistant', content: '[S1]' },
      { role: 'data', content: 'data text' },
      { role: 'user', content: 'current' },
    ]);
    expect(window).toEqual([{ role: 'user', content: 'question one' }]);
  });

  it('gives [] for an empty or single-message conversation', () => {
    expect(buildHistoryWindow([])).toEqual([]);
    expect(buildHistoryWindow([{ role: 'user', content: 'only' }])).toEqual([]);
    expect(buildHistoryWindow(undefined)).toEqual([]);
  });

  it('excludes only the last user message and anything after it', () => {
    const window = buildHistoryWindow([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'current' },
      { role: 'assistant', content: 'partial' },
    ]);
    expect(window.map((turn) => turn.content)).toEqual(['q1', 'a1']);
  });
});
