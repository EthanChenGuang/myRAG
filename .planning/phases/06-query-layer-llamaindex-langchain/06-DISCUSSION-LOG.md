# Phase 6: Query Layer (LlamaIndex & LangChain) - Discussion Log

> **Audit trail only.** Do not use this file as input to planning, research or execution agents.
> The decisions are in CONTEXT.md. This log keeps the alternatives that were considered.

**Date:** 2026-11-24
**Phase:** 06-query-layer-llamaindex-langchain
**Mode:** `--auto`. Every area was auto-selected, and every question was resolved with the recommended option (the user's standing instruction: "all questions follow your recommendations"). The locked specs (query-rewrite-gate, semantic-cache) were not re-opened.
**Areas discussed:** Framework seam and contract, Pipeline integration and variant fusion, Router and gate integration, Query LLM and prompts, LangChain adapter and zod isolation, Translation, Switches and budgets, Voice profile, Semantic cache, Evaluation and completion, Config UI

---

## Framework seam and contract

| Option | Description | Selected |
|--------|-------------|----------|
| One `QueryTransformer` interface; gate, router, post-checks, budgets shared; only LLM generation per framework | Comparison measures the framework, not different rules | ✓ |
| Two complete independent query pipelines | Duplicated safety logic; drift | |
| LangChain drives retrieval end to end | Breaks the `src/lib/rag/` tenant boundary | |

**Choice:** [auto] Shared interface with a Pydantic `QueryPlan` and per-transform output models.

---

## Pipeline integration and variant fusion

| Option | Description | Selected |
|--------|-------------|----------|
| v2-only, master switch off by default, new optional stages before `embed`, variants through Phase 4 D-13 (one RRF, one rerank on the standalone query) | Off = byte-identical; reuses Phase 4 seams | ✓ |
| Also run under legacy | Breaks legacy parity, needs a second variant path | |
| Rerank per sub-question | Latency stacking (research "Avoid") | |

**Choice:** [auto] v2-only; single fusion and rerank; sub-question coverage reservation (≤ 4) switchable in retrieval params; HyDE never used for rerank or refusal.

---

## Router and gate integration

| Option | Description | Selected |
|--------|-------------|----------|
| Gate rules primary; `classifyQuery` result passed in by each entry point to suppress or add decompose | Reuses the classifier without a second call or log spam | ✓ |
| Call `classifyQuery` inside the pipeline | Duplicate call and verbose logs | |
| Classifier only, gate advisory | Contradicts the locked gate spec | |

**Choice:** [auto] Router as above. R12 skips retrieval and strict refusal only with the layer on. R2 range becomes a date filter that keeps undated chunks, in the request time zone (else UTC).

---

## Query LLM and prompts

| Option | Description | Selected |
|--------|-------------|----------|
| One small model via the existing OpenRouter AI SDK provider, `generateObject`, temperature 0 | No new key; structured output from generated Zod | ✓ |
| Separate provider key for query LLM | More config, no gain | |
| Rewrite in the sidecar | Extra network hop on the hot path | |

| Option | Description | Selected |
|--------|-------------|----------|
| Each framework keeps its own library prompts + one shared mandatory suffix | Fair comparison; same safety rules | ✓ |
| Identical prompts in both frameworks | Comparison reduced to plumbing | |

**Choice:** [auto] As above; per-language HyDE prompts; protected-token and length post-checks shared.

---

## LangChain adapter and zod isolation

| Option | Description | Selected |
|--------|-------------|----------|
| One adapter dir, dynamic import, wraps a narrow `searchVariant`/`finishRetrieval` port, scope bound server-side; zod 4 nested under `@langchain/core`; CI `npm ls zod` and boundary rules | Default path never loads LangChain; zod 3 untouched | ✓ |
| Migrate the app to zod 4 | Large blast radius across all schemas | |
| Host LangChain in the Python sidecar | Hop on the hot path; not the JS classes the requirement names | |

| Option | Description | Selected |
|--------|-------------|----------|
| `ChatOpenAI` (transitive dep) with the OpenRouter base URL | One fewer package | ✓ |
| `@langchain/openrouter` | Extra package, medium adapter risk | |

**Choice:** [auto] As above; package install needs the user's approval.

---

## Translation

| Option | Description | Selected |
|--------|-------------|----------|
| KB language shares via a server-role SQL function with tenant-key checks, cached 10 min per tenant | Cheap, tenant-safe | ✓ |
| Compute shares from retrieved candidates | Not the KB share XLG-01 defines | |

**Choice:** [auto] Translator in the Phase 4 D-22 slot under both frameworks; per-embedding-profile disable list; cross-language answer instruction appended by `createEnhancedRAGPrompt` (never editing `RAG_SYSTEM_PROMPT`).

---

## Switches and budgets

| Option | Description | Selected |
|--------|-------------|----------|
| Master switch off; sub-switches default to the recommended profile (HyDE off) but inert under the master | One switch to try, one to roll back | ✓ |
| Every sub-switch default off | Many switches to turn on to reach the recommended setup | |

**Choice:** [auto] Timeouts chat condense 600 / translate 600 / expand 700 / decompose 800 / HyDE 900 / cache 150 ms, voice condense 300 ms, group deadline 900 ms; query-stage budgets chat p95 1,200 ms, voice p95 300 ms, report-only. Skipped transforms are `degraded` per Phase 2 D-05 (locked).

---

## Voice profile

| Option | Description | Selected |
|--------|-------------|----------|
| Condense server-side in the voice profile; voice-agent switch `VOICE_SERVER_QUERY_REWRITE` (off = today's agent rewrite) | Same gate and protected-token rules for voice; reversible | ✓ |
| Keep rewrite only in the voice agent | Gate, budgets and tracing not applied to voice | |

**Choice:** [auto] Voice runs gate + condense + date normalization (+ translate if allow-listed) only; framework switch does not apply to voice.

---

## Semantic cache

| Option | Description | Selected |
|--------|-------------|----------|
| Check after condense, chat and embed, strict/balanced, v2 only; store in `after()`; voice not cached | Follows the spec's standalone-query key; never on the streaming path | ✓ |
| Check before condense | Spec forbids raw follow-up keys | |

| Option | Description | Selected |
|--------|-------------|----------|
| btree prefilter on tenant + key hash + profile, exact distance, no HNSW | Entries per key are few; no per-dims index | ✓ |
| HNSW per profile like `chunk_embeddings` | More migrations for little gain | |

**Choice:** [auto] Server-role functions with tenant-key checks; invalidation in the publish/soft-delete transactions; fail-open to miss; RedisVL in a sidecar `cache` extra; calibration tool writes `semantic-cache.json`.

---

## Evaluation and completion

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic fake query LLM for both frameworks; `compare frameworks` paired report; golden additions after layer-off parity | No live calls in CI; Phase 2 D-25 pattern | ✓ |

**Choice:** [auto] Completion = layer-off parity, default-framework slices hold/improve, schema-identical frameworks, delay/failure tests, cache gates.

---

## Config UI

| Option | Description | Selected |
|--------|-------------|----------|
| One "Query layer" panel + authenticated cache-clear admin route | Matches Phase 3/4 panel pattern | ✓ |

---

## Claude's Discretion

- File layout beyond named paths; prompt suffix wording and HyDE prompts; personal-data regexes; trace and UI strings; whether the group deadline is a stage or a runner feature.

## Deferred Ideas

- Voice answer caching; per-tenant query model; LlamaIndex/LangChain Python in the sidecar; Redis LangCache backend; learned router; removing the unused `llamaindex` npm dependency.
