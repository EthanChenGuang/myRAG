/**
 * Phase 5.2.1 D-74, D-75, D-95: the deterministic check of one calculation in an answer.
 *
 * 1. The trace is recomputed with evaluateCalc, the evaluator the tool uses, over the aliases that have block text; a
 *    rejection is `not_verified` / `trace_invalid`.
 * 2. Every chunk operand value (each list value, conversion operands included) must equal a number found in its cited
 *    block, read in the block's language (the answer language when unknown); every question operand must be in the
 *    question, read in the answer language. An ISO date operand must occur literally. Otherwise `operand_not_located`.
 * 3. The stated number is the last number in the last sentence that cites one of the calculation's chunk aliases,
 *    skipping numbers equal to an operand or an intermediate step value (unless equal to the result); failing that, the
 *    candidate nearest to the trace's anchor (the removed block's position or the tool step's end; the text end when
 *    absent). None: `stated_not_found`.
 * 4. Within the declared rounding: when the result step rounds, the stated value equals that rounded value; otherwise
 *    it equals the recomputed value rounded half-even to the stated number's own decimal places (at most ten), at the
 *    scale of its magnitude word. Equal: `verified`; different: `corrected`.
 */
import { createHash } from 'node:crypto';
import { findCitationMarkers } from '@/lib/citations/marker-grammar';
import type { CalcCheck, CalcResult, CalcTrace } from '@/lib/rag-eval/contracts.generated';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { numberFormatFor } from '../lang/registry-fields';
import { splitAnswerSentences } from '../lang/sentences';
import { evaluateCalc } from './evaluate';
import { findNumbers, formatNumber, type NumberMatch } from './numbers';
import { DISPLAY_PLACES, display, divide, equals, fromBigInt, parseDecimal, rational, roundTo, type Rational } from './rational';

type Request = CalcTrace['request'];
type CheckReason = NonNullable<CalcCheck['reason']>;

export interface CheckInput {
  trace: CalcTrace;
  /** The answer text as persisted (citation markers included, the trailing block removed). */
  rawText: string;
  /** The text of a context block by alias; null when the request has no such block. */
  blockText: (alias: string) => string | null;
  /** The language of a block; null when unknown (the answer language is used). */
  blockLanguage: (alias: string) => string | null;
  question: string;
  answerLanguage: string;
}

export interface CalcCheckOutcome {
  check: CalcCheck;
  /** The recomputed value formatted in the answer language with its unit, for notices.calc_corrected; null otherwise. */
  noticeValue: string | null;
  /** The recomputed value formatted like noticeValue but without the unit, to replace stated_span; null unless corrected. */
  spanValue?: string | null;
}

export interface StatedNumberOptions {
  /** The chunk aliases of the calculation. */
  aliases: ReadonlySet<string>;
  /** Operand and intermediate step values that are never the stated number. */
  excluded: readonly Rational[];
  /** UTF-16 offset of the trace's anchor. */
  anchor: number;
  language: string;
  /** The result step's label; a sentence naming it states the result even when its number equals an operand. */
  resultLabel?: string | null;
}

/** The label the calculation gives its result step, or null. */
export function resultLabelOf(request: CalcTrace['request']): string | null {
  return request.steps.find((s) => s.id === request.result)?.label ?? null;
}

const ISO_DATE_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DECIMAL_STRING = /^-?[0-9]{1,30}(\.[0-9]{1,30})?$/;
const TEN = BigInt(10);

/** SHA-256 of the canonical JSON of the calculation request. */
export function traceHash(request: Request): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}

function parseExact(text: string): Rational {
  const slash = text.indexOf('/');
  return rational(BigInt(text.slice(0, slash)), BigInt(text.slice(slash + 1)));
}

function pow10(power: number): Rational {
  return fromBigInt(TEN ** BigInt(power));
}

/** Whether a written number shows `target` at its own precision (D-95); `exactOnly` when a round step declared the rounding. */
function shows(match: NumberMatch, target: Rational, exactOnly: boolean): boolean {
  if (exactOnly) return equals(match.value, target);
  const places = match.places < DISPLAY_PLACES ? match.places : DISPLAY_PLACES;
  if (match.power === 0) return equals(roundTo(target, places, 'half_even'), match.value);
  const scale = pow10(match.power);
  return equals(roundTo(divide(target, scale), places, 'half_even'), divide(match.value, scale));
}

function containsValue(matches: readonly NumberMatch[], value: Rational): boolean {
  return matches.some((m) => equals(m.value, value));
}

function chunkAliases(request: Request): Set<string> {
  const aliases = new Set<string>();
  for (const operand of request.operands) {
    if (operand.source.kind === 'chunk' && operand.source.alias !== undefined) aliases.add(operand.source.alias);
  }
  return aliases;
}

function operandValues(operand: Request['operands'][number]): Rational[] {
  if (operand.values !== undefined) return operand.values.map((v) => parseDecimal(v));
  if (operand.value !== undefined && !ISO_DATE_SHAPE.test(operand.value)) return [parseDecimal(operand.value)];
  return [];
}

/** Every operand occurs in its source text (D-74 step 2). */
function operandsLocated(input: CheckInput): boolean {
  const cache = new Map<string, { text: string; numbers: NumberMatch[] }>();
  const sourceFor = (key: string, text: string, language: string) => {
    let entry = cache.get(key);
    if (!entry) {
      entry = { text, numbers: findNumbers(text, numberFormatFor(language)) };
      cache.set(key, entry);
    }
    return entry;
  };
  for (const operand of input.trace.request.operands) {
    let source: { text: string; numbers: NumberMatch[] };
    if (operand.source.kind === 'question') {
      source = sourceFor('question', input.question, input.answerLanguage);
    } else if (operand.source.kind === 'chunk' && operand.source.alias !== undefined) {
      const alias = operand.source.alias;
      const text = input.blockText(alias);
      if (text === null) return false;
      source = sourceFor(`block:${alias}`, text, input.blockLanguage(alias) ?? input.answerLanguage);
    } else {
      return false;
    }
    if (operand.value !== undefined && ISO_DATE_SHAPE.test(operand.value)) {
      if (!source.text.includes(operand.value)) return false;
      continue;
    }
    for (const value of operandValues(operand)) if (!containsValue(source.numbers, value)) return false;
  }
  return true;
}

function isExcluded(match: NumberMatch, excluded: readonly Rational[]): boolean {
  return excluded.some((v) => equals(v, match.value));
}

const MIN_LABEL_LENGTH = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type AnswerUnit = ReturnType<typeof splitAnswerSentences>[number];

function labelPattern(resultLabel: string | null | undefined): RegExp | null {
  const label = (resultLabel ?? '').trim();
  return [...label].length < MIN_LABEL_LENGTH ? null : new RegExp(escapeRegExp(label), 'giu');
}

/**
 * D-95 detail (05.2.1-23): in a sentence that names the result step's label, the numbers after the label's last
 * occurrence state the result: the last candidate among them, else the first of them (a wrong total can equal an operand
 * or an intermediate, such as a cap applied to the sum, which the candidate filter alone would skip). Null when the
 * sentence does not name the label or no number follows it.
 */
function afterLabel(unit: AnswerUnit, all: readonly NumberMatch[], excluded: readonly Rational[], label: RegExp): NumberMatch | null {
  let after = -1;
  for (const match of unit.text.matchAll(label)) after = unit.start + (match.index ?? 0) + match[0].length;
  if (after < 0) return null;
  const following = all.filter((m) => m.start >= after && m.end <= unit.end);
  if (following.length === 0) return null;
  const candidates = following.filter((m) => !isExcluded(m, excluded));
  return candidates.length > 0 ? candidates[candidates.length - 1] : following[0];
}

/**
 * D-95: the stated number of a calculation in the answer text, or null. The last citing sentence decides (after the result
 * step's label when it names it, else its last candidate); failing that, the last sentence naming the label; failing that,
 * the candidate nearest to the anchor.
 */
export function locateStatedNumber(rawText: string, options: StatedNumberOptions): NumberMatch | null {
  const all = findNumbers(rawText, numberFormatFor(options.language));
  if (all.length === 0) return null;
  const numbers = all.filter((m) => !isExcluded(m, options.excluded));
  const label = labelPattern(options.resultLabel);
  const units = splitAnswerSentences(rawText, options.language);
  for (let u = units.length - 1; u >= 0; u -= 1) {
    const unit = units[u];
    const cites = findCitationMarkers(unit.text).some((marker) => marker.aliases.some((a) => options.aliases.has(a)));
    if (!cites) continue;
    const named = label ? afterLabel(unit, all, options.excluded, label) : null;
    if (named) return named;
    for (let k = numbers.length - 1; k >= 0; k -= 1) {
      const m = numbers[k];
      if (m.start >= unit.start && m.end <= unit.end) return m;
    }
  }
  if (label) {
    for (let u = units.length - 1; u >= 0; u -= 1) {
      const named = afterLabel(units[u], all, options.excluded, label);
      if (named) return named;
    }
  }
  if (numbers.length === 0) return null;
  let best: NumberMatch | null = null;
  let bestDistance = 0;
  for (const m of numbers) {
    const distance = m.end <= options.anchor ? options.anchor - m.end : m.start >= options.anchor ? m.start - options.anchor : 0;
    if (best === null || distance < bestDistance) {
      best = m;
      bestDistance = distance;
    }
  }
  return best;
}

function baseCheck(trace: CalcTrace, hash: string): CalcCheck {
  return {
    status: 'not_verified',
    stated: null,
    recomputed: null,
    unit: null,
    trace_hash: hash,
    origin: trace.origin,
    reason: null,
    stated_span: null,
  };
}

function notVerified(check: CalcCheck, reason: CheckReason): CalcCheckOutcome {
  return { check: { ...check, status: 'not_verified', reason }, noticeValue: null };
}

function fractionDigits(decimal: string): number {
  const point = decimal.indexOf('.');
  return point < 0 ? 0 : decimal.length - point - 1;
}

/** Recomputes over the aliases that have block text; the tool's own result is never trusted. */
function recompute(input: CheckInput): CalcResult {
  const aliases = new Set<string>();
  for (const alias of chunkAliases(input.trace.request)) if (input.blockText(alias) !== null) aliases.add(alias);
  return evaluateCalc(input.trace.request, { aliases });
}

interface Recomputed {
  exact: Rational;
  /** Places of the result step's own rounding, or null when it does not round. */
  roundPlaces: number | null;
  intermediates: Rational[];
}

function recomputedValues(request: Request, result: CalcResult): Recomputed {
  const steps = result.steps ?? [];
  const final = steps.find((s) => s.id === request.result);
  if (!final) throw new Error('[Calc] the result step is missing from the recomputed steps');
  const declared = request.steps.find((s) => s.id === request.result);
  return {
    exact: parseExact(final.exact),
    roundPlaces: declared?.rounding ? declared.rounding.places : null,
    intermediates: steps.filter((s) => s.id !== request.result).map((s) => parseExact(s.exact)),
  };
}

/** D-74, D-75, D-95: classifies one calculation as verified, corrected or not_verified. */
export function checkCalculation(input: CheckInput): CalcCheckOutcome {
  const { trace } = input;
  const base = baseCheck(trace, traceHash(trace.request));
  const result = recompute(input);
  if (result.status !== 'ok' || result.value === null) return notVerified(base, 'trace_invalid');

  const recomputed = recomputedValues(trace.request, result);
  const withValue: CalcCheck = { ...base, recomputed: result.value, unit: result.unit };
  if (!operandsLocated(input)) return notVerified(withValue, 'operand_not_located');

  const excluded: Rational[] = [];
  for (const operand of trace.request.operands) excluded.push(...operandValues(operand));
  excluded.push(...recomputed.intermediates);
  const candidates = excluded.filter((v) => !equals(v, recomputed.exact));
  const stated = locateStatedNumber(input.rawText, {
    aliases: chunkAliases(trace.request),
    excluded: candidates,
    anchor: trace.anchor_offset ?? input.rawText.length,
    language: input.answerLanguage,
    resultLabel: resultLabelOf(trace.request),
  });
  if (stated === null) return notVerified(withValue, 'stated_not_found');
  const statedText = display(stated.value).display;
  if (!DECIMAL_STRING.test(statedText)) return notVerified(withValue, 'stated_not_found');

  const located: CalcCheck = { ...withValue, stated: statedText, stated_span: { start: stated.start, end: stated.end } };
  if (shows(stated, recomputed.exact, recomputed.roundPlaces !== null)) {
    return { check: { ...located, status: 'verified' }, noticeValue: null };
  }
  const places =
    recomputed.roundPlaces ?? (stated.power === 0 && stated.places <= DISPLAY_PLACES ? stated.places : fractionDigits(result.value));
  const format = numberFormatFor(input.answerLanguage);
  const noticeValue = formatNumber(recomputed.exact, places, format, result.unit);
  return { check: { ...located, status: 'corrected' }, noticeValue, spanValue: formatNumber(recomputed.exact, places, format) };
}

/**
 * Eval observation: every labelled step other than the result shows its recomputed value in the answer before `before`
 * (the stated number's start; the text end by default). False for a rejected result.
 */
export function stepsListed(rawText: string, trace: CalcTrace, result: CalcResult, language: string, before?: number): boolean {
  if (result.status !== 'ok') return false;
  const limit = before ?? rawText.length;
  const numbers = findNumbers(rawText, numberFormatFor(language)).filter((m) => m.start < limit);
  const steps = result.steps ?? [];
  for (const declared of trace.request.steps) {
    if (declared.id === trace.request.result || declared.label === undefined) continue;
    const reported = steps.find((s) => s.id === declared.id);
    if (!reported) return false;
    const exact = parseExact(reported.exact);
    if (!numbers.some((m) => shows(m, exact, false))) return false;
  }
  return true;
}
