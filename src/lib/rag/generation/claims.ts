import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReviewReason } from '@/lib/answers/store';
import type { AnswerChecks, AnswerSentence, ClaimCheckRequest, ClaimCheckResult } from '@/lib/rag-eval/contracts.generated';
import type { LangfuseConfig } from '../trace/config';
import type { CollectedTrace, ExportTraceOptions } from '../trace/langfuse';
import type { ReviewCandidateInput, ReviewExportOptions, ReviewExportStatus } from '../trace/review-export';
import type { LangfuseScoreInput, PostScoresOptions, PostScoresResult } from '../trace/scores';
import type { AnswerPendingContext } from './answer-finish';
import type { AnswerGroundedness } from './groundedness';
import type { ClaimInput, ClaimPremise, JudgeClaimsInput, JudgeClaimsResult } from './judge';

export interface ClaimStepConfig {
  claimCheck: boolean;
  llmJudge: boolean;
  judgeModel: string;
  vectaraOptIn: boolean;
  vectaraMultiTenantAck: boolean;
  maxPremiseTokens: number;
  groundednessTimeoutMs: number;
}

export interface ClaimStepDeps {
  readConfig: () => ClaimStepConfig;
  multiTenant: () => boolean;
  request: (request: ClaimCheckRequest, options?: ClaimClientOptions) => Promise<ClaimCheckResult>;
  judge: (input: JudgeClaimsInput) => Promise<JudgeClaimsResult>;
  updateChecks: (admin: SupabaseClient, input: { id: string; checks: AnswerChecks }) => Promise<boolean>;
  updateGroundedness: (admin: SupabaseClient, input: { id: string; groundedness: AnswerGroundedness }) => Promise<boolean>;
  appendReviewReason: (admin: SupabaseClient, input: { id: string; reason: ReviewReason }) => Promise<boolean>;
  exportReview: (input: ReviewCandidateInput, options: ReviewExportOptions) => Promise<ReviewExportStatus>;
  langfuse: () => LangfuseConfig;
  exportTrace: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  postScores: (scores: readonly LangfuseScoreInput[], options: PostScoresOptions) => Promise<PostScoresResult>;
  now: () => Date;
  updateTimeoutMs: number;
  langfuseTimeoutMs: number;
}

export interface ClaimClientOptions {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface BuildClaimInputsInput {
  text: string;
  sentences: readonly AnswerSentence[];
  blocks: ReadonlyArray<{ alias: string; text: string }>;
  webSearchTexts?: readonly string[];
  aliases?: ReadonlySet<string>;
  capPerClaim: number;
  countTokens?: (text: string) => number;
}

export type SkippedReason = 'too_many' | 'empty_claim' | 'no_premise';

export interface ClaimInputs {
  premises: ClaimPremise[];
  claims: ClaimInput[];
  skipped: Array<{ index: number; reason: SkippedReason }>;
}

export interface ClaimStepOptions {
  deadlineAt?: number;
}

export interface ClaimStepOutcome {
  groundedness?: AnswerGroundedness;
}

export function buildClaimInputs(_input: BuildClaimInputsInput): ClaimInputs {
  return { premises: [], claims: [], skipped: [] };
}

export async function requestClaimCheck(_request: ClaimCheckRequest, _options: ClaimClientOptions = {}): Promise<ClaimCheckResult> {
  return { claims: [], latency_ms: 0 };
}

export function createClaimStep(
  _overrides: Partial<ClaimStepDeps> = {},
): (context: AnswerPendingContext, options?: ClaimStepOptions) => Promise<ClaimStepOutcome | null> {
  return async () => null;
}
