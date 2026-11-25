import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';

type Client = SupabaseClient;

export const REVIEW_SEARCH_POOL = 30;

export const ReviewSearchRequestSchema = z.object({ query: z.string().trim().min(1).max(500) }).strict();
export type ReviewSearchRequest = z.infer<typeof ReviewSearchRequestSchema>;

export interface ReviewSearchHit {
  rank: number;
  chunk_id: string;
  document_id: string;
  document_name: string;
  section: string;
  text: string;
  score: number;
}

export type ReviewSearchResult =
  | { ok: true; item_id: string; hits: ReviewSearchHit[] }
  | { ok: false; reason: 'not_found' | 'scope_refused' | 'retrieval_unavailable' };

export async function searchForReviewItem(_ssr: Client, _admin: Client, _id: string, _query: string, _expertId: string): Promise<ReviewSearchResult> {
  return { ok: false, reason: 'not_found' };
}
