import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerFeedbackValue, AnswerRecordRow } from '@/lib/answers/store';
import { citedQuotesOf, exchangeForAnswer, recordTenantKey } from '@/lib/answers/exchange';
import { isMultiTenant } from '@/lib/deployment-mode';
import type { AnswerFeedbackRequest } from '@/lib/rag-eval/contracts.generated';
import { getSupabaseAdmin } from '@/lib/supabase';
import { readLangfuseConfig, type LangfuseConfig } from '../trace/config';
import { maskPII } from '../trace/mask';
import { exportReviewCandidate, type ReviewCandidateInput, type ReviewExportOptions, type ReviewExportStatus } from '../trace/review-export';
import { scheduleAfterResponse } from '../trace/schedule';
import { postLangfuseScores, type LangfuseScoreInput, type PostScoresOptions, type PostScoresResult } from '../trace/scores';

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
  /** Already validated with AnswerFeedbackRequestSchema; it has no query or answer field. */
  request: AnswerFeedbackRequest;
  /** The SSR session client: the record and the chat are read under RLS. */
  session: SupabaseClient;
  deps?: Partial<SubmitAnswerFeedbackDeps>;
}

export type SubmitAnswerFeedbackResult = { ok: true; feedback: AnswerFeedbackValue } | { ok: false; reason: 'not_found' | 'unavailable' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGFUSE_TIMEOUT_MS = 3000;
const SCORE_NAME = 'user_feedback';

const defaultDeps: SubmitAnswerFeedbackDeps = {
  admin: () => getSupabaseAdmin(),
  schedule: scheduleAfterResponse,
  now: () => new Date(),
  langfuse: () => readLangfuseConfig(),
  multiTenant: () => isMultiTenant(),
  postScores: postLangfuseScores,
  exportReview: exportReviewCandidate,
  langfuseTimeoutMs: LANGFUSE_TIMEOUT_MS,
};

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const match = /\(([A-Za-z0-9_]{1,32})\)$/.exec(error.message);
    if (match) return match[1];
    return error.name || 'error';
  }
  return 'unknown';
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function feedbackOf(request: AnswerFeedbackRequest, now: Date): AnswerFeedbackValue {
  if (request.vote === 'helpful') return { vote: 'helpful', reasons: [], comment: null, updatedAt: now.toISOString() };
  const comment = typeof request.comment === 'string' && request.comment.trim() !== '' ? request.comment.trim() : null;
  return { vote: 'not_helpful', reasons: [...(request.reasons ?? [])], comment, updatedAt: now.toISOString() };
}

/** The score comment: the reason chips, then the PII-masked free text. */
function scoreComment(feedback: AnswerFeedbackValue): string | undefined {
  const parts: string[] = [];
  if (feedback.reasons && feedback.reasons.length > 0) parts.push(`reasons: ${feedback.reasons.join(', ')}`);
  if (feedback.comment) parts.push(maskPII(feedback.comment));
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Links an unlinked record to the caller's chat when that chat lists the answerId; any other chatId is ignored. */
type Store = typeof import('@/lib/answers/store');

// Loaded lazily: the store imports @/lib/rag, which re-exports this module.
const loadStore = (): Promise<Store> => import('@/lib/answers/store');

async function attachIfOwned(store: Store, session: SupabaseClient, admin: SupabaseClient, row: AnswerRecordRow, chatId: string | null | undefined, userId: string): Promise<void> {
  if (row.chat_id !== null || typeof chatId !== 'string' || !UUID_RE.test(chatId)) return;
  try {
    const { data, error } = await session.from('chats').select('id,user_id,organization_id,messages').eq('id', chatId).eq('user_id', userId).maybeSingle();
    if (error) return;
    const chat = data as { id: string; user_id: string; organization_id: string | null; messages: unknown } | null;
    if (!chat || chat.user_id !== userId) return;
    if (!store.answerIdsInMessages(chat.messages).includes(row.id.toLowerCase())) return;
    const linked = await store.attachAnswersToChat(admin, { userId, chat: { id: chat.id, organization_id: chat.organization_id ?? null }, answerIds: [row.id] });
    if (linked > 0) row.chat_id = chat.id;
  } catch (error) {
    console.warn('[RAG Feedback] chat attach failed', { answerId: row.id, code: errorCode(error) });
  }
}

/** The query and the answer from the caller's own chat row; never from the request body. Empty when there is no linked chat. */
async function reviewTexts(admin: SupabaseClient, row: AnswerRecordRow, userId: string): Promise<{ query: string; answer: string }> {
  if (row.chat_id === null) return { query: '', answer: '' };
  const { data, error } = await admin.from('chats').select('id,user_id,messages').eq('id', row.chat_id).eq('user_id', userId).maybeSingle();
  if (error) return { query: '', answer: '' };
  const chat = data as { user_id?: unknown; messages?: unknown } | null;
  if (!chat || chat.user_id !== userId) return { query: '', answer: '' };
  return exchangeForAnswer(chat.messages, row.id) ?? { query: '', answer: '' };
}

async function reportFeedback(row: AnswerRecordRow, feedback: AnswerFeedbackValue, userId: string, admin: SupabaseClient, deps: SubmitAnswerFeedbackDeps): Promise<void> {
  const config = deps.langfuse();
  const box = deps.langfuseTimeoutMs;
  let score: string = 'skipped';
  let review: string = 'none';
  try {
    const tasks: Array<Promise<void>> = [];
    if (row.trace_id) {
      const traceId = row.trace_id;
      const comment = scoreComment(feedback);
      tasks.push(
        (async () => {
          const posted = await withTimeout(
            deps.postScores(
              [{ traceId, name: SCORE_NAME, value: feedback.vote === 'helpful' ? 1 : 0, dataType: 'NUMERIC', ...(comment !== undefined ? { comment } : {}) }],
              { config, timeoutMs: box },
            ),
            box + 500,
          );
          score = posted === 'timeout' ? 'failed' : posted.status;
        })(),
      );
      if (feedback.vote === 'not_helpful') {
        tasks.push(
          (async () => {
            const texts = await withTimeout(reviewTexts(admin, row, userId), box);
            const { query, answer } = texts === 'timeout' ? { query: '', answer: '' } : texts;
            const exported = await withTimeout(
              deps.exportReview(
                {
                  traceId,
                  tenantKey: recordTenantKey(row, deps.multiTenant()),
                  reason: 'feedback_negative',
                  query,
                  answer,
                  citedQuotes: citedQuotesOf(row.citations),
                  model: row.model_id ?? '',
                },
                { config, timeoutMs: box },
              ),
              box + 500,
            );
            review = exported === 'timeout' ? 'failed' : exported;
          })().catch(() => {
            review = 'failed';
          }),
        );
      }
    }
    await Promise.allSettled(tasks);
  } catch {
    score = 'failed';
  }
  if ((score !== 'accepted' && score !== 'partial') || review === 'failed') {
    console.log('[RAG Feedback]', { answerId: row.id, vote: feedback.vote, reasons: feedback.reasons?.length ?? 0, score, review });
  }
}

/**
 * D-17 to D-19: stores the caller's vote on their own record first (latest wins), appends feedback_negative for a not_helpful vote,
 * then, after the response, sends the user_feedback score and the masked review copy to Langfuse. A missing record and another
 * user's record both give not_found. The vote is never lost to a Langfuse failure.
 */
export async function submitAnswerFeedback(input: SubmitAnswerFeedbackInput): Promise<SubmitAnswerFeedbackResult> {
  const deps: SubmitAnswerFeedbackDeps = { ...defaultDeps, ...(input.deps ?? {}) };
  if (!UUID_RE.test(input.answerId) || !UUID_RE.test(input.userId)) return { ok: false, reason: 'not_found' };
  const answerId = input.answerId.toLowerCase();
  const userId = input.userId.toLowerCase();
  try {
    const store = await loadStore();
    const owned = await store.readOwnedAnswerRecord(input.session, { id: answerId, userId });
    if (!owned || owned.user_id.toLowerCase() !== userId) return { ok: false, reason: 'not_found' };
    const admin = deps.admin();
    if (!admin) return { ok: false, reason: 'unavailable' };

    await attachIfOwned(store, input.session, admin, owned, input.request.chatId, userId);

    const feedback = feedbackOf(input.request, deps.now());
    const stored = await store.setAnswerFeedback(admin, { id: answerId, userId, feedback });
    if (!stored) return { ok: false, reason: 'not_found' };
    const row: AnswerRecordRow = { ...stored, chat_id: stored.chat_id ?? owned.chat_id };

    if (feedback.vote === 'not_helpful') {
      try {
        await store.appendReviewReason(admin, { id: answerId, reason: 'feedback_negative' });
      } catch (error) {
        console.warn('[RAG Feedback] review reason append failed', { answerId, code: errorCode(error) });
      }
    }

    deps.schedule(() => reportFeedback(row, feedback, userId, admin, deps));
    return { ok: true, feedback };
  } catch (error) {
    console.error('[RAG Feedback] vote write failed', { answerId, code: errorCode(error) });
    return { ok: false, reason: 'unavailable' };
  }
}

/** Stub (RED): replaced by the implementation in the next commit. */
export async function mirrorVoteToRetrievalLog(..._args: unknown[]): Promise<void> {}
