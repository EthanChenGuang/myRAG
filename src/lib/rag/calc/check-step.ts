import type { AnswerNotice, CalcCheck, CalcTrace } from '@/lib/rag-eval/contracts.generated';

export type CalcReviewReason = 'calc_mismatch' | 'calc_unverified';

export interface CalcBlock {
  alias: string;
  text: string;
  language?: string | null;
}

export interface RunCalcChecksInput {
  traces: readonly CalcTrace[];
  invalid?: number | readonly unknown[];
  offered: boolean;
  rawText: string;
  blocks: readonly CalcBlock[];
  question: string;
  answerLanguage: string;
}

export interface CalcChecksOutcome {
  checks: CalcCheck[];
  primary: CalcCheck | null;
  notices: AnswerNotice[];
  reviewReasons: CalcReviewReason[];
}

export function runCalcChecks(_input: RunCalcChecksInput): CalcChecksOutcome {
  return { checks: [], primary: null, notices: [], reviewReasons: [] };
}
