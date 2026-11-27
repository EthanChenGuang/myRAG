/**
 * Phase 5.2.1 D-74, RESEARCH Pitfall C4: numbers located in text by one linear scan driven by the registry `number_format`
 * of the text's language (grouping characters, decimal marks, full-width digits, magnitude words). Every behaviour comes
 * from that data; there is no per-language branch. Values are exact rationals, never floats.
 *
 * A number starts at a digit that does not follow another digit or a cased letter (so `S12` and `v2` are identifiers),
 * takes grouping only between whole digit groups (first group of one to three digits, then groups of exactly three) and a
 * decimal mark followed by a digit. A run that a grouping character or decimal mark continues in a way the format does not
 * allow (`1,25` in a format with `,` grouping) is malformed and skipped as a whole, so no value inside a longer number is
 * ever matched. Citation markers and URLs are skipped. A number written in words is never found.
 */
import { findCitationMarkers } from '@/lib/citations/marker-grammar';
import type { NumberFormat } from '../lang/registry-fields';
import { rational, toDecimalString, type Rational } from './rational';

export interface NumberMatch {
  /** UTF-16 code-unit offsets; `end` is after the last digit or the magnitude word (a percent sign is only flagged). */
  start: number;
  end: number;
  value: Rational;
  raw: string;
  percent: boolean;
  /** Fractional digits as written, before the magnitude word applies. */
  places: number;
  /** The power of ten of the magnitude word, 0 without one. */
  power: number;
}

/** Optional step counter for the linear-time test. */
export interface ScanStats {
  steps: number;
}

/** Longer digit runs are skipped: the evaluator accepts at most 60 digits per operand (CalcLimits bound). */
const MAX_NUMBER_DIGITS = 60;

const ZERO_CODE = 48;
const NINE_CODE = 57;
const FULLWIDTH_ZERO = 0xff10;
const FULLWIDTH_NINE = 0xff19;
const TEN = BigInt(10);

/** Typographic spaces that stand for each other as a grouping character; a plain space groups only when listed itself. */
const TYPOGRAPHIC_SPACES = ['\u00A0', '\u2009', '\u202F'];
const HORIZONTAL_SPACE = new Set([' ', '\t', '\u00A0', '\u2009', '\u202F', '\u3000']);
const SIGNS = new Set(['-', '\u2212']);
const SIGN_PRECEDERS = new Set(['(', '=', ':']);
const PERCENT_SIGNS = new Set(['%', '\uFF05']);
const CASED_LETTER = /[\p{Lu}\p{Ll}\p{Lt}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`()[\]{}【】［］「」]+/giu;

interface Magnitude {
  word: string;
  power: number;
  /** Whole-word rule: a word of cased letters must not be followed by a letter or digit. */
  wholeWord: boolean;
}

interface Prepared {
  groups: ReadonlySet<string>;
  decimals: ReadonlySet<string>;
  fullwidth: boolean;
  magnitudes: readonly Magnitude[];
}

const PREPARED = new WeakMap<NumberFormat, Prepared>();

function prepare(format: NumberFormat): Prepared {
  const cached = PREPARED.get(format);
  if (cached) return cached;
  const groups = new Set<string>();
  for (const sep of format.group_separators) {
    groups.add(sep);
    if (HORIZONTAL_SPACE.has(sep)) for (const variant of TYPOGRAPHIC_SPACES) groups.add(variant);
  }
  const magnitudes = format.magnitude_words
    .map((m) => {
      const word = m.word.toLowerCase();
      return { word, power: m.power, wholeWord: CASED_LETTER.test(m.word) };
    })
    .sort((a, b) => b.word.length - a.word.length);
  const prepared: Prepared = {
    groups,
    decimals: new Set(format.decimal_marks),
    fullwidth: format.fullwidth_digits === true,
    magnitudes,
  };
  PREPARED.set(format, prepared);
  return prepared;
}

function digitAt(text: string, i: number, fullwidth: boolean): number {
  if (i < 0 || i >= text.length) return -1;
  const code = text.charCodeAt(i);
  if (code >= ZERO_CODE && code <= NINE_CODE) return code - ZERO_CODE;
  if (fullwidth && code >= FULLWIDTH_ZERO && code <= FULLWIDTH_NINE) return code - FULLWIDTH_ZERO;
  return -1;
}

interface Skip {
  start: number;
  end: number;
}

function skipSpans(text: string): Skip[] {
  const spans: Skip[] = findCitationMarkers(text).map((m) => ({ start: m.start, end: m.end }));
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** A grouping character or decimal mark that is not a space; only these can make a run malformed. */
function isJoiner(c: string, p: Prepared): boolean {
  return (p.groups.has(c) && !HORIZONTAL_SPACE.has(c)) || p.decimals.has(c);
}

/**
 * Finds every number in `text` written in `format`. Linear in the text length: each character is visited a bounded
 * number of times (no backtracking regular expression).
 */
export function findNumbers(text: string, format: NumberFormat, stats?: ScanStats): NumberMatch[] {
  const p = prepare(format);
  const out: NumberMatch[] = [];
  const skips = skipSpans(text);
  let skipIndex = 0;
  let steps = 0;
  const n = text.length;

  const isDigit = (i: number): boolean => digitAt(text, i, p.fullwidth) >= 0;

  /** The end of a run of digits joined by grouping characters or decimal marks, from a digit at `i`. */
  const endOfRun = (i: number): number => {
    let j = i;
    while (j < n) {
      steps += 1;
      if (isDigit(j)) j += 1;
      else if (isJoiner(text[j], p) && isDigit(j + 1)) j += 1;
      else break;
    }
    return j;
  };

  const readDigits = (i: number, into: string[]): number => {
    let j = i;
    while (j < n) {
      steps += 1;
      const d = digitAt(text, j, p.fullwidth);
      if (d < 0) break;
      into.push(String.fromCharCode(ZERO_CODE + d));
      j += 1;
    }
    return j;
  };

  let i = 0;
  while (i < n) {
    steps += 1;
    while (skipIndex < skips.length && skips[skipIndex].end <= i) skipIndex += 1;
    if (skipIndex < skips.length && skips[skipIndex].start <= i) {
      i = skips[skipIndex].end;
      continue;
    }
    if (!isDigit(i)) {
      i += 1;
      continue;
    }
    const prev = i > 0 ? text[i - 1] : '';
    if (isDigit(i - 1) || CASED_LETTER.test(prev)) {
      i = endOfRun(i);
      continue;
    }

    const intDigits: string[] = [];
    let j = readDigits(i, intDigits);
    if (intDigits.length <= 3) {
      while (j < n && p.groups.has(text[j]) && isDigit(j + 1) && isDigit(j + 2) && isDigit(j + 3) && !isDigit(j + 4)) {
        steps += 1;
        j = readDigits(j + 1, intDigits);
      }
    }
    const fracDigits: string[] = [];
    if (j < n && p.decimals.has(text[j]) && isDigit(j + 1)) j = readDigits(j + 1, fracDigits);
    if (j < n && isJoiner(text[j], p) && isDigit(j + 1)) {
      i = endOfRun(j);
      continue;
    }
    if (intDigits.length + fracDigits.length > MAX_NUMBER_DIGITS) {
      i = j;
      continue;
    }

    let start = i;
    let negative = false;
    if (i > 0 && SIGNS.has(text[i - 1])) {
      const before = i - 2;
      const atBoundary = before < 0 || HORIZONTAL_SPACE.has(text[before]) || text[before] === '\n' || SIGN_PRECEDERS.has(text[before]);
      let k = before;
      while (k >= 0 && (HORIZONTAL_SPACE.has(text[k]) || text[k] === '\n')) {
        steps += 1;
        k -= 1;
      }
      if (atBoundary && (k < 0 || !isDigit(k))) {
        negative = true;
        start = i - 1;
      }
    }

    let power = 0;
    const wordAt = j < n && HORIZONTAL_SPACE.has(text[j]) ? j + 1 : j;
    for (const m of p.magnitudes) {
      steps += 1;
      const end = wordAt + m.word.length;
      if (end > n || text.slice(wordAt, end).toLowerCase() !== m.word) continue;
      if (m.wholeWord && end < n && LETTER_OR_DIGIT.test(text[end])) continue;
      power = m.power;
      j = end;
      break;
    }

    const percentAt = j < n && HORIZONTAL_SPACE.has(text[j]) ? j + 1 : j;
    const percent = percentAt < n && PERCENT_SIGNS.has(text[percentAt]);

    const magnitude = BigInt(intDigits.join('') + fracDigits.join('')) * TEN ** BigInt(power);
    const value = rational(negative ? -magnitude : magnitude, TEN ** BigInt(fracDigits.length));
    out.push({ start, end: j, value, raw: text.slice(start, j), percent, places: fracDigits.length, power });
    i = j;
  }
  if (stats) stats.steps += steps;
  return out;
}

/** The value rounded half-even at `places`, with the format's first grouping character and decimal mark, then the unit. */
export function formatNumber(value: Rational, places: number, format: NumberFormat, unit?: string | null): string {
  const text = toDecimalString(value, places, 'half_even');
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const point = body.indexOf('.');
  const intPart = point < 0 ? body : body.slice(0, point);
  const fracPart = point < 0 ? '' : body.slice(point + 1);
  const group = format.group_separators[0] ?? '';
  const mark = format.decimal_marks[0] ?? '.';
  let grouped = '';
  for (let k = 0; k < intPart.length; k += 1) {
    if (k > 0 && (intPart.length - k) % 3 === 0) grouped += group;
    grouped += intPart[k];
  }
  let out = (negative ? '-' : '') + grouped + (fracPart ? mark + fracPart : '');
  const label = typeof unit === 'string' ? unit.trim() : '';
  if (label) out += PERCENT_SIGNS.has(label) ? label : ` ${label}`;
  return out;
}
