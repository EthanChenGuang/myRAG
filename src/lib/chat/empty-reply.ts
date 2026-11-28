import { errorStreamPart } from '@/lib/error-stream';

export interface EmptyReplyInfo {
  finishReason: string | null;
  route: 'chat' | 'embed';
  model: string;
}

export interface EmptyReplyGuardOptions {
  route: 'chat' | 'embed';
  model: string;
  /** The localized notice; read only when the reply was empty. */
  message: () => string;
  onEmpty?: (info: EmptyReplyInfo) => void;
}

const TOOL_PART = /^tool-/;

/**
 * Answer streams that finish with no text and no tool call (a provider refusal, a content filter or an empty completion)
 * get one error part before their finish part, so the client shows a notice instead of a blank bubble. Every other stream
 * passes through unchanged, chunk for chunk.
 */
export function guardEmptyReply<T extends { type: string }>(stream: ReadableStream<T>, options: EmptyReplyGuardOptions): ReadableStream<T> {
  let answered = false;
  let failed = false;
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        const type = chunk.type;
        if (type === 'text-delta') {
          const delta = (chunk as { delta?: unknown }).delta;
          if (typeof delta === 'string' && delta.length > 0) answered = true;
        } else if (TOOL_PART.test(type)) {
          answered = true;
        } else if (type === 'error' || type === 'abort') {
          failed = true;
        } else if (type === 'finish' && !answered && !failed) {
          const raw = (chunk as { finishReason?: unknown }).finishReason;
          const finishReason = typeof raw === 'string' ? raw : null;
          console.warn('[Chat] Model reply was empty; streaming the empty-reply notice:', {
            route: options.route,
            model: options.model,
            finishReason,
          });
          try {
            options.onEmpty?.({ finishReason, route: options.route, model: options.model });
          } catch {
            // the notice must reach the client even when bookkeeping fails
          }
          controller.enqueue(errorStreamPart(options.message()) as unknown as T);
          failed = true;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
