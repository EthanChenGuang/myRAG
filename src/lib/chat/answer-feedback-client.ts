import type { AnswerFeedbackRequest, AnswerRecord } from '@/lib/rag-eval/contracts.generated';

export type AnswerFeedbackValue = NonNullable<AnswerRecord['feedback']>;
export type FeedbackErrorCode =
  | 'invalid_input'
  | 'comment_too_long'
  | 'no_record'
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'unavailable'
  | 'invalid_response'
  | 'network';
export type SubmitFeedbackResult = { ok: true; feedback: AnswerFeedbackValue } | { ok: false; error: FeedbackErrorCode };
export type FeedbackInput = Pick<AnswerFeedbackRequest, 'vote'> & Partial<Pick<AnswerFeedbackRequest, 'reasons' | 'comment' | 'chatId'>>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FeedbackStoreLike {
  getFeedback(answerId: string): AnswerRecord['feedback'] | undefined;
  setFeedback(answerId: string, feedback: AnswerRecord['feedback']): void;
}

export const FEEDBACK_COMMENT_MAX = 500;

export async function submitAnswerFeedback(
  _answerId: string,
  _input: FeedbackInput,
  _deps: { fetch?: FetchLike; store?: FeedbackStoreLike; now?: () => Date } = {},
): Promise<SubmitFeedbackResult> {
  return { ok: false, error: 'unavailable' };
}
