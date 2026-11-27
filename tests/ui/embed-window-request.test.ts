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

describe('toEmbedRequestBody standalone-query metadata (D-22, D-17)', () => {
  const RAG = { standaloneQuery: 'Which option controls the import format?', queryLanguage: 'en' };
  const withMetadata = (message: UIMessage, metadata: unknown): UIMessage => ({ ...message, metadata });

  it('sends metadata.rag on the user message that precedes an assistant message carrying it', () => {
    const body = toEmbedRequestBody(
      [
        msg('greeting', 'assistant', [{ type: 'text', text: 'Welcome' }]),
        msg('1', 'user', [{ type: 'text', text: 'And the import one?' }]),
        withMetadata(msg('2', 'assistant', [{ type: 'text', text: 'answer' }]), { rag: RAG, feedbackToken: 't' }),
        msg('3', 'user', [{ type: 'text', text: 'next' }]),
      ],
      MODEL,
    );
    expect(body.messages).toEqual([
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'And the import one?', metadata: { rag: RAG } },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('drops a malformed rag value', () => {
    for (const rag of [{ ...RAG, scope: 'x' }, { standaloneQuery: 'x'.repeat(1001), queryLanguage: 'en' }, 'text', null]) {
      const body = toEmbedRequestBody(
        [msg('1', 'user', [{ type: 'text', text: 'q' }]), withMetadata(msg('2', 'assistant', [{ type: 'text', text: 'a' }]), { rag })],
        MODEL,
      );
      expect(body.messages[0]).toEqual({ role: 'user', content: 'q' });
    }
  });

  it('adds the optional language only when one is given', () => {
    const messages = [msg('1', 'user', [{ type: 'text', text: 'x' }])];
    expect(toEmbedRequestBody(messages, MODEL, 'it-IT')).toEqual({ messages: [{ role: 'user', content: 'x' }], model: MODEL, language: 'it' });
    expect(toEmbedRequestBody(messages, MODEL, '')).not.toHaveProperty('language');
    expect(toEmbedRequestBody(messages, MODEL, undefined)).not.toHaveProperty('language');
  });
});
