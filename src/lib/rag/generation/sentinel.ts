import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';

/**
 * The no-answer sentinel (D-16, D-93). The model writes this token when the context does not answer the
 * question; the server then drops the model text and writes the registry refusal itself.
 */
export const NO_ANSWER_SENTINEL = '%%NO_ANSWER_IN_CONTEXT%%';

/** Inert form written in place of the token inside retrieved text (RESEARCH Pitfall 13). */
const NEUTRALIZED_SENTINEL = NO_ANSWER_SENTINEL.replace(/^%%/, '%').replace(/%%$/, '%').replace(/_/g, ' ');

const MAX_LEADING_WHITESPACE = 16;
const OPENING_MARKS = new Set(['`', '"', "'", '“', '‘']);

export type SentinelState = 'pending' | 'match' | 'diverged';

export interface SentinelMatcher {
  /** Feeds one delta; `release` is the text that may be shown now. */
  push(delta: string): { release: string; state: SentinelState };
  /** Ends the block: a pending prefix is decided as it stands and released. */
  flush(): { release: string; state: SentinelState };
}

function classify(held: string): SentinelState {
  let index = 0;
  while (index < held.length && /\s/.test(held[index]!)) {
    index += 1;
    if (index > MAX_LEADING_WHITESPACE) return 'diverged';
  }
  if (index === held.length) return 'pending';
  if (OPENING_MARKS.has(held[index]!)) index += 1;
  const rest = held.slice(index);
  if (rest.length >= NO_ANSWER_SENTINEL.length) return rest.startsWith(NO_ANSWER_SENTINEL) ? 'match' : 'diverged';
  return NO_ANSWER_SENTINEL.startsWith(rest) ? 'pending' : 'diverged';
}

/** Holds the first characters of a text block until they equal the sentinel or diverge (D-16). */
export function createSentinelMatcher(): SentinelMatcher {
  let held = '';
  let state: SentinelState = 'pending';
  return {
    push(delta) {
      if (state === 'match') return { release: '', state };
      if (state === 'diverged') return { release: delta, state };
      held += delta;
      state = classify(held);
      if (state === 'pending' || state === 'match') return { release: '', state };
      const release = held;
      held = '';
      return { release, state };
    },
    flush() {
      if (state !== 'pending') return { release: '', state };
      state = 'diverged';
      const release = held;
      held = '';
      return { release, state };
    },
  };
}

/** Removes complete tokens from streamed text, holding back a tail that could still start one. */
function createSentinelStripper(onStrip: () => void) {
  let tail = '';
  return {
    push(delta: string): string {
      let buffer = tail + delta;
      let out = '';
      for (;;) {
        const at = buffer.indexOf(NO_ANSWER_SENTINEL);
        if (at < 0) break;
        out += buffer.slice(0, at);
        buffer = buffer.slice(at + NO_ANSWER_SENTINEL.length);
        onStrip();
      }
      let keep = Math.min(buffer.length, NO_ANSWER_SENTINEL.length - 1);
      while (keep > 0 && !NO_ANSWER_SENTINEL.startsWith(buffer.slice(buffer.length - keep))) keep -= 1;
      tail = buffer.slice(buffer.length - keep);
      return out + buffer.slice(0, buffer.length - keep);
    },
    flush(): string {
      const rest = tail;
      tail = '';
      return rest;
    },
  };
}

interface BlockState {
  matcher: SentinelMatcher | null;
  stripper: ReturnType<typeof createSentinelStripper>;
  matched: boolean;
}

interface SentinelCoreEvents {
  onRefusal?: () => void;
  onStripped?: (count: number) => void;
}

/**
 * Shared by the stream adapter and the whole-text function, so both give the same text for every split.
 * Per step, only the first text block is matched; every block is stripped of later tokens.
 */
function createSentinelCore(refusalText: string, events: SentinelCoreEvents = {}) {
  const blocks = new Map<string, BlockState>();
  let firstBlockOpen = true;
  let emitted = false;
  let refused = false;
  let strippedCount = 0;

  const visible = (text: string): string => {
    if (text) emitted = true;
    return text;
  };

  const refuse = (): string => {
    if (refused) return '';
    refused = true;
    events.onRefusal?.();
    const text = emitted ? `\n\n${refusalText}` : refusalText;
    emitted = true;
    return text;
  };

  const settle = (block: BlockState, decision: { release: string; state: SentinelState }): string => {
    if (decision.state === 'match') {
      block.matched = true;
      return refuse();
    }
    return decision.release ? visible(block.stripper.push(decision.release)) : '';
  };

  return {
    startStep() {
      firstBlockOpen = true;
    },
    startBlock(id: string) {
      const stripper = createSentinelStripper(() => {
        strippedCount += 1;
        events.onStripped?.(1);
      });
      blocks.set(id, { matcher: firstBlockOpen ? createSentinelMatcher() : null, stripper, matched: false });
      firstBlockOpen = false;
    },
    push(id: string, delta: string): string {
      if (!blocks.has(id)) this.startBlock(id);
      const block = blocks.get(id)!;
      if (block.matched) return '';
      if (block.matcher) return settle(block, block.matcher.push(delta));
      return visible(block.stripper.push(delta));
    },
    endBlock(id: string): string {
      const block = blocks.get(id);
      if (!block) return '';
      blocks.delete(id);
      if (block.matched) return '';
      let out = block.matcher ? settle(block, block.matcher.flush()) : '';
      if (block.matched) return out;
      out += visible(block.stripper.flush());
      return out;
    },
    openBlockIds(): string[] {
      return [...blocks.keys()];
    },
    get refused() {
      return refused;
    },
    get strippedCount() {
      return strippedCount;
    },
  };
}

export interface SentinelTextResult {
  text: string;
  refused: boolean;
  strippedCount: number;
}

/** Whole-text twin of the stream adapter: one text block per step, same visible text and outcome. */
export function applySentinelToText(textsPerStep: readonly string[], refusalText: string): SentinelTextResult {
  const core = createSentinelCore(refusalText);
  let text = '';
  textsPerStep.forEach((stepText, index) => {
    const id = `step-${index}`;
    core.startStep();
    core.startBlock(id);
    text += core.push(id, stepText);
    text += core.endBlock(id);
  });
  return { text, refused: core.refused, strippedCount: core.strippedCount };
}

/** Replaces every exact token in retrieved text with an inert form and counts them. */
export function neutralizeSentinel(text: string): { text: string; count: number } {
  if (!text.includes(NO_ANSWER_SENTINEL)) return { text, count: 0 };
  const parts = text.split(NO_ANSWER_SENTINEL);
  return { text: parts.join(NEUTRALIZED_SENTINEL), count: parts.length - 1 };
}

export interface SentinelTransformOptions {
  /** The registry refusal chosen by the caller (`notices.no_information` or `notices.no_information_web`). */
  refusalText: string;
  onRefusal?: (info: { refusalOrigin: 'model_relevance' }) => void;
  /** Called with the number of later tokens stripped by one delta. */
  onStripped?: (count: number) => void;
}

type Part = TextStreamPart<ToolSet>;

/**
 * Stream adapter for `experimental_transform` (D-16, D-93). Only text-delta text is held; start-step,
 * finish-step, tool parts and finish are forwarded at once (RESEARCH Pitfall 1).
 */
export function sentinelTransform(options: SentinelTransformOptions): StreamTextTransform<ToolSet> {
  return () => {
    const core = createSentinelCore(options.refusalText, {
      onRefusal: () => options.onRefusal?.({ refusalOrigin: 'model_relevance' }),
      onStripped: options.onStripped,
    });
    const emit = (controller: TransformStreamDefaultController<Part>, id: string, text: string) => {
      if (text) controller.enqueue({ type: 'text-delta', id, text });
    };
    const endOpenBlocks = (controller: TransformStreamDefaultController<Part>) => {
      for (const id of core.openBlockIds()) emit(controller, id, core.endBlock(id));
    };
    return new TransformStream<Part, Part>({
      transform(part, controller) {
        switch (part.type) {
          case 'start-step':
            core.startStep();
            break;
          case 'text-start':
            core.startBlock(part.id);
            break;
          case 'text-delta': {
            const text = core.push(part.id, part.text);
            if (text) controller.enqueue({ ...part, text });
            return;
          }
          case 'text-end':
            emit(controller, part.id, core.endBlock(part.id));
            break;
          case 'finish-step':
          case 'finish':
            endOpenBlocks(controller);
            break;
          default:
            break;
        }
        controller.enqueue(part);
      },
      flush(controller) {
        endOpenBlocks(controller);
      },
    });
  };
}
