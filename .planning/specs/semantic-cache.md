# Semantic answer cache (CACHE-01) — locked spec

Status: chosen 2026-11-23; to be implemented in Phase 6 as `src/lib/rag/cache/`. Off by default (`RAG_SEMANTIC_CACHE=off|pgvector|redisvl`).

## Choice

| Option | Decision | Why |
|---|---|---|
| **pgvector table in Supabase, RedisVL-style API** | **Default backend** | No new infrastructure. Works on Vercel serverless, where an in-process cache dies with each instance. Tenant isolation uses the same `TenantScope` and RLS as retrieval. Invalidation can run in the same transaction as a document change. One pgvector lookup (~10–30 ms) is negligible next to an LLM call. |
| **RedisVL `SemanticCache` (MIT, 0.32.x)** | Optional backend, in the Python sidecar | The top open-source pick, for deployments that already run Redis. It follows the same `check` / `store` contract, so switching backends is a config change. |
| Redis LangCache (managed) | Not now | Free only during the preview, with usage limits and unknown later pricing. It would also send questions and answers to another vendor. It uses the same `check` / `store` interface as RedisVL, so it can be added later as a third backend. |
| LiteLLM / Bifrost gateway cache | Rejected | A gateway caches the full LLM prompt, retrieved context included. It cannot invalidate per tenant when a document changes. It would also sit in front of the direct Anthropic Citations path (GEN-01). |
| GPTCache | Rejected | Last released in August 2024, and the README says it does not support new model APIs. |

## Contract (same for both backends)

```ts
interface SemanticCache {
  check(q: CacheQuery): Promise<CacheHit | null>;
  store(q: CacheQuery, answer: CachedAnswer): Promise<void>;
  invalidateTenant(scope: TenantScope, documentIds?: string[]): Promise<number>;
}
// CacheQuery: scope (TenantScope), standalone query text + embedding, answer language,
//             RAG mode (strict/balanced), generator model id, retrieval-config hash, query framework
// CachedAnswer: answer text, citations[] (GEN-03 record with text snapshots), source document ids + versions, created_at
```

## Rules

1. **Key scope.** An entry matches only when all of these are equal: tenant (`TenantScope`), answer language, RAG mode, generator model, retrieval-config hash and query framework. Answer language is in the key because a multilingual embedding puts "酒店报销上限" and "hotel reimbursement limit" close together, and an English asker must not get a Chinese answer.
2. **Standalone queries only.** The cache key is the condensed standalone query (after QRY-01), never the raw follow-up. A turn the rewrite gate (LAT-03) marks `condense_history` but could not condense is not cached.
3. **Strict threshold.** Start with cosine distance ≤ 0.05, then calibrate on the dev split as described under Eval gate.
4. **Bypass, neither checked nor stored**, when any of these holds:
   - `protectedTokens` is non-empty. These are exact codes, IDs, amounts and quoted text from rewrite-gate rules R4/R7. They stop "ERR_CONN_4031" from matching a cached "ERR_CONN_4032".
   - The question contains personal data: phone numbers, e-mail addresses or ID numbers, or first-person-specific requests such as 我的…/my…/il mio….
   - The question involves relative time (rewrite-gate rule R2).
   - The turn used webSearch, MCP tools or `source_images`.
   - The groundedness status (GEN-05) is "possibly unreliable".
5. **Refusals.** Refusals ("information not available") are cached with a short TTL (10 min). They are invalidated like any other entry, so a newly uploaded document fixes them at once.
6. **TTL and invalidation.** The default TTL is 1 hour (`RAG_SEMANTIC_CACHE_TTL`).
   - When a tenant inserts, replaces or deletes a document, that tenant's entries are invalidated. The pgvector backend does this through the same trigger/outbox as RET-05. The RedisVL backend does it with a tag delete through the sidecar.
   - Each entry stores its source document versions. An entry whose sources are no longer `is_current` is a miss.
7. **No cross-tenant leaks.** The pgvector table has RLS and is reachable only by the server role. The cache is part of the RET-08 cross-tenant canary suite.
8. **Observability.** A Langfuse `semantic_cache` span records hit/miss, distance, bypass reason and latency (OBS-01). The eval reports hit rate and the latency of hits versus misses.

## Eval gate

- The golden set gains two pair categories:
  - `cache_paraphrase`: the same question worded differently, which should hit.
  - `cache_near_miss`: a different code, number, language, product or date, which must miss.
- The wrong-hit rate on `cache_near_miss` must be 0, gated in CI.
- The threshold is chosen on the dev split and checked on the holdout split.
- With the cache off, results equal the baseline.
