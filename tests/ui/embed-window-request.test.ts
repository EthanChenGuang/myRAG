import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { toEmbedRequestBody } from '@/app/embed/window/embed-request';

const MODEL = 'provider/test-model';

function msg(id: string, role: UIMessage['role'], parts: UIMessage['parts']): UIMessage {
  return { id, role, parts };
}

describe('toEmbedRequestBody', () => {
  it('maps text parts to the content string the embed route validates', () => {
    const body = toEmbedRequestBody(
      [msg('1', 'user', [{ type: 'text', text: 'hello' }])],
      MODEL,
    );
    expect(body).toEqual({ messages: [{ role: 'user', content: 'hello' }], model: MODEL });
  });

  it('concatenates multiple text parts and skips non-text parts', () => {
    const body = toEmbedRequestBody(
      [
        msg('1', 'assistant', [
          { type: 'text', text: 'foo' },
          { type: 'step-start' },
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'bar' },
        ]),
      ],
      MODEL,
    );
    expect(body.messages).toEqual([{ role: 'assistant', content: 'foobar' }]);
  });

  it('preserves order and roles, and maps an assistant greeting', () => {
    const body = toEmbedRequestBody(
      [
        msg('greeting', 'assistant', [{ type: 'text', text: 'Welcome' }]),
        msg('2', 'user', [{ type: 'text', text: 'question' }]),
        msg('3', 'assistant', [{ type: 'text', text: 'answer' }]),
      ],
      MODEL,
    );
    expect(body.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(body.messages[0]).toEqual({ role: 'assistant', content: 'Welcome' });
  });

  it('sends no tenant fields', () => {
    const body = toEmbedRequestBody([msg('1', 'user', [{ type: 'text', text: 'x' }])], MODEL);
    expect(Object.keys(body).sort()).toEqual(['messages', 'model']);
  });
});
