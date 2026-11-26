import { createHash } from 'node:crypto';
import { findCitationMarkers, stripCitationMarkers } from '@/lib/citations/marker-grammar';
import type { AnswerSentence } from '@/lib/rag-eval/contracts.generated';
import { TEXT_KEYS } from '../lang/registry';
import { splitAnswerSentences, type AnswerSentenceUnit } from '../lang/sentences';
import { fixedText, type TextKey } from '../lang/texts';

const PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_]*\}/g;
/** A placeholder value in a notice or label is short; the matcher never looks further than this. */
const MAX_PLACEHOLDER_CHARS = 200;
/** A piece of a notice line shorter than this counts only when it is the whole line. */
const MIN_NOTICE_PIECE_CHARS = 8;
const QUESTION_MARKS: ReadonlySet<string> = new Set(['?', '？']);
const COLONS: ReadonlySet<string> = new Set([':', '：']);
const TRAILING_CLOSERS = /["'”’»」』)）\]】］*_\s]+$/u;
const LEADING_MARKUP = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s+)?/u;
const BOLD_RUN = /^\*\*([^*]+)\*\*\s*[:：]?$/u;

interface Template {
  /** Static pieces between placeholders; one piece when the text has none. */
  pieces: string[];
  line: string;
}

export interface ExemptionTexts {
  /** Every notice and label line of the language, normalized (D-19 "registry notice or label phrase"). */
  readonly templates: readonly Template[];
  readonly notCovered: string;
  /** Labels that open a part whose sentences are not from the documents. */
  readonly unsourcedLabels: ReadonlySet<string>;
  /** The label that opens the documents part again. */
  readonly sourcedLabels: ReadonlySet<string>;
}

export interface ExemptionContext {
  texts: ExemptionTexts;
  /** True inside a part headed by labels.from_web or labels.general_knowledge. */
  inUnsourcedPart: boolean;
}

/** A splitter unit, or one whose kind the record builder changed to `truncated`. */
export type ExemptionUnit = Pick<AnswerSentenceUnit, 'text'> & { kind: AnswerSentence['kind'] };

export interface SourceRange {
  start: number;
  end: number;
}

export interface SentenceRecordInput {
  text: string;
  part: number;
  language: string;
  /** The aliases of this request's AliasMap; a marker for any other alias never cites. */
  aliases: ReadonlySet<string>;
  /** Claude Citations: character ranges of the text that a source part covers. */
  sourceRanges?: readonly SourceRange[];
  /** The answer was cut at the output limit (D-33): the last unit is `truncated`. */
  truncated?: boolean;
}

/** D-23: SHA-256 of the persisted part text, lowercase hex; the client recomputes it before it shows marks. */
export function answerTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalize(text: string): string {
  return stripCitationMarkers(text).replace(LEADING_MARKUP, '').replace(/\*\*/g, '').replace(/\s+/gu, ' ').trim();
}

function templatesOf(text: string): Template[] {
  return text
    .split('\n')
    .map((line) => normalize(line))
    .filter((line) => line !== '')
    .map((line) => ({ line, pieces: line.split(PLACEHOLDER) }));
}

/** The registry texts the D-19 rules read, in `language` (with the fixedText fallback chain). */
export function exemptionTexts(language: string): ExemptionTexts {
  const templates: Template[] = [];
  for (const key of TEXT_KEYS) {
    if (!key.startsWith('notices.') && !key.startsWith('labels.')) continue;
    const raw = fixedText(key, language, placeholderEcho(key, language));
    templates.push(...templatesOf(raw));
  }
  const label = (key: TextKey) => normalize(fixedText(key, language));
  return {
    templates,
    notCovered: label('labels.not_covered'),
    unsourcedLabels: new Set([label('labels.from_web'), label('labels.general_knowledge')]),
    sourcedLabels: new Set([label('labels.from_documents')]),
  };
}

/** Fills every placeholder with itself, so the template keeps its `{name}` slots. */
function placeholderEcho(key: TextKey, language: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (;;) {
    try {
      fixedText(key, language, params);
      return params;
    } catch (error) {
      const parameter = (error as { parameter?: unknown }).parameter;
      if (typeof parameter !== 'string' || parameter in params) throw error;
      params[parameter] = `{${parameter}}`;
    }
  }
}

function matchesTemplate(unit: string, template: Template): boolean {
  if (template.pieces.length === 1) {
    if (unit === template.line) return true;
    return unit.length >= MIN_NOTICE_PIECE_CHARS && template.line.includes(unit);
  }
  if (unit.length > template.line.length + MAX_PLACEHOLDER_CHARS * (template.pieces.length - 1)) return false;
  const [first, ...rest] = template.pieces;
  if (!unit.startsWith(first!)) return false;
  let cursor = first!.length;
  for (let i = 0; i < rest.length; i += 1) {
    const piece = rest[i]!;
    const last = i === rest.length - 1;
    const at = last ? unit.length - piece.length : unit.indexOf(piece, cursor + 1);
    if (at < cursor + 1 || at - cursor > MAX_PLACEHOLDER_CHARS) return false;
    if (last && !unit.endsWith(piece)) return false;
    cursor = at + piece.length;
  }
  return true;
}

function lastChar(text: string): string {
  const trimmed = text.replace(TRAILING_CLOSERS, '');
  const chars = Array.from(trimmed);
  return chars[chars.length - 1] ?? '';
}

/** The registry part label a whole bold run equals (UI-SPEC 6.6), or null. */
function boldLabel(unit: AnswerSentenceUnit): string | null {
  const match = BOLD_RUN.exec(stripCitationMarkers(unit.text).trim());
  return match ? match[1]!.replace(/\s+/gu, ' ').trim() : null;
}

/**
 * D-19: a unit is exempt (not factual) when it is a heading, a code block, a truncated tail, a question, a lead-in ending in a colon, a
 * registry notice or label phrase, holds the not_covered statement, or lies in a part headed by the web or general-knowledge label.
 */
export function isExemptSentence(unit: ExemptionUnit, context: ExemptionContext): boolean {
  if (unit.kind === 'heading' || unit.kind === 'code' || unit.kind === 'truncated') return true;
  if (context.inUnsourcedPart) return true;
  const plain = stripCitationMarkers(unit.text).trim();
  const end = lastChar(plain);
  if (QUESTION_MARKS.has(end) || COLONS.has(end)) return true;
  const normalized = normalize(unit.text);
  if (normalized === '') return true;
  if (context.texts.notCovered !== '' && normalized.includes(context.texts.notCovered)) return true;
  return context.texts.templates.some((template) => matchesTemplate(normalized, template));
}

/**
 * D-19, D-23, D-33: the sentence records of one answer part. A unit is cited when a marker for an alias of this request lies inside it
 * (markers after the end punctuation belong to it, see splitAnswerSentences) or, on the Claude path, when a source range overlaps it.
 */
export function buildSentenceRecords(input: SentenceRecordInput): AnswerSentence[] {
  const { text, part, language, aliases, sourceRanges = [], truncated = false } = input;
  const units = splitAnswerSentences(text, language);
  if (units.length === 0) return [];
  const texts = exemptionTexts(language);
  const textHash = answerTextHash(text);
  const validStarts = findCitationMarkers(text)
    .filter((marker) => marker.aliases.some((alias) => aliases.has(alias)))
    .map((marker) => marker.start);

  let inUnsourcedPart = false;
  let marker = 0;
  return units.map((unit, i): AnswerSentence => {
    const kind: AnswerSentence['kind'] = truncated && i === units.length - 1 ? 'truncated' : unit.kind;
    const label = boldLabel(unit);
    if (label !== null && texts.unsourcedLabels.has(label)) inUnsourcedPart = true;
    else if (label !== null && texts.sourcedLabels.has(label)) inUnsourcedPart = false;

    while (marker < validStarts.length && validStarts[marker]! < unit.start) marker += 1;
    const markerInside = marker < validStarts.length && validStarts[marker]! < unit.end;
    const sourceOverlap = sourceRanges.some((range) => range.start < unit.end && range.end > unit.start);

    return {
      index: unit.index,
      part,
      start: unit.start,
      end: unit.end,
      kind,
      text_hash: textHash,
      factual: !isExemptSentence({ text: unit.text, kind }, { texts, inUnsourcedPart }),
      cited: markerInside || sourceOverlap,
      support: 'not_checked',
      scorer: null,
      reason: null,
    };
  });
}
