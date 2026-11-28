import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardEmptyReply } from '@/lib/chat/empty-reply';
import { isBlankAssistantMessage, isBlankContent } from '@/lib/chat/blank-message';

type Chunk = { type: string; [key: string]: unknown };

async function run(chunks: Chunk[], onEmpty = vi.fn()) {
  const source = new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const out: Chunk[] = [];
  const reader = guardEmptyReply(source, { route: 'chat', model: 'm', message: () => 'notice', onEmpty }).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return { out, onEmpty };
}

const START = { type: 'start' };
const FINISH = { type: 'finish', finishReason: 'stop' };

describe('guardEmptyReply', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes a stream with text through unchanged, chunk for chunk', async () => {
    const chunks = [START, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'hi' }, { type: 'text-end', id: 't' }, FINISH];
    const { out, onEmpty } = await run(chunks);
    expect(out).toEqual(chunks);
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it('treats a tool call as an answer', async () => {
    const chunks = [START, { type: 'tool-input-available', toolCallId: 'c', toolName: 'x', input: {} }, FINISH];
    expect((await run(chunks)).out).toEqual(chunks);
  });

  it('does not add a second error after a stream error or an abort', async () => {
    for (const end of [{ type: 'error', errorText: 'boom' }, { type: 'abort' }]) {
      const chunks = [START, end, FINISH];
      expect((await run(chunks)).out).toEqual(chunks);
    }
  });

  it('inserts one error part before the finish of an empty or reasoning-only stream', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const middle of [[], [{ type: 'text-delta', id: 't', delta: '' }], [{ type: 'reasoning-delta', id: 'r', delta: 'thinking' }]]) {
      const { out, onEmpty } = await run([START, ...middle, { type: 'finish', finishReason: 'content-filter' }]);
      expect(out.slice(-2)).toEqual([{ type: 'error', errorText: 'notice' }, { type: 'finish', finishReason: 'content-filter' }]);
      expect(onEmpty).toHaveBeenCalledWith({ finishReason: 'content-filter', route: 'chat', model: 'm' });
    }
  });
});

describe('blank assistant messages', () => {
  it('detects blank content and keeps placeholders and non-text parts', () => {
    expect(isBlankContent('  ')).toBe(true);
    expect(isBlankContent([{ type: 'text', text: '' }])).toBe(true);
    expect(isBlankContent([{ type: 'source_images', source_images: [] }])).toBe(false);
    expect(isBlankAssistantMessage({ id: 'a', role: 'assistant', content: '' })).toBe(true);
    expect(isBlankAssistantMessage({ id: 'thinking', role: 'assistant', content: '' })).toBe(false);
    expect(isBlankAssistantMessage({ id: 'u', role: 'user', content: '' })).toBe(false);
    expect(isBlankAssistantMessage({ id: 'b', role: 'assistant', content: 'text' })).toBe(false);
  });
});
