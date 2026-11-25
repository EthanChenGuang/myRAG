import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantScope } from '@/lib/rag';
import type { AnswerRecord, CitationRecord } from '@/lib/rag-eval/contracts.generated';

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

export async function insertAnswerRecord(_admin: SupabaseClient, _input: InsertAnswerRecordInput): Promise<{ inserted: boolean }> {
  return { inserted: false };
}

export async function updateAnswerGroundedness(_admin: SupabaseClient, _input: { id: string; groundedness: AnswerGroundednessValue }): Promise<boolean> {
  return false;
}

export async function setAnswerFeedback(
  _admin: SupabaseClient,
  _input: { id: string; userId: string; feedback: AnswerFeedbackValue },
): Promise<AnswerRecordRow | null> {
  return null;
}

export async function appendReviewReason(_admin: SupabaseClient, _input: { id: string; reason: ReviewReason }): Promise<boolean> {
  return false;
}

export async function attachAnswersToChat(
  _admin: SupabaseClient,
  _input: { userId: string; chat: { id: string; organization_id: string | null }; answerIds: string[] },
): Promise<number> {
  return 0;
}

export async function readOwnedAnswerRecord(_client: SupabaseClient, _input: { id: string; userId: string }): Promise<AnswerRecordRow | null> {
  return null;
}

export async function listOwnedAnswerRecordsForChat(_client: SupabaseClient, _input: { chatId: string; userId: string }): Promise<AnswerRecordRow[]> {
  return [];
}

export function answerIdsInMessages(_messages: unknown): string[] {
  return [];
}
