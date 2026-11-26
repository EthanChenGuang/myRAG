import { countTokens, truncateToTokens } from '../ingest/text/tokens';
import { detectLanguage } from './detect';
import { getLanguagePack } from './registry';
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

export function splitAnswerSentences(_text: string, _language: string): AnswerSentenceUnit[] {
  return [];
}
