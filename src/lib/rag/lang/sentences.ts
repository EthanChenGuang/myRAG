import { findCitationMarkers } from '@/lib/citations/marker-grammar';
import { countTokens, truncateToTokens } from '../ingest/text/tokens';
import { detectLanguage } from './detect';
import { getLanguagePack, getLanguageRegistry } from './registry';
import { getLanguageSettings } from './settings';

/** How a block of text is cut into sentences and how pieces of it are put back together. */
export interface SentenceSplitter {
  /** The registry language whose sentence ends this splitter uses; null for the legacy shared set. */
  readonly language: string | null;
  /** The sentences of a text, in order; never an empty piece. */
  split(_text: string): string[];
  /** The separator placed after `previous` when the next piece follows it. */
  join(_previous: string): string;
  /** Cuts a text longer than `budget` tokens (cl100k_base) into pieces of at most `budget` tokens. */
  hardSplit(_text: string, _budget: number): string[];
}

/** The splitter for one block of text (a paragraph, a clause item), chosen from that block's text. */
export type BlockSplitter = (_blockText: string) => SentenceSplitter;

/** Today's shared set (Phase 3): Latin and CJK sentence ends plus semicolons. Used unchanged with RAG_LANGUAGE_AWARE_INGEST=off. */
export const SENTENCE_END = /(?<=[.!?;。！？；])\s+|(?<=[。！？；])/u;
export const CJK_SENTENCE_END = /[。！？；]$/u;

/** Cuts text into pieces of at most `budget` tokens; a cut inside a multi-byte character drops back to the character start. */
export function hardSplit(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest !== '') {
    const piece = truncateToTokens(rest, Math.max(1, budget));
    if (piece === '') {
      pieces.push(rest);
      break;
    }
    pieces.push(piece);
    rest = rest.slice(piece.length);
  }
  return pieces;
}

export const legacySplitter: SentenceSplitter = {
  language: null,
  split: (text) => text.split(SENTENCE_END).filter((part) => part !== ''),
  join: (previous) => (CJK_SENTENCE_END.test(previous) ? '' : ' '),
  hardSplit,
};

export const legacyBlockSplitter: BlockSplitter = () => legacySplitter;

/** Scripts written without spaces between words or sentences: a sentence ends without whitespace and pieces join with nothing. */
const UNSPACED_SCRIPTS: ReadonlySet<string> = new Set(['Hani', 'Hans', 'Hant', 'Jpan', 'Hira', 'Kana', 'Thai', 'Laoo', 'Khmr', 'Mymr']);
/** Closing quotes and brackets that stay with the sentence they follow. */
const CLOSERS: ReadonlySet<string> = new Set(['"', "'", '”', '’', '»', '›', ')', ']', '}', '）', '］', '｝', '】', '」', '』', '〉', '》', '〕', '〗', '〙', '〛', '＂', '＇']);
const MARK = /^\p{M}$/u;
const SPACE = /^\s$/u;

const isMark = (char: string | undefined): boolean => char !== undefined && MARK.test(char);
const isSpace = (char: string | undefined): boolean => char !== undefined && SPACE.test(char);

/**
 * Splits at a run of sentence ends (counted once), keeping closing quotes, brackets and combining marks after it. In a spaced script the
 * run ends a sentence only when whitespace follows, so 3.5 or v2.0 never splits; the whitespace between sentences is dropped.
 * A linear scan over code points: no regular expression runs on the whole text and a surrogate pair is never cut.
 */
function scanSentences(text: string, ends: ReadonlySet<string>, needsSpace: boolean): string[] {
  const chars = Array.from(text);
  const n = chars.length;
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (from: number, to: number): void => {
    const piece = chars.slice(from, to).join('');
    if (piece.trim() !== '') out.push(piece);
  };
  while (i < n) {
    if (!ends.has(chars[i]!)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n && (ends.has(chars[j]!) || isMark(chars[j]))) j += 1;
    while (j < n && (CLOSERS.has(chars[j]!) || isMark(chars[j]))) j += 1;
    let k = j;
    while (k < n && isSpace(chars[k]) && !isMark(chars[k + 1])) k += 1;
    if (j >= n) break;
    if (needsSpace && k === j) {
      i = j;
      continue;
    }
    push(start, j);
    start = k;
    i = k;
  }
  if (start < n) push(start, n);
  return out;
}

/** hardSplit that never leaves a combining mark at the start of the next piece (it backs the cut off to the base letter). */
function graphemeSafeHardSplit(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest !== '') {
    let piece = truncateToTokens(rest, Math.max(1, budget));
    if (piece === '') {
      pieces.push(rest);
      break;
    }
    let cut = piece;
    const nextChar = (at: number): string | undefined => {
      const point = rest.codePointAt(at);
      return point === undefined ? undefined : String.fromCodePoint(point);
    };
    while (cut !== '' && isMark(nextChar(cut.length))) {
      const last = Array.from(cut).pop() ?? '';
      cut = cut.slice(0, cut.length - last.length);
    }
    if (cut !== '') piece = cut;
    pieces.push(piece);
    rest = rest.slice(piece.length);
  }
  return pieces;
}

const splitterCache = new Map<string, SentenceSplitter>();

/**
 * The splitter of a registry language (D-15): its pack's sentence_end characters only (。！？ for zh, .!? for en and it; semicolons are not
 * sentence ends), pieces joined with nothing in an unspaced script and with one space otherwise. An unknown code gets the legacy splitter.
 */
export function splitterFor(code: string): SentenceSplitter {
  const pack = getLanguagePack(code);
  if (!pack) return legacySplitter;
  const key = `${pack.code}\u0000${pack.sentence_end}\u0000${pack.script}`;
  let splitter = splitterCache.get(key);
  if (!splitter) {
    const ends: ReadonlySet<string> = new Set(Array.from(pack.sentence_end));
    const unspaced = UNSPACED_SCRIPTS.has(pack.script);
    const joiner = unspaced ? '' : ' ';
    splitter = {
      language: pack.code,
      split: (text) => scanSentences(text, ends, !unspaced),
      join: () => joiner,
      hardSplit: graphemeSafeHardSplit,
    };
    splitterCache.set(key, splitter);
  }
  return splitter;
}

/** The sentences of `text` by the rule of `language`. */
export function splitSentences(text: string, language: string): string[] {
  return splitterFor(language).split(text);
}

/** Puts sentences back together with the separator of `language`. */
export function joinSentences(sentences: readonly string[], language: string): string {
  const splitter = splitterFor(language);
  let out = '';
  for (const sentence of sentences) out = out === '' ? sentence : `${out}${splitter.join(out)}${sentence}`;
  return out;
}

export interface PackedPiece {
  text: string;
  /** The separator before this piece; '' for the first piece and after a hard cut. */
  sep: string;
}

/**
 * Packs `parts` greedily into pieces of at most `budget` tokens, joining with `join`; a part longer than the budget is cut by `cut`.
 * The packing the section chunker uses for an over-long paragraph, list item or code fence.
 */
export function packPieces(
  parts: readonly string[],
  join: (_previous: string) => string,
  cut: (_text: string, _budget: number) => string[],
  budget: number,
): PackedPiece[] {
  const pieces: PackedPiece[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') pieces.push({ text: current, sep: pieces.length === 0 ? '' : join(pieces[pieces.length - 1]?.text ?? '') });
    current = '';
  };
  for (const part of parts) {
    const candidate = current === '' ? part : `${current}${join(current)}${part}`;
    if (countTokens(candidate) <= budget) {
      current = candidate;
      continue;
    }
    flush();
    if (countTokens(part) <= budget) current = part;
    else for (const piece of cut(part, budget)) pieces.push({ text: piece, sep: '' });
  }
  flush();
  return pieces;
}

/** The segments of a text: its sentences by `language` packed to `budget` tokens; null budget returns the sentences. */
export function segmentText(text: string, language: string, budget: number | null): string[] {
  const splitter = splitterFor(language);
  const sentences = splitter.split(text);
  if (budget === null) return sentences;
  return packPieces(sentences, splitter.join, splitter.hardSplit, budget).map((piece) => piece.text);
}

export interface LanguageAwareSettings {
  languages: readonly string[];
  primary: string | null;
}

/**
 * The per-block splitter with RAG_LANGUAGE_AWARE_INGEST=on: each block is detected among the enabled languages and `und` (no evidence)
 * takes the primary language. Without chosen languages there is no primary, so the legacy splitter stays in use.
 */
export function languageAwareBlockSplitter(settings: LanguageAwareSettings): BlockSplitter {
  const { languages, primary } = settings;
  if (primary === null || languages.length === 0) return legacyBlockSplitter;
  const candidates = [...languages];
  return (blockText) => splitterFor(detectLanguage(blockText, candidates) ?? primary);
}

/** The block splitter for RAG_LANGUAGE_AWARE_INGEST: legacy when off (the language settings are not read), per block language when on. */
export function blockSplitterForIngest(mode: 'off' | 'on' | undefined): BlockSplitter {
  if (mode !== 'on') return legacyBlockSplitter;
  return languageAwareBlockSplitter(getLanguageSettings());
}

/** Phase 5.2 D-18: one unit of an answer; offsets are UTF-16 code units into the answer text as persisted, markers included. */
export interface AnswerSentenceUnit {
  index: number;
  start: number;
  end: number;
  text: string;
  kind: 'sentence' | 'list_item' | 'table' | 'heading' | 'code';
}

type AnswerUnitKind = AnswerSentenceUnit['kind'];

interface Span {
  start: number;
  end: number;
  kind: AnswerUnitKind;
}

const BLANK_LINE = /^\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A line that is one bold run (a pseudo-heading or a part label such as **{from_web}**). */
const BOLD_LINE = /^[ \t]*\*\*[^*\n]+\*\*[ \t]*[:：]?[ \t]*$/;
const TABLE_LINE = /^[ \t]*\|/;
const LIST_LINE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const CONTINUATION_LINE = /^[ \t]+\S/;
const URL_RE = /https?:\/\/[^\s<>"'`()[\]{}【】［］「」]+/gu;
const URL_TRAILING = /[.,;:!?。！？；：，、]+$/u;
const LETTER = /\p{L}/u;
const LOWER_OR_DIGIT = /[\p{Ll}\p{Nd}]/u;
const HORIZONTAL_SPACE = /[ \t 　]/;
/** Quote pairs whose content is never split; an opener without its closer in the same paragraph is ignored. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ['«', '»'],
  ['「', '」'],
  ['『', '』'],
];
/** A masked marker reads as closing brackets, so the Phase 3.2 scan keeps it with the end punctuation it follows. */
const MARKER_MASK = ']';
const URL_MASK = '_';

function isBlockStart(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING_LINE.test(line) || BOLD_LINE.test(line) || TABLE_LINE.test(line) || LIST_LINE.test(line);
}

interface Line {
  start: number;
  end: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, text: text.slice(start, end) });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.replace(/^ {0,3}/, '');
  if (!trimmed.startsWith(fence[0]!.repeat(fence.length))) return false;
  let i = 0;
  while (i < trimmed.length && trimmed[i] === fence[0]) i += 1;
  return BLANK_LINE.test(trimmed.slice(i));
}

/** Step 1 of RESEARCH Pattern 5: code fences, tables, headings and list items are one unit each; the rest is paragraph text. */
function blockPass(text: string, lines: Line[], language: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (BLANK_LINE.test(line.text)) {
      i += 1;
      continue;
    }
    const fence = FENCE_OPEN.exec(line.text);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j]!.text, fence[1]!)) j += 1;
      const last = lines[Math.min(j, lines.length - 1)]!;
      spans.push({ start: line.start, end: last.end, kind: 'code' });
      i = j + 1;
      continue;
    }
    if (HEADING_LINE.test(line.text) || BOLD_LINE.test(line.text)) {
      spans.push({ start: line.start, end: line.end, kind: 'heading' });
      i += 1;
      continue;
    }
    if (TABLE_LINE.test(line.text)) {
      let j = i + 1;
      while (j < lines.length && TABLE_LINE.test(lines[j]!.text)) j += 1;
      spans.push({ start: line.start, end: lines[j - 1]!.end, kind: 'table' });
      i = j;
      continue;
    }
    if (LIST_LINE.test(line.text)) {
      let j = i + 1;
      while (j < lines.length && CONTINUATION_LINE.test(lines[j]!.text) && !isBlockStart(lines[j]!.text)) j += 1;
      spans.push({ start: line.start, end: lines[j - 1]!.end, kind: 'list_item' });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !BLANK_LINE.test(lines[j]!.text) && !isBlockStart(lines[j]!.text)) j += 1;
    for (const sentence of paragraphSentences(text, line.start, lines[j - 1]!.end, language)) spans.push(sentence);
    i = j;
  }
  return spans;
}

/** Step 2: same-length masks, so every offset into the masked text is an offset into the answer. */
function maskParagraph(paragraph: string): { masked: string; markers: Array<{ start: number; end: number }> } {
  const markers = findCitationMarkers(paragraph).map(({ start, end }) => ({ start, end }));
  let masked = '';
  let cursor = 0;
  for (const marker of markers) {
    masked += paragraph.slice(cursor, marker.start) + MARKER_MASK.repeat(marker.end - marker.start);
    cursor = marker.end;
  }
  masked += paragraph.slice(cursor);
  return {
    masked: masked.replace(URL_RE, (url) => {
      const kept = url.replace(URL_TRAILING, '');
      return URL_MASK.repeat(kept.length) + url.slice(kept.length);
    }),
    markers,
  };
}

function quoteSpans(paragraph: string): Array<{ open: number; close: number }> {
  const spans: Array<{ open: number; close: number }> = [];
  const closers = new Map<string, number[]>();
  const openers = new Map<string, string>(QUOTE_PAIRS.map(([open, close]) => [open, close]));
  for (const [, close] of QUOTE_PAIRS) closers.set(close, []);
  for (let i = 0; i < paragraph.length; i += 1) closers.get(paragraph[i]!)?.push(i);
  const pointer = new Map<string, number>();
  let i = 0;
  while (i < paragraph.length) {
    const close = openers.get(paragraph[i]!);
    if (close === undefined) {
      i += 1;
      continue;
    }
    const positions = closers.get(close)!;
    let p = pointer.get(close) ?? 0;
    while (p < positions.length && positions[p]! <= i) p += 1;
    pointer.set(close, p);
    if (p === positions.length) {
      i += 1;
      continue;
    }
    spans.push({ open: i, close: positions[p]! });
    i = positions[p]! + 1;
  }
  return spans;
}

/** The registry codes whose sentence ends apply to a paragraph: the answer language first, then every other pack (mixed script). */
function splitterCodes(language: string): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  const add = (code: string): void => {
    const pack = getLanguagePack(code);
    if (!pack) return;
    const key = `${pack.sentence_end}\u0000${pack.script}`;
    if (seen.has(key)) return;
    seen.add(key);
    codes.push(pack.code);
  };
  add(language);
  for (const pack of getLanguageRegistry().packs) add(pack.code);
  return codes;
}

function countLetters(text: string, from: number, to: number): number {
  let letters = 0;
  for (let i = from; i < to; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    const point = text.codePointAt(i)!;
    if (LETTER.test(String.fromCodePoint(point))) letters += 1;
  }
  return letters;
}

/** Steps 3 to 5: split at the registry's sentence ends (the Phase 3.2 scan), then undo the cuts the exceptions forbid. */
function paragraphSentences(text: string, start: number, end: number, language: string): Span[] {
  const paragraph = text.slice(start, end);
  const { masked, markers } = maskParagraph(paragraph);
  let pieces = [masked];
  for (const code of splitterCodes(language)) pieces = pieces.flatMap((piece) => splitterFor(code).split(piece));

  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const at = masked.indexOf(piece, cursor);
    starts.push(at);
    ends.push(at + piece.length);
    cursor = at + piece.length;
  }

  const markerAt = new Map(markers.map((marker) => [marker.start, marker.end]));
  const quotes = quoteSpans(paragraph);
  let quote = 0;
  const boundaries: number[] = [];
  let unitStart = 0;
  for (let k = 1; k < starts.length; k += 1) {
    const spaced = starts[k]! > ends[k - 1]!;
    let boundary = starts[k]!;
    let markerEnd = markerAt.get(boundary);
    while (markerEnd !== undefined) {
      boundary = markerEnd;
      while (boundary < masked.length && HORIZONTAL_SPACE.test(masked[boundary]!)) boundary += 1;
      markerEnd = markerAt.get(boundary);
    }
    if (boundary >= ends[k]!) continue;
    while (quote < quotes.length && quotes[quote]!.close < boundary) quote += 1;
    const inQuote = quote < quotes.length && quotes[quote]!.open < boundary && boundary <= quotes[quote]!.close;
    if (inQuote) continue;
    if (spaced && LOWER_OR_DIGIT.test(String.fromCodePoint(masked.codePointAt(boundary)!))) continue;
    if (spaced && countLetters(masked, unitStart, boundary) < 3) continue;
    boundaries.push(boundary);
    unitStart = boundary;
  }

  const spans: Span[] = [];
  let from = 0;
  for (const boundary of [...boundaries, paragraph.length]) {
    spans.push({ start: start + from, end: start + boundary, kind: 'sentence' });
    from = boundary;
  }
  return spans;
}

/**
 * Phase 5.2 D-18: the one answer sentence splitter. A block pass makes each fenced code block, table, heading (or bold-only line) and list
 * item one unit; paragraph text is split at the registry's `sentence_end` characters by the Phase 3.2 scan, never inside a decimal, an
 * abbreviation followed by a lowercase letter or a digit, a URL, a citation marker or a quoted span. Markers and whitespace after a
 * sentence's end punctuation stay with it; the units tile the text, so `text.slice(start, end) === unit.text` in UTF-16 code units.
 */
export function splitAnswerSentences(text: string, language: string): AnswerSentenceUnit[] {
  if (BLANK_LINE.test(text)) return [];
  const spans = blockPass(text, linesOf(text), language);
  return spans.map((span, index) => {
    const start = index === 0 ? 0 : span.start;
    const end = index === spans.length - 1 ? text.length : spans[index + 1]!.start;
    return { index, start, end, text: text.slice(start, end), kind: span.kind };
  });
}
