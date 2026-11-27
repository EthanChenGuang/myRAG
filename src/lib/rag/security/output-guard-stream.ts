import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import type { OutputGuard, OutputGuardLinkSummary } from './output-guard';

type Part = TextStreamPart<ToolSet>;

export interface OutputGuardTransformOptions {
  /** Called once per stream, at its first part, so the policy can read the turn as it stands then. */
  createGuard: () => OutputGuard;
  /** Called once per stream with the guard's summary: at the finish part, or at the end of a stream that has none. */
  onSummary?: (summary: OutputGuardLinkSummary) => void;
  /** Sees every part that is not a text delta before it is forwarded (tool results of the turn, for the policy). */
  observe?: (part: Part) => void;
}

/**
 * D-35, D-38: the stream adapter of the output guard. Text deltas go through the pure core per text id and only the releasable
 * text is forwarded under the same id; at text-end, finish-step and finish the held rest is flushed first. Every other part
 * (tool calls and results, reasoning, sources, step boundaries) is forwarded at once and never held or changed.
 */
export function outputGuardTransform(options: OutputGuardTransformOptions): StreamTextTransform<ToolSet> {
  return () => {
    let guard: OutputGuard | null = null;
    let summarized = false;
    const guardOf = (): OutputGuard => (guard ??= options.createGuard());
    const flushAll = (controller: TransformStreamDefaultController<Part>) => {
      if (!guard) return;
      for (const { textId, text } of guard.flushAll()) {
        if (text) controller.enqueue({ type: 'text-delta', id: textId, text });
      }
    };
    const summarize = () => {
      if (summarized) return;
      summarized = true;
      options.onSummary?.(guardOf().summary());
    };
    return new TransformStream<Part, Part>({
      transform(part, controller) {
        if (part.type === 'text-delta') {
          const out = guardOf().push(part.id, part.text);
          if (out) controller.enqueue({ ...part, text: out });
          return;
        }
        options.observe?.(part);
        if (part.type === 'text-end') {
          const rest = guardOf().flush(part.id);
          if (rest) controller.enqueue({ type: 'text-delta', id: part.id, text: rest });
        } else if (part.type === 'finish-step') {
          flushAll(controller);
        } else if (part.type === 'finish') {
          flushAll(controller);
          summarize();
        }
        controller.enqueue(part);
      },
      flush(controller) {
        flushAll(controller);
        summarize();
      },
    });
  };
}
