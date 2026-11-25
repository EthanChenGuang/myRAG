import type { StreamTextTransform, ToolSet } from 'ai';

export interface AliasParserSink {
  feed(textId: string, delta: string): void;
  end(textId: string): void;
  finish(): void;
  fail(reason: string): void;
}

/** Pass-through transform: every part is forwarded unchanged while text deltas feed the marker parser. */
export function aliasParserTransform(sink: AliasParserSink): StreamTextTransform<ToolSet> {
  return () =>
    new TransformStream({
      transform(part, controller) {
        try {
          switch (part.type) {
            case 'text-delta':
              sink.feed(part.id, part.text);
              break;
            case 'text-end':
              sink.end(part.id);
              break;
            case 'error':
              sink.fail('stream_error');
              break;
            case 'finish':
              sink.finish();
              break;
            default:
              break;
          }
        } catch {
          sink.fail('parser_error');
        }
        controller.enqueue(part);
      },
      flush() {
        try {
          sink.finish();
        } catch {
          sink.fail('parser_error');
        }
      },
    });
}
