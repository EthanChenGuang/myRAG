import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import { runRetrieval } from '../pipeline';
import { backfillScope } from '../tenant/backfill-scope';
import { parseTenantKey } from '../tenant/embed';
import { scopeKey } from '../tenant/scope';
import { createTraceCollector } from '../trace/collector';
import { fetchServableChunks, hashForLog, readVisibleItem } from './review-access';

type Client = SupabaseClient;

export const REVIEW_SEARCH_POOL = 30;
const SEARCH_TIMEOUT_MS = 30_000;

/** Only the query; any other key (a tenant key included) is rejected. */
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

/**
 * D-19: the item is read through RLS, its stored tenant_key is minted into a scope with backfillScope, and runRetrieval searches that
 * scope (profile chat, flexible, pool 30). The call carries its own trace collector, which is never finished, and logContext skip, so
 * no retrieval log row, Langfuse trace or review candidate holds the expert's query. Hits are re-read under the item's tenant and kept
 * only when current and servable.
 */
export async function searchForReviewItem(ssr: Client, admin: Client, id: string, query: string, expertId: string): Promise<ReviewSearchResult> {
  const item = await readVisibleItem(ssr, id);
  if (!item) return { ok: false, reason: 'not_found' };
  const tenantKey = item.tenant_key;
  if (typeof tenantKey !== 'string' || !parseTenantKey(tenantKey)) return { ok: false, reason: 'not_found' };

  const minted = await backfillScope(tenantKey, { admin });
  if (!minted.ok || scopeKey(minted.scope) !== tenantKey) return { ok: false, reason: 'scope_refused' };

  const result = await runRetrieval({
    scope: minted.scope,
    query,
    profile: 'chat',
    options: { ragMode: 'flexible', maxResults: REVIEW_SEARCH_POOL },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    trace: createTraceCollector({ profile: 'chat', tenantKey }),
    logContext: { skip: true },
  });
  if (result.status === 'error') return { ok: false, reason: 'retrieval_unavailable' };

  const ranked: Array<{ rank: number; chunkId: string; score: number }> = [];
  const seen = new Set<string>();
  for (const [index, candidate] of result.candidates.entries()) {
    const chunkId = typeof candidate.chunk_id === 'string' ? candidate.chunk_id.toLowerCase() : '';
    if (chunkId === '' || seen.has(chunkId)) continue;
    seen.add(chunkId);
    const score = candidate.rerank_score ?? candidate.fused_score ?? candidate.similarity;
    ranked.push({ rank: index + 1, chunkId, score: Number.isFinite(score) ? score : 0 });
    if (ranked.length >= REVIEW_SEARCH_POOL) break;
  }

  const servable = await fetchServableChunks(
    admin,
    tenantKey,
    ranked.map((entry) => entry.chunkId),
  );
  const hits: ReviewSearchHit[] = [];
  for (const entry of ranked) {
    const chunk = servable.get(entry.chunkId);
    if (!chunk) continue;
    hits.push({
      rank: entry.rank,
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      document_name: chunk.document_name,
      section: chunk.section,
      text: chunk.text,
      score: entry.score,
    });
  }
  console.log('[Review] search', { expert: expertId, item: hashForLog(String(item.id)), count: hits.length });
  return { ok: true, item_id: String(item.id), hits };
}
