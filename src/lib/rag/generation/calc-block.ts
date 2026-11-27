import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import { CalcRequestSchema, type CalcRequest } from '@/lib/rag-eval/contracts.generated';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import {
  MAX_MARKER_HOLD_CHARS,
  findCitationMarkers,
  isMarkerOpener,
  isOpenMarkerPrefix,
} from '@/lib/citations/marker-grammar';

/**
 * Phase 5.2.1 D-72: the trailing calculation block that models without tool support write after the answer. The block is
 * held back, removed from the visible text and parsed as a CalcRequest; the event goes to `onTrace` (the route connects it to
 * the per-request trace holder). The stream adapter and the whole-text function share one core, so both agree for every split.
 */

export const DEFAULT_MAX_BLOCK_CHARS = 8000;

export type CalcBlockInvalidReason = 'unterminated' | 'too_long' | 'parse' | 'schema';

export interface CalcBlockTrace {
  origin: 'trailing_block';
  request: CalcRequest;
  /** Offset in the raw text (answer minus blocks, markers kept) where the block stood. */
  anchor_offset: number;
}

export interface CalcBlockInvalid {
  invalid: CalcBlockInvalidReason;
  anchor_offset: number;
}

export type CalcBlockEvent = CalcBlockTrace | CalcBlockInvalid;

export interface CalcBlockOptions {
  onTrace?: (event: CalcBlockEvent) => void;
  /** Bound on the block content between the tags (T-05.2.1-20). */
  maxBlockChars?: number;
  /** D-65, D-74: remove complete citation markers from the visible text; the raw text keeps them. */
  stripMarkers?: boolean;
}

export interface CalcBlockExtractor {
  /** Feeds one delta; returns the visible text that may be shown now. */
  push(delta: string): string;
  /** Ends the text: a held tag prefix is released, an open block is removed and recorded invalid. */
  flush(): string;
  /** The model text minus blocks, citation markers kept (the text the check reads). */
  rawText(): string;
  /** The text shown so far. */
  visibleText(): string;
}

export interface CalcBlockExtraction {
  visibleText: string;
  rawText: string;
  traces: CalcBlockTrace[];
  invalid: CalcBlockInvalid[];
}

const TAGS = [CALC_BLOCK_OPEN, CALC_BLOCK_CLOSE] as const;
const WHITESPACE = /\s/;
const HORIZONTAL_WS = /[ \t 　]/;
const FENCE = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```$/;

function parseBlock(content: string): { request: CalcRequest } | { invalid: 'parse' | 'schema' } {
  let body = content.trim();
  const fenced = FENCE.exec(body);
  if (fenced) body = fenced[1]!.trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { invalid: 'parse' };
  }
  const parsed = CalcRequestSchema.safeParse(value);
  return parsed.success ? { request: parsed.data } : { invalid: 'schema' };
}

/** Length of the longest suffix of `text` that is a proper prefix of one of the tags. */
function tagPrefixLength(text: string): number {
  const max = Math.min(text.length, CALC_BLOCK_CLOSE.length - 1);
  for (let length = max; length > 0; length--) {
    const suffix = text.slice(text.length - length);
    if (TAGS.some((tag) => tag.length > length && tag.startsWith(suffix))) return length;
  }
  return 0;
}

function trailingWhitespaceStart(text: string, test: RegExp): number {
  let start = text.length;
  while (start > 0 && test.test(text[start - 1]!)) start--;
  return start;
}

/**
 * Streaming twin of stripCitationMarkers: holds a trailing open-marker prefix and trailing horizontal whitespace (a marker
 * after it would trim it) and skips the whitespace after a marker at the start of a line.
 */
function createMarkerStripper() {
  let pending = '';
  let skipWhitespace = false;
  let emittedEmpty = true;
  let emittedNewline = false;
  const emit = (text: string): string => {
    if (text) {
      emittedEmpty = false;
      emittedNewline = text.endsWith('\n');
    }
    return text;
  };
  const drain = (final: boolean): string => {
    let out = '';
    for (;;) {
      if (skipWhitespace) {
        let index = 0;
        while (index < pending.length && HORIZONTAL_WS.test(pending[index]!)) index++;
        pending = pending.slice(index);
        if (!pending) return out;
        skipWhitespace = false;
      }
      const marker = findCitationMarkers(pending)[0];
      if (marker) {
        const before = pending.slice(0, marker.start);
        out += emit(before.slice(0, trailingWhitespaceStart(before, HORIZONTAL_WS)));
        pending = pending.slice(marker.end);
        if (emittedEmpty || emittedNewline) skipWhitespace = true;
        continue;
      }
      if (final) {
        out += emit(pending);
        pending = '';
        return out;
      }
      let cut = trailingWhitespaceStart(pending, HORIZONTAL_WS);
      for (let p = Math.max(0, pending.length - MAX_MARKER_HOLD_CHARS - 1); p < pending.length; p++) {
        if (isMarkerOpener(pending[p]!) && isOpenMarkerPrefix(pending.slice(p))) {
          cut = Math.min(cut, trailingWhitespaceStart(pending.slice(0, p), HORIZONTAL_WS));
          break;
        }
      }
      out += emit(pending.slice(0, cut));
      pending = pending.slice(cut);
      return out;
    }
  };
  return {
    push(text: string): string {
      pending += text;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}

/** The shared core: removes blocks and stray close tags, collapses the whitespace a removed block leaves. */
function createCore(options: CalcBlockOptions, events: CalcBlockEvent[]) {
  const maxBlockChars = options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;
  const stripper = options.stripMarkers ? createMarkerStripper() : null;
  let raw = '';
  let visible = '';
  let mode: 'text' | 'block' | 'overflow' = 'text';
  /** Text mode: an undecided tail (whitespace run plus tag prefix). Block mode: the block content. */
  let held = '';
  /** After a removed block: the whitespace before it, used as the separator when text follows. */
  let separator: string | null = null;
  let blockAnchor = 0;

  const record = (event: CalcBlockEvent) => {
    events.push(event);
    options.onTrace?.(event);
  };

  const commit = (text: string): string => {
    if (!text) return '';
    raw += text;
    const shown = stripper ? stripper.push(text) : text;
    visible += shown;
    return shown;
  };

  /** Commits plain text, applying the pending separator after a block. */
  const commitText = (text: string): string => {
    if (separator === null) return commit(text);
    let index = 0;
    while (index < text.length && WHITESPACE.test(text[index]!)) index++;
    if (index === text.length) {
      if (!separator) separator = text;
      return '';
    }
    const lead = separator || text.slice(0, index);
    separator = null;
    return commit(lead + text.slice(index));
  };

  const processText = (input: string): string => {
    let out = '';
    let text = input;
    for (;;) {
      const open = text.indexOf(CALC_BLOCK_OPEN);
      const close = text.indexOf(CALC_BLOCK_CLOSE);
      if (open < 0 && close < 0) break;
      if (close >= 0 && (open < 0 || close < open)) {
        out += commitText(text.slice(0, close));
        text = text.slice(close + CALC_BLOCK_CLOSE.length);
        continue;
      }
      const before = text.slice(0, open);
      const wsStart = trailingWhitespaceStart(before, WHITESPACE);
      out += commitText(before.slice(0, wsStart));
      const whitespace = before.slice(wsStart);
      if (!separator) separator = whitespace;
      blockAnchor = raw.length;
      mode = 'block';
      held = '';
      return out + processBlock(text.slice(open + CALC_BLOCK_OPEN.length));
    }
    // No complete tag: hold a tag prefix and the whitespace before it, plus any trailing whitespace.
    const prefix = tagPrefixLength(text);
    const body = text.slice(0, text.length - prefix);
    const wsStart = trailingWhitespaceStart(body, WHITESPACE);
    held = text.slice(wsStart);
    return out + commitText(body.slice(0, wsStart));
  };

  const processBlock = (input: string): string => {
    held += input;
    const close = held.indexOf(CALC_BLOCK_CLOSE);
    if (mode === 'overflow') {
      if (close < 0) {
        held = held.slice(Math.max(0, held.length - (CALC_BLOCK_CLOSE.length - 1)));
        return '';
      }
      const rest = held.slice(close + CALC_BLOCK_CLOSE.length);
      mode = 'text';
      held = '';
      return processText(rest);
    }
    if (close < 0) {
      if (held.length - tagPrefixLength(held) > maxBlockChars) {
        record({ invalid: 'too_long', anchor_offset: blockAnchor });
        mode = 'overflow';
        held = held.slice(Math.max(0, held.length - (CALC_BLOCK_CLOSE.length - 1)));
      }
      return '';
    }
    const content = held.slice(0, close);
    const rest = held.slice(close + CALC_BLOCK_CLOSE.length);
    if (content.length > maxBlockChars) record({ invalid: 'too_long', anchor_offset: blockAnchor });
    else {
      const parsed = parseBlock(content);
      if ('request' in parsed) record({ origin: 'trailing_block', request: parsed.request, anchor_offset: blockAnchor });
      else record({ invalid: parsed.invalid, anchor_offset: blockAnchor });
    }
    mode = 'text';
    held = '';
    return processText(rest);
  };

  return {
    push(delta: string): string {
      if (!delta) return '';
      if (mode === 'text') {
        const text = held + delta;
        held = '';
        return processText(text);
      }
      return processBlock(delta);
    },
    flush(): string {
      let out = '';
      if (mode === 'block') record({ invalid: 'unterminated', anchor_offset: blockAnchor });
      if (mode === 'text' && held) out += commitText(held);
      held = '';
      mode = 'text';
      separator = null;
      if (stripper) {
        const rest = stripper.flush();
        visible += rest;
        out += rest;
      }
      return out;
    },
    rawText: () => raw,
    visibleText: () => visible,
  };
}

export function createCalcBlockExtractor(options: CalcBlockOptions = {}): CalcBlockExtractor {
  const core = createCore(options, []);
  return { push: core.push, flush: core.flush, rawText: core.rawText, visibleText: core.visibleText };
}

/** Whole-text twin: the same core fed the whole answer at once (D-72). */
export function extractCalcBlocks(text: string, options: CalcBlockOptions = {}): CalcBlockExtraction {
  const events: CalcBlockEvent[] = [];
  const core = createCore(options, events);
  core.push(text);
  core.flush();
  return {
    visibleText: core.visibleText(),
    rawText: core.rawText(),
    traces: events.filter((event): event is CalcBlockTrace => 'origin' in event),
    invalid: events.filter((event): event is CalcBlockInvalid => 'invalid' in event),
  };
}

export type CalcBlockTransform = StreamTextTransform<ToolSet> & {
  rawText(): string;
  visibleText(): string;
};

type Part = TextStreamPart<ToolSet>;

/**
 * Stream adapter for `experimental_transform`, factory-returning-factory like the sentinel. Only text-delta and text-end are
 * held; at text-end (and at finish-step or finish for a text part left open) the core is flushed. start-step, finish-step,
 * tool parts and finish are forwarded at once (RESEARCH Pitfall 1). rawText() and visibleText() read the latest stream's core.
 */
export function calcBlockTransform(options: CalcBlockOptions = {}): CalcBlockTransform {
  let current: ReturnType<typeof createCore> | null = null;
  const transform = (() => {
    const core = createCore(options, []);
    current = core;
    let openId: string | null = null;
    const emit = (controller: TransformStreamDefaultController<Part>, id: string, text: string) => {
      if (text) controller.enqueue({ type: 'text-delta', id, text });
    };
    const close = (controller: TransformStreamDefaultController<Part>) => {
      if (openId === null) return;
      const id = openId;
      openId = null;
      emit(controller, id, core.flush());
    };
    return new TransformStream<Part, Part>({
      transform(part, controller) {
        switch (part.type) {
          case 'text-delta': {
            if (openId !== null && openId !== part.id) close(controller);
            openId = part.id;
            const text = core.push(part.text);
            if (text) controller.enqueue({ ...part, text });
            return;
          }
          case 'text-end':
            if (openId === part.id) close(controller);
            break;
          case 'finish-step':
          case 'finish':
            close(controller);
            break;
          default:
            break;
        }
        controller.enqueue(part);
      },
      flush(controller) {
        close(controller);
      },
    });
  }) as unknown as CalcBlockTransform;
  transform.rawText = () => current?.rawText() ?? '';
  transform.visibleText = () => current?.visibleText() ?? '';
  return transform;
}
