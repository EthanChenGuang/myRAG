import { describe, expect, it } from 'vitest';
import { fromDBMessages, toDBMessages, type ContentPart, type ExtendedMessage } from '@/types/chat';

const SOURCE_IMAGES = [
  { name: 'diagram.png', size: 0, type: 'image/jpeg', url: 'https://example.com/fixtures/diagram.png' },
  { name: 'chart.png', size: 0, type: 'image/jpeg', url: 'https://example.com/fixtures/chart.png' },
];

function assistantMessage(content: ExtendedMessage['content']): ExtendedMessage {
  return { id: 'assistant-1', role: 'assistant', content, createdAt: new Date('2026-01-01T00:00:00.000Z') };
}

describe('chat message persistence round trip', () => {
  it('keeps a source_images content part unchanged through toDBMessages and fromDBMessages', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'ok' },
      { type: 'source_images', source_images: SOURCE_IMAGES },
    ];

    const [restored] = fromDBMessages(toDBMessages([assistantMessage(parts)]));

    expect(restored.content).toEqual(parts);
    expect(Array.isArray(restored.content) && restored.content[1]).toEqual({
      type: 'source_images',
      source_images: SOURCE_IMAGES,
    });
  });

  it('copies content as-is into the database shape', () => {
    const parts: ContentPart[] = [{ type: 'source_images', source_images: SOURCE_IMAGES }];
    const message = assistantMessage(parts);

    const [stored] = toDBMessages([message]);

    expect(stored.content).toBe(message.content);
    expect(stored.id).toBe('assistant-1');
    expect(stored.role).toBe('assistant');
  });

  it('keeps plain string content and maps the system role to data and back', () => {
    const stored = toDBMessages([
      { id: 's-1', role: 'system', content: 'be brief' },
      { id: 'u-1', role: 'user', content: 'hello' },
    ]);

    expect(stored.map((message) => message.role)).toEqual(['data', 'user']);
    expect(stored.map((message) => message.content)).toEqual(['be brief', 'hello']);

    const restored = fromDBMessages(stored);
    expect(restored.map((message) => message.role)).toEqual(['system', 'user']);
    expect(restored.map((message) => message.content)).toEqual(['be brief', 'hello']);
  });
});
