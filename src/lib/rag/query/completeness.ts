import { normalizeLexical } from '../lexical/tokenize';
import { keepsProtectedTokens } from './protected';
import lexicon from './rewrite-gate.lexicon.json';
import type { GateResult } from './rewrite-gate';

/** D-04: sibling substitution only swaps a term for another of the same class. */
export type RequiredTermClass = 'protected' | 'period' | 'scope' | 'entity';

/**
 * One term the decomposition must keep. `surface` is the text as written in the decomposed question; `forms` are the
 * folded match keys (several for a vocabulary value with aliases). Protected tokens match verbatim (keepsProtectedTokens).
 */
export interface RequiredTerm {
  cls: RequiredTermClass;
  surface: string;
  forms: readonly string[];
  verbatim: boolean;
}

export type CompletenessAction = 'ok' | 'added' | 'discarded';

/** D-04, T-06.2-17: counts and the action only, never a term. */
export interface CompletenessRecord {
  required_count: number;
  missing_count: number;
  action: CompletenessAction;
}

export type RequiredTermGate = Pick<GateResult, 'protectedTokens'>;

type Span = { start: number; end: number };

const YEAR = new RegExp(lexicon.patterns.year, 'gu');
const EXPLICIT_DATES = lexicon.patterns.explicit_date.map((source) => new RegExp(source, 'gu'));
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The one folding for lexical classes: normalizeLexical plus whitespace collapsed and no space after an apostrophe. */
export function foldTerm(text: string): string {
  return normalizeLexical(text).replace(/'\s+/gu, "'").replace(/\s+/gu, ' ').trim();
}

function overlaps(spans: readonly Span[], span: Span): boolean {
  return spans.some((other) => other.start < span.end && span.start < other.end);
}

function regexSpans(text: string, regex: RegExp): Array<Span & { text: string }> {
  const out: Array<Span & { text: string }> = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    out.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return out;
}

/** True when `form` occurs in folded `text` with no letter or digit glued to a Latin or digit edge. */
function containsForm(folded: string, form: string): boolean {
  if (form === '') return false;
  let from = 0;
  while (from <= folded.length) {
    const index = folded.indexOf(form, from);
    if (index < 0) return false;
    const before = index > 0 ? folded[index - 1] : '';
    const after = folded[index + form.length] ?? '';
    const edgeStart = WORD_CHAR.test(form[0]) && !/\p{Script=Han}/u.test(form[0]);
    const edgeEnd = WORD_CHAR.test(form[form.length - 1]) && !/\p{Script=Han}/u.test(form[form.length - 1]);
    const okBefore = !edgeStart || before === '' || !WORD_CHAR.test(before) || /\p{Script=Han}/u.test(before);
    const okAfter = !edgeEnd || after === '' || !WORD_CHAR.test(after) || /\p{Script=Han}/u.test(after);
    if (okBefore && okAfter) return true;
    from = index + 1;
  }
  return false;
}

/** Whether a sub-question keeps the term: verbatim for protected tokens, folded (normalizeLexical) for every other class. */
export function containsTerm(text: string, term: RequiredTerm): boolean {
  if (term.verbatim) return keepsProtectedTokens(text, [term.surface]);
  const folded = foldTerm(text);
  return term.forms.some((form) => containsForm(folded, form));
}

/** The raw span of the first occurrence of the term in `text`, so a clone can replace exactly that surface. */
function locate(text: string, term: RequiredTerm): Span | null {
  if (term.verbatim) {
    const index = text.normalize('NFC').indexOf(term.surface.normalize('NFC'));
    return index < 0 ? null : { start: index, end: index + term.surface.normalize('NFC').length };
  }
  const chars = Array.from(text);
  const offsets: number[] = [];
  let offset = 0;
  for (const ch of chars) {
    offsets.push(offset);
    offset += ch.length;
  }
  offsets.push(offset);
  const isWord = (i: number) => i >= 0 && i < chars.length && WORD_CHAR.test(chars[i]);
  const isHan = (i: number) => i >= 0 && i < chars.length && /\p{Script=Han}/u.test(chars[i]);
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (isWord(i) && (isHan(i) || !isWord(i - 1) || isHan(i - 1))) starts.push(i);
    if (isWord(i) && (isHan(i) || !isWord(i + 1) || isHan(i + 1))) ends.push(i + 1);
  }
  const longest = Math.max(...term.forms.map((form) => Array.from(form).length));
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) continue;
      if (end - start > 2 * longest + 4) break;
      const slice = text.slice(offsets[start], offsets[end]);
      if (term.forms.includes(foldTerm(slice))) return { start: offsets[start], end: offsets[end] };
    }
  }
  return null;
}

/**
 * D-03: the terms a decomposition of `query` must keep. Classes from a seam that is absent contribute nothing; no model,
 * no LLM call, no built-in domain list. Overlapping finds keep the first class in this order: protected tokens, then
 * periods (explicit dates and years), so a year inside a date is not counted twice.
 */
export function collectRequiredTerms(query: string, gate: RequiredTermGate): RequiredTerm[] {
  const terms: RequiredTerm[] = [];
  const taken: Span[] = [];
  const seen = new Set<string>();
  const push = (term: RequiredTerm, span: Span | null) => {
    const key = `${term.verbatim ? 'v' : 'f'}:${term.verbatim ? term.surface : term.forms[0]}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
    if (span) taken.push(span);
  };

  const dates = EXPLICIT_DATES.flatMap((regex) => regexSpans(query, regex));
  const dateTexts = new Set(dates.map((date) => date.text));
  for (const token of gate.protectedTokens) {
    const isDate = dateTexts.has(token);
    const index = query.indexOf(token);
    push(
      { cls: isDate ? 'period' : 'protected', surface: token, forms: [token], verbatim: true },
      index < 0 ? null : { start: index, end: index + token.length },
    );
  }
  for (const date of dates) {
    if (overlaps(taken, date)) continue;
    push({ cls: 'period', surface: date.text, forms: [date.text], verbatim: true }, date);
  }
  for (const year of regexSpans(query, YEAR)) {
    if (overlaps(taken, year)) continue;
    push({ cls: 'period', surface: year.text, forms: [foldTerm(year.text)], verbatim: false }, year);
  }
  return terms;
}

export interface CompletenessInput {
  /** The decomposed question (the standalone query); added whole when no sibling can be cloned. */
  original: string;
  subQuestions: readonly string[];
  required: readonly RequiredTerm[];
  maxSubQuestions: number;
}

export interface CompletenessOutcome {
  subQuestions: string[];
  completeness: CompletenessRecord;
}

function sameText(a: string, b: string): boolean {
  return a.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase() === b.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * D-04: every required term must occur in at least one sub-question. Repair in order: (1) clone the first sub-question that
 * holds a sibling of the same class and substitute the missing term's surface; (2) otherwise add the original question;
 * (3) when the repaired list would exceed maxSubQuestions, discard the decomposition (empty list, original query only).
 */
export function checkDecompositionCompleteness(input: CompletenessInput): CompletenessOutcome {
  const { original, required, maxSubQuestions } = input;
  const list = [...input.subQuestions];
  const missing = required.filter((term) => !list.some((question) => containsTerm(question, term)));
  const record = (action: CompletenessAction): CompletenessRecord => ({
    required_count: required.length,
    missing_count: missing.length,
    action,
  });
  if (missing.length === 0) return { subQuestions: list, completeness: record('ok') };

  const originalCount = input.subQuestions.length;
  for (const term of missing) {
    if (list.some((question) => containsTerm(question, term))) continue;
    let repaired: string | null = null;
    for (const question of list) {
      const sibling = required.find((other) => other !== term && other.cls === term.cls && containsTerm(question, other));
      if (!sibling) continue;
      const span = locate(question, sibling);
      if (!span) continue;
      const clone = `${question.slice(0, span.start)}${term.surface}${question.slice(span.end)}`;
      if (!containsTerm(clone, term) || list.some((existing) => sameText(existing, clone))) continue;
      repaired = clone;
      break;
    }
    if (repaired === null) {
      if (list.some((existing) => sameText(existing, original))) continue;
      repaired = original;
    }
    list.push(repaired);
  }
  if (list.length > maxSubQuestions && list.length > originalCount) return { subQuestions: [], completeness: record('discarded') };
  return { subQuestions: list, completeness: record('added') };
}
