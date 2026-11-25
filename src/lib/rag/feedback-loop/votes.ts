import type { SupabaseClient } from '@supabase/supabase-js';
import type { RefusalFeedbackRequest } from '@/lib/rag-eval/contracts.generated';

export type RefusalVote = RefusalFeedbackRequest['vote'];

export interface VoteDeps {
  admin: () => SupabaseClient | null;
  now: () => Date;
  timeoutMs: number;
}

export interface SetRefusalVoteInput {
  traceId: string;
  userId: string;
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

export const SOURCE_OPENED_CAP = 20;

export async function setRefusalVote(_input: SetRefusalVoteInput): Promise<SetRefusalVoteResult> {
  return { found: false };
}

export async function recordSourceOpened(_input: RecordSourceOpenedInput): Promise<RecordSourceOpenedResult> {
  return { found: false };
}
