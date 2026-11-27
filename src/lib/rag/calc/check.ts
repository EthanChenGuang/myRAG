import type { CalcCheck, CalcResult, CalcTrace } from '@/lib/rag-eval/contracts.generated';
import type { NumberMatch } from './numbers';
import type { Rational } from './rational';

export interface CheckInput {
  trace: CalcTrace;
  rawText: string;
  blockText: (alias: string) => string | null;
  blockLanguage: (alias: string) => string | null;
  question: string;
  answerLanguage: string;
}

export interface CalcCheckOutcome {
  check: CalcCheck;
  noticeValue: string | null;
}

export interface StatedNumberOptions {
  aliases: ReadonlySet<string>;
  excluded: readonly Rational[];
  anchor: number;
  language: string;
}

export function traceHash(_request: CalcTrace['request']): string {
  return '';
}

export function locateStatedNumber(_rawText: string, _options: StatedNumberOptions): NumberMatch | null {
  return null;
}

export function checkCalculation(_input: CheckInput): CalcCheckOutcome {
  return { check: { status: 'verified', stated: null, recomputed: null, unit: null, trace_hash: null, origin: null, reason: null, stated_span: null }, noticeValue: null };
}

export function stepsListed(_rawText: string, _trace: CalcTrace, _result: CalcResult, _language: string, _before?: number): boolean {
  return false;
}
