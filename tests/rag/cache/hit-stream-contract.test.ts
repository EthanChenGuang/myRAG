import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { streamCachedAnswer } from '@/lib/rag';
import { cachedAnswer } from './fixtures';

function written(answerText: string, overrides: Parameters<typeof cachedAnswer>[0] = {}): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  streamCachedAnswer(
    { entryId: 'entry-1', distance: 0.01, answer: cachedAnswer({ answer_text: answerText, ...overrides }) },
    { writer: { write: (chunk: UIMessageChunk) => void chunks.push(chunk) }, textId: 'text-1' },
  );
  return chunks;
}

function deltas(chunks: UIMessageChunk[]): string[] {
  return chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : []));
}

const ANSWER =
  'The first synthetic sentence names a neutral module.  The second one, after two spaces,\nruns onto a new line and ends here. ';

describe('streamCachedAnswer streams a hit as text deltas (D-27)', () => {
  it('writes a stored answer as more than one text delta whose concatenation is the stored text', () => {
    const parts = deltas(written(ANSWER));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(ANSWER);
    expect(parts.every((part) => part.length > 0)).toBe(true);
  });

  it('keeps the part order: start, text-start, the deltas, text-end, finish, all under one text id', () => {
    const chunks = written(ANSWER);
    const types = chunks.map((chunk) => chunk.type);
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('finish');
    const textStart = types.indexOf('text-start');
    const textEnd = types.indexOf('text-end');
    expect(types.slice(textStart + 1, textEnd).every((type) => type === 'text-delta')).toBe(true);
    for (const chunk of chunks) {
      if (chunk.type === 'text-start' || chunk.type === 'text-delta' || chunk.type === 'text-end') expect(chunk.id).toBe('text-1');
    }
  });

  it('keeps leading whitespace and a one-word or empty answer exact', () => {
    expect(deltas(written('  leading words stay in the first delta')).join('')).toBe('  leading words stay in the first delta');
    expect(deltas(written('single'))).toEqual(['single']);
    expect(deltas(written(''))).toEqual(['']);
  });

  it('streams a stored refusal the same way', () => {
    const refusal = 'A neutral synthetic refusal says the information is not available in the knowledge base.';
    const parts = deltas(written(refusal, { is_refusal: true, citations: [], sources: [] }));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(refusal);
  });
});
