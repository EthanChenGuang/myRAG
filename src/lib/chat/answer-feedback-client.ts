import { z } from 'zod/v3';
import { AnswerRecordSchema, type AnswerFeedbackRequest, type AnswerRecord } from '@/lib/rag-eval/contracts.generated';
import { useAnswerRecordsStore } from '@/lib/stores/answer-records-store';

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

const AnswerIdSchema = z.string().uuid();
const ChatIdSchema = z.string().uuid();
const FeedbackSchema = AnswerRecordSchema.shape.feedback.removeDefault().options[0];
const ResponseSchema = z.object({ feedback: FeedbackSchema });
const REASONS = new Set(['wrong', 'incomplete', 'not_from_documents', 'bad_citation']);

const STATUS_ERRORS: Record<number, FeedbackErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  404: 'not_found',
  415: 'bad_request',
};

const defaultStore: FeedbackStoreLike = {
  getFeedback: (answerId) => {
    const records = useAnswerRecordsStore.getState().records;
    return Object.prototype.hasOwnProperty.call(records, answerId) ? records[answerId].feedback : undefined;
  },
  setFeedback: (answerId, feedback) => useAnswerRecordsStore.getState().setFeedback(answerId, feedback),
};

function buildBody(input: FeedbackInput): AnswerFeedbackRequest | FeedbackErrorCode {
  if (input.vote !== 'helpful' && input.vote !== 'not_helpful') return 'invalid_input';
  const comment = typeof input.comment === 'string' ? input.comment.trim() : null;
  if (comment !== null && comment.length > FEEDBACK_COMMENT_MAX) return 'comment_too_long';
  const reasons = Array.from(new Set(input.reasons ?? []));
  if (reasons.some((reason) => !REASONS.has(reason))) return 'invalid_input';
  const body: AnswerFeedbackRequest = { vote: input.vote, reasons, comment: comment || null, chatId: null };
  if (input.chatId != null) {
    if (!ChatIdSchema.safeParse(input.chatId).success) return 'invalid_input';
    body.chatId = input.chatId;
  }
  return body;
}

/** D-18: one changeable vote. Applied to the store at once, replaced by the server's value, rolled back on any failure. */
export async function submitAnswerFeedback(
  answerId: string,
  input: FeedbackInput,
  deps: { fetch?: FetchLike; store?: FeedbackStoreLike; now?: () => Date } = {},
): Promise<SubmitFeedbackResult> {
  if (!AnswerIdSchema.safeParse(answerId).success) return { ok: false, error: 'invalid_input' };
  const body = buildBody(input);
  if (typeof body === 'string') return { ok: false, error: body };

  const store = deps.store ?? defaultStore;
  const doFetch = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const previous = store.getFeedback(answerId);
  const hadRecord = previous !== undefined;
  const optimistic: AnswerFeedbackValue = {
    vote: body.vote,
    reasons: body.reasons ?? [],
    comment: body.comment,
    updatedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  if (hadRecord) store.setFeedback(answerId, optimistic);

  const fail = (error: FeedbackErrorCode): SubmitFeedbackResult => {
    if (hadRecord && store.getFeedback(answerId) === optimistic) store.setFeedback(answerId, previous ?? null);
    return { ok: false, error };
  };

  let response: Response;
  try {
    response = await doFetch(`/api/rag/answers/${answerId}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body),
    });
  } catch {
    return fail('network');
  }
  if (!response.ok) return fail(STATUS_ERRORS[response.status] ?? 'unavailable');

  let parsed: ReturnType<typeof ResponseSchema.safeParse>;
  try {
    parsed = ResponseSchema.safeParse(await response.json());
  } catch {
    return fail('invalid_response');
  }
  if (!parsed.success) return fail('invalid_response');
  if (hadRecord && store.getFeedback(answerId) === optimistic) store.setFeedback(answerId, parsed.data.feedback);
  return { ok: true, feedback: parsed.data.feedback };
}
