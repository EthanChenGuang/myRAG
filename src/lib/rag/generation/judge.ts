import type { ClaimCheckRequest } from '@/lib/rag-eval/contracts.generated';

export type ClaimPremise = ClaimCheckRequest['premises'][number];
export type ClaimInput = ClaimCheckRequest['claims'][number];

export type JudgeReason =
  | 'judge_not_configured'
  | 'judge_same_family'
  | 'judge_unknown_family'
  | 'invalid_output'
  | 'timeout'
  | 'error';

export interface JudgeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  /** Estimated from the judge's price entry in config/rag/model-families.json; null without one. */
  costUsd: number | null;
}

export interface JudgeVerdict {
  index: number;
  verdict: 'supported' | 'unsupported' | 'not_enough_info';
  evidenceRef: string | null;
}

export type JudgeClaimsResult =
  | { status: 'judged'; judgeModel: string; judgeVersion: string; verdicts: JudgeVerdict[]; usage: JudgeUsage }
  | { status: 'not_checked'; reason: JudgeReason; judgeModel: string | null; judgeVersion: string | null; usage: JudgeUsage | null };

export interface JudgeClaimsInput {
  language: string;
  premises: readonly ClaimPremise[];
  claims: readonly ClaimInput[];
  generatorModelId: string;
  /** RAG_GROUNDEDNESS_JUDGE_MODEL. */
  judgeModel: string;
  signal?: AbortSignal;
}

export async function judgeClaims(input: JudgeClaimsInput): Promise<JudgeClaimsResult> {
  return { status: 'not_checked', reason: 'judge_not_configured', judgeModel: input.judgeModel || null, judgeVersion: null, usage: null };
}
