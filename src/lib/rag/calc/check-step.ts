/**
 * Phase 5.2.1 D-73, D-75: the per-answer calculation check, one pure synchronous call for the chat, embed, eval and
 * voice paths. Every trace whose tool result is ok, and every trailing-block trace, is checked with checkCalculation;
 * each invalid trailing block is `not_verified` / `trace_invalid`. When a calculation was offered and no checkable trace
 * or invalid block exists, an answer number that occurs neither in the question nor in any block is `not_verified` /
 * `trace_missing`. Corrected maps to notices.calc_corrected with the recomputed value, not_verified to
 * notices.calc_not_verified (identical notices once), with review reasons calc_mismatch and calc_unverified once each.
 * Never throws (an internal error is `check_error`); streamed text is never rewritten.
 */
import type { AnswerNotice, CalcCheck, CalcTrace } from '@/lib/rag-eval/contracts.generated';
import { numberFormatFor } from '../lang/registry-fields';
import { emitNotice } from '../generation/notices';
import { checkCalculation } from './check';
import { findNumbers, type NumberMatch } from './numbers';
import { display, equals } from './rational';

export type CalcReviewReason = 'calc_mismatch' | 'calc_unverified';

export interface CalcBlock {
  alias: string;
  text: string;
  /** The block's language; the answer language is used when absent. */
  language?: string | null;
}

export interface RunCalcChecksInput {
  /** The turn's traces in order (tool calls and trailing blocks). */
  traces: readonly CalcTrace[];
  /** Invalid trailing blocks: a count or the holder's list of markers. */
  invalid?: number | readonly unknown[];
  /** Whether the calculation tool or block instruction was offered this turn. */
  offered: boolean;
  rawText: string;
  blocks: readonly CalcBlock[];
  question: string;
  answerLanguage: string;
}

export interface CalcChecksOutcome {
  checks: CalcCheck[];
  /** The last calculation's check, or null. */
  primary: CalcCheck | null;
  notices: AnswerNotice[];
  reviewReasons: CalcReviewReason[];
}

const DECIMAL_STRING = /^-?[0-9]{1,30}(\.[0-9]{1,30})?$/;
const LIST_MARKER_PREFIX = /(?:^|\n)[ \t]*$/;
const LIST_MARKER_SUFFIX = /^[.)][ \t]/;

function emptyCheck(reason: NonNullable<CalcCheck['reason']>, origin: CalcCheck['origin']): CalcCheck {
  return { status: 'not_verified', stated: null, recomputed: null, unit: null, trace_hash: null, origin, reason, stated_span: null };
}

function invalidCount(invalid: RunCalcChecksInput['invalid']): number {
  if (Array.isArray(invalid)) return invalid.length;
  return typeof invalid === 'number' && invalid > 0 ? invalid : 0;
}

/** True for an ordered-list marker such as "1." at the start of a line. */
function isListMarker(text: string, m: NumberMatch): boolean {
  return LIST_MARKER_PREFIX.test(text.slice(m.start > 40 ? m.start - 40 : 0, m.start)) && LIST_MARKER_SUFFIX.test(text.slice(m.end, m.end + 2));
}

/** D-73/D-75: the first answer number that occurs neither in the question nor in any block, or null. */
function unsupportedNumber(input: RunCalcChecksInput): NumberMatch | null {
  const language = input.answerLanguage;
  const known = [
    ...findNumbers(input.question, numberFormatFor(language)),
    ...input.blocks.flatMap((b) => findNumbers(b.text, numberFormatFor(b.language ?? language))),
  ];
  for (const m of findNumbers(input.rawText, numberFormatFor(language))) {
    if (isListMarker(input.rawText, m)) continue;
    if (!known.some((k) => equals(k.value, m.value))) return m;
  }
  return null;
}

function traceMissing(match: NumberMatch): CalcCheck {
  const stated = display(match.value).display;
  return {
    ...emptyCheck('trace_missing', null),
    stated: DECIMAL_STRING.test(stated) ? stated : null,
    stated_span: { start: match.start, end: match.end },
  };
}

interface Classified {
  check: CalcCheck;
  noticeValue: string | null;
}

function checkTraces(input: RunCalcChecksInput): Classified[] {
  const blockByAlias = new Map<string, CalcBlock>();
  for (const block of input.blocks) blockByAlias.set(block.alias, block);
  const out: Classified[] = [];
  for (const trace of input.traces) {
    try {
      if (trace.result?.status !== 'ok' && trace.origin !== 'trailing_block') continue;
      out.push(
        checkCalculation({
          trace,
          rawText: input.rawText,
          blockText: (alias) => blockByAlias.get(alias)?.text ?? null,
          blockLanguage: (alias) => blockByAlias.get(alias)?.language ?? null,
          question: input.question,
          answerLanguage: input.answerLanguage,
        }),
      );
    } catch {
      let origin: CalcCheck['origin'] = null;
      try {
        origin = trace.origin === 'tool' || trace.origin === 'trailing_block' ? trace.origin : null;
      } catch {
        origin = null;
      }
      out.push({ check: emptyCheck('check_error', origin), noticeValue: null });
    }
  }
  return out;
}

function classify(input: RunCalcChecksInput): Classified[] {
  const classified = checkTraces(input);
  for (let k = invalidCount(input.invalid); k > 0; k -= 1) {
    classified.push({ check: emptyCheck('trace_invalid', 'trailing_block'), noticeValue: null });
  }
  if (classified.length === 0 && input.offered) {
    const match = unsupportedNumber(input);
    if (match) classified.push({ check: traceMissing(match), noticeValue: null });
  }
  return classified;
}

function noticesFor(classified: readonly Classified[], language: string): AnswerNotice[] {
  const notices: AnswerNotice[] = [];
  const seen = new Set<string>();
  for (const { check, noticeValue } of classified) {
    let notice: AnswerNotice | null = null;
    if (check.status === 'corrected' && noticeValue !== null) notice = emitNotice('calc_corrected', { language, params: { value: noticeValue } });
    else if (check.status === 'not_verified') notice = emitNotice('calc_not_verified', { language });
    if (!notice) continue;
    const key = `${notice.kind}\n${notice.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notices.push(notice);
  }
  return notices;
}

function reasonsFor(checks: readonly CalcCheck[]): CalcReviewReason[] {
  const reasons: CalcReviewReason[] = [];
  if (checks.some((c) => c.status === 'corrected')) reasons.push('calc_mismatch');
  if (checks.some((c) => c.status === 'not_verified')) reasons.push('calc_unverified');
  return reasons;
}

function outcome(classified: readonly Classified[], language: string): CalcChecksOutcome {
  const checks = classified.map((c) => c.check);
  return { checks, primary: checks.length > 0 ? checks[checks.length - 1] : null, notices: noticesFor(classified, language), reviewReasons: reasonsFor(checks) };
}

function log(checks: readonly CalcCheck[]): void {
  if (checks.length === 0) return;
  console.log('[Calc] check', { checks: checks.length, statuses: checks.map((c) => c.status), reasons: checks.map((c) => c.reason) });
}

/** D-73, D-75: checks every calculation of one answer; never throws. */
export function runCalcChecks(input: RunCalcChecksInput): CalcChecksOutcome {
  let result: CalcChecksOutcome;
  try {
    result = outcome(classify(input), input.answerLanguage);
  } catch {
    const checks = [emptyCheck('check_error', null)];
    let notices: AnswerNotice[] = [];
    try {
      notices = [emitNotice('calc_not_verified', { language: typeof input?.answerLanguage === 'string' ? input.answerLanguage : '' })];
    } catch {
      notices = [];
    }
    result = { checks, primary: checks[0], notices, reviewReasons: ['calc_unverified'] };
  }
  try {
    log(result.checks);
  } catch {
    // logging never fails the check
  }
  return result;
}
