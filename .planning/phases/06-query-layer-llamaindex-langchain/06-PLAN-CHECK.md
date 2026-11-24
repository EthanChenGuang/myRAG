# Phase 6 Plan Check

**Verdict: FAIL** — 4 blockers, 9 warnings, 2 info.
**Checked:** 2026-11-24, 46 plans, 06-PLAN-INDEX.md, 06-VALIDATION.md against 06-CONTEXT.md, 06-RESEARCH.md, 06-PATTERNS.md, REQUIREMENTS.md, ROADMAP.md, AGENTS.md, .claude/CLAUDE.md, config.json, specs/semantic-cache.md and the current tree. No plan was edited and git was not run.

## What was measured

- `verify plan-structure`: 46 of 46 valid, 0 errors; 4 one-way warnings (06-04, 06-08, 06-12, 06-45), already settled by D-23, D-34, D-11/A-6.
- Dependency graph (my own script): every `depends_on` id exists, no cycles, every wave equals max(dep wave)+1, every file shared by two Phase 6 plans is ordered, and for every file the last Phase 3/3.1/4/5 editor is an ancestor. 0 gaps.
- All `grep -c` gates with a `[HEAD=...]` note were re-run on the current tree: all match, including the 06-21 `publish.ts` gate (0 after 03-13).
- Requirements QRY-01..08, LAT-03, XLG-01, CACHE-01, D-01..D-44 and A-1..A-10 all have plans (index tables checked against the plan frontmatter). Coverage passes; the blockers below are about plans that would not deliver safely.

## BLOCKERS

### 06-17 / 06-32: cache key and bypass ignore document references and retrieval options
- Required: a cached answer is served only for a turn whose retrieval inputs match the stored turn, or the turn bypasses the cache.
- Evidence: `RunRetrievalInput` carries `documentRefs` (`@mentions`, plus attached `documentParts` that never appear in the text, see `src/app/api/chat/route.ts` L1919-1949) and `options` (`mediaKind`, `generalOverview`, `maxResults`). The key parts in 06-17 Task 1 have none of them, and the check and store rules in 06-17 Task 2 and the TurnFacts list do not include them. So "summarize this" with document X attached can be stored and then served to a colleague in the same tenant who attached document Y, or who attached nothing. That is a wrong answer that reveals content from a document the second user never chose.
- Example fix: add `document_refs` and the non-default retrieval options to both bypass functions (or to the key), with zh/en/it cases, and add a two-request test in 06-36.

### 06-41: eval seeding can poison the production cache
- Required: entries that eval writes (especially `cache_seed_answer`, an answer supplied by the caller) can never be served to chat or embed users.
- Evidence: in single-tenant mode `evalScope` mints the live `single` scope (`src/lib/rag/tenant/eval.ts`). 06-17 allows only `chat` and `embed` as entry profiles, so eval stores under a production key. 06-41 Task 1 then stores an arbitrary seed answer through the real path. The threat row "eval seeds entries in the eval tenant only" is false in single-tenant mode, and no test covers it.
- Example fix: give eval its own entry profile in the key hash (a separate key namespace), accept `cache_seed_answer` only when the eval run is a fixture or non-production run, and add a test that fails first: an eval-seeded entry is a miss for chat and embed with the same text, vector and scope.

### 06-22 (Tasks 2 and 4), and 06-30 Task 1 verify: executors install packages
- Required: executors never install packages. Only the orchestrator installs, after the user approves at the checkpoint, on or after 2026-12-04, with `npm install --save-exact --before=<cutoff>`.
- Evidence: 06-22 Task 2 is `type="auto"` and its action runs `npm install --save-exact --before=$CUTOFF ...`. Task 4 is `type="auto"` and runs `uv lock`, then `uv sync` and `uv run --extra cache`. 06-30 Task 1's `<automated>` runs `uv run --directory rag-sidecar --extra cache`, which installs the extra into the environment. The date and `--before` rules themselves are correct.
- Example fix: make the install and lock steps orchestrator-run steps after the checkpoint (for example a `checkpoint:human-action` or an orchestrator-only marker), and have the executor tasks only verify the existing lock (`--locked`, `npm ls`) and change config and code.

### 06-28: no two-tenant test for the voice path under the query layer
- Required: every component that reads or writes tenant data has a two-tenant test, and the brief names the voice path explicitly.
- Evidence: 06-28 adds `history` and the classification to `/api/internal/voice-rag` and runs condense, normalize_dates and translate for voice. Neither its behaviours nor 06-31's contain a tenant case. The index's two-tenant list (06-04 ... 06-42) names no voice plan. 06-42 adds matrix rows for "every query-layer path", but it does not name voice-rag with history.
- Example fix: add a voice-rag case with the layer on and history present. A scope token for tenant B, with history taken from a tenant A conversation, retrieves only B's chunks, and the condensed query never leaves B's scope.

## WARNINGS

1. **06-21 (RedisVL invalidation gaps).** Invalidation is emitted only from `publish.ts` and `soft-delete.ts`, is best-effort, and is skipped silently when it fails. A cached refusal has empty `source_versions`, so `rag_cache_sources_current` cannot catch it. A refusal therefore survives a new document (from a failed emission, or a path that does not call publish, or a hard delete) for up to the 10-minute refusal TTL. Spec rule 5 says a new upload fixes refusals "at once". Required: a RedisVL refusal hit is re-validated against the tenant's latest document change (for example a per-tenant generation stamp), or the plan records the gap as accepted.
2. **06-31 / 06-28 (voice switch interplay).** With `VOICE_SERVER_QUERY_REWRITE=true` and the app's `RAG_QUERY_LAYER=false`, the agent skips its own rewrite and the server ignores the history. Nobody condenses follow-ups, which is worse than today. Required: either off switch alone gives today's behaviour, for example the server condenses voice history even with the layer off, or the agent falls back. Add a test.
3. **Phase 5.1 edges (stale index).** `05.1-prompt-injection-defense/05.1-01-PLAN.md` now exists, so the index's "Phase 5.1 has no plan files yet" is out of date. Phase 5.1's CONTEXT, PATTERNS and RESEARCH name more shared files than the index's 7. These Phase 6 plans first edit a file Phase 5.1 also names, so they must gain a 5.1 edge: **06-01** (contracts `__init__.py`, `eval_run.py`), **06-02** (five env locations, manifest), **06-05** (`export_schemas.py`), **06-09** (`golden.py`), **06-10** (`rag/config.ts`, `rag/deps.ts`), **06-13** (`rag/types.ts`), **06-19** (`v2/pipeline.ts`), **06-22** (`next.config.js`, `rag-sidecar/pyproject.toml`), **06-27** (`rag/index.ts`, chat route), **06-28** (voice-rag route), **06-30** (sidecar `main.py`), **06-31** (`voice_agent.ts`, `rag_client.ts`), **06-33** (`generation/prompt.ts`), **06-34** (`report.py`, per the index), **06-38** (`eval/fixtures/golden.jsonl`), **06-45** (`AGENTS.md`). Later Phase 6 editors of the same files inherit the edge through the chain.
4. **06-30 / 06-22 (RedisVL extra).** If the human drops the RedisVL extra at the checkpoint, D-35 cannot be delivered. 06-30 stops by its precondition, and 06-46 Task 4 (real Redis) cannot run. CACHE-01 would then be incomplete, and the phase would need a decision change, not a skip.
5. **06-30 (config sync).** `REDIS_URL` is a new variable, but it is in neither `env-manifest.json` nor a sidecar env template. It is sidecar-only (D-35), so the five app locations do not apply, but it should be documented where the sidecar's other variables are, with a placeholder value.
6. **06-36 (hit path and the Phase 5 records).** A hit makes no `streamText` call, so the Phase 5 `onFinish` (`answerId`, `scheduleAnswerFinish`, answer record) does not run. The plan does not say whether a hit produces an answer record and citation metadata for feedback and the trace. Required: say what happens, and test it.
7. **Fragile baselines (06-21 Task 3 and any gate on `src/lib/rag/ingest/**`).** Phase 3 is executing. `soft-delete.ts` does not exist yet (03.1-39 creates it), and `publish.ts` has already moved once. The executor must re-measure these gates when the plan starts, not trust `@e6dea83`.
8. **06-RESEARCH.md Open Questions.** The section is not marked `(RESOLVED)`. CONTEXT A-1..A-10 resolve every item, so add the marker to keep the record consistent.
9. **06-41 scope.** 4 auto tasks is the borderline threshold. 06-22 and 06-46 are at 4 too, but they contain checkpoints.

## INFO

- `RAG_QUERY_LLM_MODEL` is an env-selected internal model, not a chat model in the user-selectable list, so the five-location model rule does not apply. No plan adds a chat model.
- Off switches checked and holding: `RAG_QUERY_LAYER` (parity in 06-13, 06-27, 06-44), `RAG_QUERY_FRAMEWORK=llamaindex`, `RAG_SEMANTIC_CACHE=off` (byte-identical stream, 06-36), `RAG_SEMANTIC_CACHE_EMBED_STORE=false`, `p_include_undated DEFAULT false`, and the layer-gated answer-language line (byte-identical prompt, `{{context}}` untouched, 06-33). AGENTS.md §14 suites (chat-strict, chat-websearch, chat-source-images, characterize-chat, characterize-embed, characterize-voice) are in the verify commands of 06-19, 06-27, 06-28, 06-33 and 06-36. Cache tenant isolation in pgvector (06-12: `tenant_key` filter, RLS with no policies, grants, source re-validation, three statement triggers covering publish and soft delete, which set `is_current` and `status`) and RedisVL (06-30: tenant and key-hash tag filters) is sound apart from the blockers above.

## Per-plan summary

| Plan | Blockers | Warnings |
|------|----------|----------|
| 06-17 | B1 | - |
| 06-32 | B1 | - |
| 06-41 | B2 | W9 |
| 06-22 | B3 | W3, W4 |
| 06-30 | B3 (verify command) | W3, W4, W5 |
| 06-28 | B4 | W2, W3 |
| 06-31 | - | W2, W3 |
| 06-21 | - | W1, W7 |
| 06-36 | - | W6 |
| 06-01, 06-02, 06-05, 06-09, 06-10, 06-13, 06-19, 06-27, 06-33, 06-34, 06-38, 06-45 | - | W3 |
| all others | - | - |

## Recommendation

4 blockers and 9 warnings need revision. Return to the planner with this file.
