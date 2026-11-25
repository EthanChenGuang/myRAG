import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerFeedbackValue } from '@/lib/answers/store';
import type { AnswerFeedbackRequest } from '@/lib/rag-eval/contracts.generated';
import type { LangfuseConfig } from '../trace/config';
import type { ReviewCandidateInput, ReviewExportOptions, ReviewExportStatus } from '../trace/review-export';
import type { LangfuseScoreInput, PostScoresOptions, PostScoresResult } from '../trace/scores';

export interface SubmitAnswerFeedbackDeps {
  admin: () => SupabaseClient | null;
  schedule: (task: () => Promise<void>) => void;
  now: () => Date;
  langfuse: () => LangfuseConfig;
  multiTenant: () => boolean;
  postScores: (scores: readonly LangfuseScoreInput[], options: PostScoresOptions) => Promise<PostScoresResult>;
  exportReview: (input: ReviewCandidateInput, options: ReviewExportOptions) => Promise<ReviewExportStatus>;
  langfuseTimeoutMs: number;
}

export interface SubmitAnswerFeedbackInput {
  answerId: string;
  userId: string;
  request: AnswerFeedbackRequest;
  session: SupabaseClient;
  deps?: Partial<SubmitAnswerFeedbackDeps>;
}

export type SubmitAnswerFeedbackResult = { ok: true; feedback: AnswerFeedbackValue } | { ok: false; reason: 'not_found' | 'unavailable' };

export async function submitAnswerFeedback(_input: SubmitAnswerFeedbackInput): Promise<SubmitAnswerFeedbackResult> {
  return { ok: false, reason: 'unavailable' };
}
