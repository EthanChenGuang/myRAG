---
phase: 06-query-layer-llamaindex-langchain
plan: 28
subsystem: rag-query
tags: [query-layer, voice, history, tenant-isolation, latency-budget]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-19 runQueryLayer with the voice allow-list (condense, normalize_dates; hyde/expand/decompose voice_blocked) and per-transform timeouts"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-28 voice under v2 and the voice-rag route test; 04-41 two-tenant v2 harness (read only)"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-20 last edit of the voice-rag route (tagged context field)"
provides:
  - "/api/internal/voice-rag optional history: at most 6 turns, role user|assistant, content 1-1,000 chars, binding (Zod); malformed or oversized history → 400 {error: 'Invalid history'}"
  - "Session binding: base64url(SHA-256(raw x-rag-scope-token)).slice(0, 22); turns with another binding are dropped before runRetrieval and logged as a count only"
  - "voice_history trace record (counts history_kept, history_dropped) when the body carries history; the route then owns and finishes the trace"
  - "classifyQuery once at entry, only when RAG_QUERY_LAYER is 'true'"
  - "x-rag-server-query-rewrite: 1 when the voice profile will condense server-side (voiceServerCondenses() and no pipeline_fallback record)"
  - "voiceServerCondenses() exported from @/lib/rag (src/lib/rag/v2/switch.ts); HistoryTurn type exported from @/lib/rag"
affects: [06-31, 06-42]

actuals:
  tokens: 70000
  tasks: 2
  commits: 6
plan_head_before: aae1f56

tech-stack:
  added: []
  patterns:
    - "Route tests that wrap @/lib/rag exports use vi.doMock registered after each vi.resetModules(); a hoisted vi.mock factory survives resetModules and leaves the route on stale env and deps instances"

key-files:
  created:
    - tests/rag/voice-rag-two-tenant.test.ts
    - tests/rag/query/voice-budget.test.ts
  modified:
    - src/app/api/internal/voice-rag/route.ts
    - src/lib/rag/v2/switch.ts
    - src/lib/rag/index.ts
    - tests/rag/voice-rag-route.test.ts

key-decisions:
  - "Binding check is a plain string compare: the binding is a hash of a token the caller already holds, not a secret. It prevents accidental cross-session mixing by the agent and does not authenticate history; tenant isolation comes only from the verified scope token"
  - "The binding field allows /^[A-Za-z0-9_-]{1,64}$/; a well-formed but foreign binding is dropped, a missing or malformed one is a 400"
  - "The header decision lives in @/lib/rag (voiceServerCondenses), not the route: the boundary check forbids deep imports. It is false when the pipeline is blocked, when the effective pipeline is legacy (explicit legacy or a defaulted v2 that fell back), when the layer is off, when condense is in RAG_DISABLED_STAGES or RAG_QUERY_CONDENSE=false, or when condense_history is not in RAG_QUERY_VOICE_TRANSFORMS. The route also drops the header when the result carries a pipeline_fallback record"
  - "The header is set on 200 responses (results or empty) and on the 503 knowledge_base_unavailable response; 400/401/403 responses before retrieval never carry it"
  - "The route creates its own trace collector only when the body has a history field, so requests without history keep the pipeline-owned trace exactly as today"
  - "With RAG_QUERY_LAYER=true under the legacy pipeline the route still classifies once (the D-09 env rule shared with /api/internal/rag/run) but sends no header, so the agent keeps its own rewrite"

requirements-completed: [QRY-07]
requirements-advanced: [LAT-03]

coverage:
  - id: D1
    description: "History validation (6 ok; 7 turns, 1,001 chars, system role, missing binding → 400 with no search), binding filter and count-only log, voice_history trace counts, wire contract identical with and without history, classifyQuery off/on, header present (layer on, with and without history) and absent (condense_history not listed, condense disabled, layer off, legacy), token refresh drops earlier turns and retrieves the original query"
    requirement: QRY-07
    verification:
      - kind: integration
        ref: "tests/rag/voice-rag-route.test.ts (30 cases; 14 new)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Two tenants: a tenant-B token with tenant-A-bound history sends no A text to the query LLM, the embedder or the response, and every backend search carries B's scope; positive control with B-bound history reaches condense"
    requirement: QRY-07
    verification:
      - kind: integration
        ref: "tests/rag/voice-rag-two-tenant.test.ts (2 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "50 fake-timer voice runs, condense 100-500 ms, embed 50, search 100, fast rerank 150: max and p95 < 800 ms (max 600 ms); condense > 300 ms skipped with timeout and the original query embedded; hyde/expand/decompose only ever recorded disabled/voice_blocked with no LLM call; normalize_dates runs"
    requirement: QRY-07
    verification:
      - kind: unit
        ref: "tests/rag/query/voice-budget.test.ts (3 cases)"
        status: pass
    human_judgment: false
---

# Phase 6 Plan 28: Voice history in voice-rag Summary

**`/api/internal/voice-rag` now accepts recent turns bound to the session's scope token, drops turns from any other token before the query layer, classifies once when the layer is on, and tells the agent through `x-rag-server-query-rewrite: 1` when the server will condense. The JSON wire contract is unchanged, and voice stays inside its 800 ms budget with only the reduced transforms.**

## Tasks and commits

| Task | Commits |
|------|---------|
| 1 Optional history in voice-rag | `58ff513` test (RED, two-tenant), `e952942` test (RED, route), `1033732` feat, `b1a70a2` fix (boundary: header decision moved into `@/lib/rag`, disabled-condense case) |
| 2 Voice budget with the query layer | `a26cf9f` test |

## Behaviour changes
- With no `history` field and `RAG_QUERY_LAYER` off: nothing changes (same body, no header, no classification, pipeline-owned trace). The voice characterization and entry-point suites pass unchanged.
- A body with `history` is validated. A malformed history now returns 400 `{ "error": "Invalid history" }`. Before this plan the field was silently stripped.
- Turns bound to another token, including turns recorded before a voice token refresh, never reach query rewriting. The dropped count goes to the log (`[Internal RAG]`) and to the `voice_history` trace record.
- With the layer on under an effective v2, condense allowed for voice and not disabled, responses carry `x-rag-server-query-rewrite: 1`.

## RED evidence
- voice-rag-two-tenant.test.ts: the positive control failed on its assertion (`expected [] to have a length of 1`). The negative case passed on the old code because the field was stripped; it guards against a regression once history is accepted.
- voice-rag-route.test.ts: 10 new cases failed on assertions against the old route (history undefined, 200 instead of 400, no classification, header null, and so on).
- voice-budget.test.ts: no RED. The 06-19 layer already met every case, so Task 2 needed no product fix (same as 06-19's delays test). Temporarily lowering the budget to 500 ms made it fail at 600 ms, so the assertions do measure latency.

## Deviations
1. **Two files outside `files_modified`.** `src/lib/rag/v2/switch.ts` gains `voiceServerCondenses()`, and `src/lib/rag/index.ts` exports it and the `HistoryTurn` type. The first version read `getRagDeps()` and the types through deep imports, which `check-rag-boundary.mjs` rejects. The helper also checks the effective pipeline, so a defaulted v2 that serves legacy sends no header and the agent keeps its own rewrite.
2. **Trace field shape.** The dropped count is the `voice_history` record's `counts.history_dropped` (plus `history_kept`). The record exists only when the body has `history`.
3. **Route test mocking.** The route tests wrap `runRetrieval`, `classifyQuery` and `finishTrace` with `vi.doMock`, registered after each `vi.resetModules()`. Hoisted `vi.mock` broke two existing cases (stale env and deps).
4. **Two-tenant test uses a prompt-sensitive fake LLM.** Its condense output appends any placeholder code found in the prompt, so leaked history would show up in the embedded query and the results. Assertions cover the LLM prompt, the embedder inputs, the response body, the foreign markers, and the scope of every backend `search` call.
5. **Token refresh case** uses the canary query, so the original query has results. The gate may still route condense without history: any condense call is asserted to contain no earlier-turn text, and the embedded text is the original query.

## For 06-31 (agent side)
- Binding: `createHash('sha256').update(rawScopeToken, 'utf8').digest('base64url').slice(0, 22)`, recorded per turn under the token in use when the turn happened.
- The agent should skip its own rewrite only when the response carries `x-rag-server-query-rewrite: 1`.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 390 files, 6518 passed, 4 skipped, 0 failed
- `node --import tsx --test tests/*.test.mts`: 172 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1964 pass, 0 fail, 0 cancelled
- `check-rag-boundary.mjs` and its self-tests: pass (52/52)
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: OK
- `npm run test-rag -- --out eval/out/06-28`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-28-ingest`: gate PASS (7 skipped)
- Not run (not touched): Python suites, `gen:schemas` (no contract change), the frontend design check (no UI)

## Operator actions
None. No new env vars, packages, SQL or migrations.

## Self-Check: PASSED
