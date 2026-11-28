import type { SupabaseClient } from '@supabase/supabase-js';
import type { RefusalFeedbackRequest } from '@/lib/rag-eval/contracts.generated';
import { getSupabaseAdmin } from '@/lib/supabase';

export type RefusalVote = RefusalFeedbackRequest['vote'];

export interface VoteDeps {
  admin: () => SupabaseClient | null;
  now: () => Date;
  timeoutMs: number;
}

export interface SetRefusalVoteInput {
  traceId: string;
  /** The SSR session user; never taken from the request body. */
  userId: string;
  /** Already validated with RefusalFeedbackRequestSchema. */
  request: RefusalFeedbackRequest;
  deps?: Partial<VoteDeps>;
}

export interface RefusalVoteValue {
  vote: RefusalVote;
  reasons: string[];
  at: string;
}

export type SetRefusalVoteResult = ({ found: true } & RefusalVoteValue) | { found: false; unavailable?: true };

export interface RecordSourceOpenedInput {
  traceId: string;
  userId: string;
  deps?: Partial<VoteDeps>;
}

export type RecordSourceOpenedResult = { found: true; count: number } | { found: false; unavailable?: true };

/** Mirrors the cap inside public.rag_record_source_opened (0536). */
export const SOURCE_OPENED_CAP = 20;
export const REFUSAL_OUTCOMES = ['refused_no_context', 'kb_unavailable'] as const;

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 3000;

const defaultDeps: VoteDeps = {
  admin: () => getSupabaseAdmin(),
  now: () => new Date(),
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

function validIds(traceId: string, userId: string): boolean {
  return typeof traceId === 'string' && TRACE_ID_RE.test(traceId) && typeof userId === 'string' && UUID_RE.test(userId);
}

function adminOf(deps: VoteDeps): SupabaseClient | null {
  try {
    return deps.admin();
  } catch {
    return null;
  }
}

async function withTimeout<T>(work: PromiseLike<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(work), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * D-08: one changeable vote on the caller's own refusal row, as a single conditional update (no read-then-write).
 * The row must match the trace id, the session user and a refusal outcome; anything else is found false.
 */
export async function setRefusalVote(input: SetRefusalVoteInput): Promise<SetRefusalVoteResult> {
  if (!validIds(input.traceId, input.userId)) return { found: false };
  const deps: VoteDeps = { ...defaultDeps, ...input.deps };
  const client = adminOf(deps);
  if (!client) return { found: false, unavailable: true };

  const vote = input.request.vote;
  const reasons = vote === 'expected_answer' ? [...new Set(input.request.reasons ?? [])] : [];
  const at = deps.now().toISOString();
  try {
    const update = client
      .from('rag_retrieval_log')
      .update({ feedback_vote: vote === 'expected_answer' ? -1 : 1, feedback_kind: 'refusal', feedback_reasons: reasons, feedback_at: at })
      .eq('trace_id', input.traceId)
      .eq('user_id', input.userId)
      .in('outcome', [...REFUSAL_OUTCOMES])
      .select('trace_id');
    const result = await withTimeout(update, deps.timeoutMs);
    if (result === 'timeout' || result.error) return { found: false, unavailable: true };
    if (!Array.isArray(result.data) || result.data.length === 0) return { found: false };
    return { found: true, vote, reasons, at };
  } catch {
    return { found: false, unavailable: true };
  }
}

/**
 * D-12: increments source_opened_count on the caller's own row, at most SOURCE_OPENED_CAP, in one statement
 * (public.rag_record_source_opened). The function returns null when the session user owns no row with that trace id.
 */
export async function recordSourceOpened(input: RecordSourceOpenedInput): Promise<RecordSourceOpenedResult> {
  if (!validIds(input.traceId, input.userId)) return { found: false };
  const deps: VoteDeps = { ...defaultDeps, ...input.deps };
  const client = adminOf(deps);
  if (!client) return { found: false, unavailable: true };
  try {
    const call = client.rpc('rag_record_source_opened', { p_trace_id: input.traceId, p_user_id: input.userId });
    const result = await withTimeout(call, deps.timeoutMs);
    if (result === 'timeout' || result.error) return { found: false, unavailable: true };
    const count = typeof result.data === 'number' ? result.data : Number.NaN;
    if (!Number.isInteger(count) || count < 0) return { found: false };
    return { found: true, count: Math.min(count, SOURCE_OPENED_CAP) };
  } catch {
    return { found: false, unavailable: true };
  }
}
