import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import { isTenantScope, type TenantScope } from '@/lib/rag';
import { AnswerRecordSchema, CitationRecordSchema, type AnswerRecord, type CitationRecord } from '@/lib/rag-eval/contracts.generated';

export type AnswerGroundednessValue = AnswerRecord['groundedness'];
export type AnswerFeedbackValue = NonNullable<AnswerRecord['feedback']>;
export type ReviewReason = 'feedback_negative' | 'groundedness_flagged';

export interface AnswerRecordRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  chat_id: string | null;
  trace_id: string | null;
  model_id: string | null;
  citation_strategy: string | null;
  rag_mode: string;
  answer_language: string | null;
  invalid_citations: number;
  citations: unknown;
  groundedness: unknown;
  feedback: unknown;
  review_reasons: string[];
  created_at: string;
  updated_at: string;
}

export interface InsertAnswerRecordInput {
  id: string;
  scope: TenantScope;
  userId: string;
  chatId: string | null;
  traceId: string;
  modelId: string;
  citationStrategy: CitationRecord['strategy'] | null;
  ragMode: AnswerRecord['ragMode'];
  answerLanguage: string | null;
  invalidCitations: number;
  citations: CitationRecord[];
  groundedness: AnswerGroundednessValue;
}

export class AnswerStoreError extends Error {
  constructor(operation: string, code: string | undefined) {
    super(`[RAG Answers] ${operation} failed${code ? ` (${code})` : ''}`);
    this.name = 'AnswerStoreError';
  }
}

const TABLE = 'rag_answer_records';
export const ANSWER_RECORD_COLUMNS =
  'id,user_id,organization_id,chat_id,trace_id,model_id,citation_strategy,rag_mode,answer_language,invalid_citations,citations,groundedness,feedback,review_reasons,created_at,updated_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTACH_IDS = 500;
const MAX_CHAT_RECORDS = 500;
const REVIEW_REASONS: readonly ReviewReason[] = ['feedback_negative', 'groundedness_flagged'];
const APPEND_ATTEMPTS = 5;

const InsertSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  chatId: z.string().uuid().nullable(),
  traceId: z.string().min(1),
  modelId: z.string().min(1),
  citationStrategy: z.enum(['claude-citations', 'chunk-alias']).nullable(),
  ragMode: z.enum(['strict', 'balanced', 'flexible', 'bypass']),
  answerLanguage: z.string().nullable(),
  invalidCitations: z.number().int().gte(0),
  citations: z.array(CitationRecordSchema),
  groundedness: AnswerRecordSchema.shape.groundedness,
});
const GroundednessSchema = AnswerRecordSchema.shape.groundedness;
const FeedbackSchema = AnswerRecordSchema.shape.feedback.removeDefault().options[0];

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function organizationOf(scope: TenantScope, userId: string): string | null {
  if (!isTenantScope(scope)) throw new Error('[RAG Answers] unminted tenant scope');
  const user = userId.toLowerCase();
  if (scope.kind === 'single') return null;
  if (scope.kind === 'personal') {
    if (scope.userId !== user) throw new Error('[RAG Answers] personal scope belongs to another user');
    return null;
  }
  if (scope.userId !== null && scope.userId !== user) throw new Error('[RAG Answers] organization scope belongs to another user');
  return scope.organizationId;
}

/** Inserts one record through the admin client. A second insert with the same id is ignored. */
export async function insertAnswerRecord(admin: SupabaseClient, input: InsertAnswerRecordInput): Promise<{ inserted: boolean }> {
  const organizationId = organizationOf(input.scope, input.userId);
  const parsed = InsertSchema.parse({
    id: input.id,
    userId: input.userId,
    chatId: input.chatId,
    traceId: input.traceId,
    modelId: input.modelId,
    citationStrategy: input.citationStrategy,
    ragMode: input.ragMode,
    answerLanguage: input.answerLanguage,
    invalidCitations: input.invalidCitations,
    citations: input.citations,
    groundedness: input.groundedness,
  });
  const { data, error } = await admin
    .from(TABLE)
    .upsert(
      {
        id: parsed.id,
        user_id: parsed.userId,
        organization_id: organizationId,
        chat_id: parsed.chatId,
        trace_id: parsed.traceId,
        model_id: parsed.modelId,
        citation_strategy: parsed.citationStrategy,
        rag_mode: parsed.ragMode,
        answer_language: parsed.answerLanguage,
        invalid_citations: parsed.invalidCitations,
        citations: parsed.citations,
        groundedness: parsed.groundedness,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw new AnswerStoreError('insert', error.code);
  return { inserted: Array.isArray(data) && data.length > 0 };
}

export async function updateAnswerGroundedness(admin: SupabaseClient, input: { id: string; groundedness: AnswerGroundednessValue }): Promise<boolean> {
  if (!isUuid(input.id)) return false;
  const groundedness = GroundednessSchema.parse(input.groundedness);
  const { data, error } = await admin.from(TABLE).update({ groundedness, updated_at: nowIso() }).eq('id', input.id).select('id');
  if (error) throw new AnswerStoreError('groundedness update', error.code);
  return Array.isArray(data) && data.length > 0;
}

/** Sets the vote only on a record of this user; another user's or a missing record gives null. */
export async function setAnswerFeedback(
  admin: SupabaseClient,
  input: { id: string; userId: string; feedback: AnswerFeedbackValue },
): Promise<AnswerRecordRow | null> {
  if (!isUuid(input.id) || !isUuid(input.userId)) return null;
  const feedback = FeedbackSchema.parse(input.feedback);
  const { data, error } = await admin
    .from(TABLE)
    .update({ feedback, updated_at: nowIso() })
    .eq('id', input.id)
    .eq('user_id', input.userId)
    .select(ANSWER_RECORD_COLUMNS)
    .maybeSingle();
  if (error) throw new AnswerStoreError('feedback update', error.code);
  return (data as AnswerRecordRow | null) ?? null;
}

/** Adds a review reason once. Compare-and-set on the stored array, so concurrent writers do not drop each other's reason. */
export async function appendReviewReason(admin: SupabaseClient, input: { id: string; reason: ReviewReason }): Promise<boolean> {
  if (!isUuid(input.id)) return false;
  if (!REVIEW_REASONS.includes(input.reason)) throw new Error('[RAG Answers] unknown review reason');
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
    const { data, error } = await admin.from(TABLE).select('id,review_reasons').eq('id', input.id).maybeSingle();
    if (error) throw new AnswerStoreError('review reason read', error.code);
    const row = data as { id: string; review_reasons: string[] | null } | null;
    if (!row) return false;
    const current = Array.isArray(row.review_reasons) ? row.review_reasons : [];
    if (current.includes(input.reason)) return true;
    const { data: updated, error: updateError } = await admin
      .from(TABLE)
      .update({ review_reasons: [...current, input.reason], updated_at: nowIso() })
      .eq('id', input.id)
      .eq('review_reasons', current)
      .select('id');
    if (updateError) throw new AnswerStoreError('review reason update', updateError.code);
    if (Array.isArray(updated) && updated.length > 0) return true;
  }
  throw new AnswerStoreError('review reason update', 'contention');
}

/**
 * Links this user's unlinked records to a chat the caller has already verified the user owns.
 * Only rows whose organization is not distinct from the chat's are linked. Returns the number linked.
 */
export async function attachAnswersToChat(
  admin: SupabaseClient,
  input: { userId: string; chat: { id: string; organization_id: string | null }; answerIds: string[] },
): Promise<number> {
  if (!isUuid(input.userId) || !isUuid(input.chat.id)) return 0;
  const organizationId = input.chat.organization_id;
  if (organizationId !== null && !isUuid(organizationId)) return 0;
  const ids = [...new Set(input.answerIds.filter(isUuid).map((id) => id.toLowerCase()))].slice(0, MAX_ATTACH_IDS);
  if (ids.length === 0) return 0;
  const base = admin
    .from(TABLE)
    .update({ chat_id: input.chat.id, updated_at: nowIso() })
    .in('id', ids)
    .eq('user_id', input.userId)
    .is('chat_id', null);
  const scoped = organizationId === null ? base.is('organization_id', null) : base.eq('organization_id', organizationId);
  const { data, error } = await scoped.select('id');
  if (error) throw new AnswerStoreError('attach', error.code);
  return Array.isArray(data) ? data.length : 0;
}

/** Reads one record through the client it is given (the session client in routes, so RLS applies) plus a user_id guard. */
export async function readOwnedAnswerRecord(client: SupabaseClient, input: { id: string; userId: string }): Promise<AnswerRecordRow | null> {
  if (!isUuid(input.id) || !isUuid(input.userId)) return null;
  const { data, error } = await client.from(TABLE).select(ANSWER_RECORD_COLUMNS).eq('id', input.id).eq('user_id', input.userId).maybeSingle();
  if (error) throw new AnswerStoreError('read', error.code);
  return (data as AnswerRecordRow | null) ?? null;
}

export async function listOwnedAnswerRecordsForChat(client: SupabaseClient, input: { chatId: string; userId: string }): Promise<AnswerRecordRow[]> {
  if (!isUuid(input.chatId) || !isUuid(input.userId)) return [];
  const { data, error } = await client
    .from(TABLE)
    .select(ANSWER_RECORD_COLUMNS)
    .eq('chat_id', input.chatId)
    .eq('user_id', input.userId)
    .order('created_at', { ascending: true })
    .limit(MAX_CHAT_RECORDS);
  if (error) throw new AnswerStoreError('list', error.code);
  return Array.isArray(data) ? (data as unknown as AnswerRecordRow[]) : [];
}

/** The answerId of each assistant message, in order, once each; malformed entries are skipped. */
export function answerIdsInMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, metadata } = message as { role?: unknown; metadata?: unknown };
    if (role !== 'assistant' || typeof metadata !== 'object' || metadata === null) continue;
    const answerId = (metadata as { answerId?: unknown }).answerId;
    if (!isUuid(answerId)) continue;
    const id = answerId.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
