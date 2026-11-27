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

/**
 * D-26: holds the finish part until `beforeFinish` settles, so the synchronous messageMetadata callback on that part sees its result.
 * A rejection is swallowed here: the caller records the failure and the stream is never blocked by it.
 */
export function finishGateTransform(beforeFinish: () => Promise<void>): StreamTextTransform<ToolSet> {
  return () =>
    new TransformStream({
      async transform(part, controller) {
        if (part.type === 'finish') {
          try {
            await beforeFinish();
          } catch {
            // recorded by the caller
          }
        }
        controller.enqueue(part);
      },
    });
}
