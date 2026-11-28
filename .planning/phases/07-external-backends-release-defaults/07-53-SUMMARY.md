---
phase: 07-external-backends-release-defaults
plan: 53
subsystem: rag-backend
tags: [lex-05, bm25, weaviate, qdrant, pgvector, vector-sync, conformance]

requires:
  - phase: 04.4-true-bm25-lexical-scoring
    provides: "config.v2.lexicalScoring, LEXICAL_SCORING_DEFAULTS, BackendSearchRequest.lexicalScoring and rag_bm25_search_chunks (04.4-08); the D-29 hand-off note (04.4-14)"
  - phase: 07-external-backends-release-defaults
    provides: "scoped Qdrant builders (07-03), Qdrant adapter and store (07-07), Weaviate adapter and store (07-08), drain (07-09), factory fallback (07-12), vector-sync CLI (07-13), canary (07-14), conformance (07-16), purge sweep (07-36)"
provides:
  - "src/lib/rag/backend/lexical-params.ts: externalLexicalParams(config), sameLexicalParams, recordedLexicalParams, LexicalParamsMismatchError (extends BackendNotReadyError, lexicalReason lexical_params_mismatch), lexicalParamsMismatchMessage, LEXICAL_PARAMS_MISMATCH, LEXICAL_BINDING, createLexicalParamsCheck, LexicalParamsStore, isLexicalParamsStore"
  - "Weaviate: the collection's inverted index takes bm25k1/bm25b from the configured pair and records it as lexical_bm25 in the JSON description; ensure and the reader refuse a differing pair (backend_not_ready, pgvector serves)"
  - "Qdrant (query-bound): the lexical node sends query.text = { query, scoring: { bm25: { k, b } } } for a non-default pair; collection metadata records lexical_bm25; ensure refreshes a differing record in place with one [Vector Sync] line"
  - "npm run rag:vector-sync -- rebuild-lexical --target weaviate|qdrant [--confirm]"
  - "k1 1.5 parity on pgvector, Weaviate and Qdrant with the k1 1.2 control and a two-tenant check"
affects: [07-38, 07-39, 07-51, 07-33, 04.4-15]

actuals:
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "One source for the external BM25 pair: externalLexicalParams(config); stores and readers take a lexicalParams source whose default loads the server configuration"
    - "Index-bound vs query-bound parameters: the recorded pair describes how an index was built; an index-bound store with another pair is never served, a query-bound store only refreshes its record"

key-files:
  created:
    - src/lib/rag/backend/lexical-params.ts
    - tests/rag/backend/lexical-params.test.ts
    - tests/rag/sync/lexical-rebuild-cli.test.ts
    - tests/rag/backend-conformance/lexical-params-parity.test.ts
  modified:
    - src/lib/rag/backend/weaviate/collection.ts
    - src/lib/rag/backend/weaviate/adapter.ts
    - src/lib/rag/backend/qdrant/collection.ts
    - src/lib/rag/backend/qdrant/adapter.ts
    - src/lib/rag/backend/qdrant/scoped-request.ts
    - src/lib/rag/backend/qdrant/client.ts
    - src/lib/rag/sync/stores/weaviate.ts
    - src/lib/rag/sync/stores/qdrant.ts
    - src/lib/rag/sync/cli.ts
    - tests/rag/backend/weaviate-fake.ts
    - tests/rag/backend/qdrant-fake-client.ts
    - tests/rag/sync/qdrant-store.test.ts
    - tests/rag/sync/weaviate-store.test.ts

key-decisions:
  - "Off state (orchestrator decision 1): while the effective mode is ts_rank_cd, Weaviate and Qdrant keep 1.2/0.75 even when RAG_LEXICAL_BM25_K1/B are set"
  - "Qdrant branch (orchestrator decision 2): query-bound. Pinned client 1.20.0 types and a probe of the pinned server qdrant/qdrant:v1.20.2 agree: TextQueryInput { query, scoring: { bm25: { k, b } } }, the text index schema only takes scoring { type: bm25 } and says 'k1 and b are set per query'. No rebuild; metadata refresh plus one [Vector Sync] line"
  - "Qdrant omits scoring when the pair equals the defaults (any mode): the server default is 1.2/0.75 (probe: identical scores with and without), so the default request stays byte-identical to the base"
  - "Real-store order equals the reference on all three backends (orchestrator decision 3 not triggered); scores recorded below"
  - "Parity margin 7% instead of 10%: a 10% margin at both settings is unreachable for k1 1.2 vs 1.5 at b 0.75 (see Deviations)"

requirements-completed: [LEX-05, RET-06]

coverage:
  - id: D1
    description: "k1 and b reach both stores from config.v2.lexicalScoring through externalLexicalParams; defaults whatever the variables say while the mode is ts_rank_cd"
    requirement: LEX-05
    verification:
      - kind: unit
        ref: "tests/rag/backend/lexical-params.test.ts#tracer k1 1.5 reaches qdrant / tracer k1 1.5 reaches weaviate collection / off equals defaults whatever the variables say"
        status: pass
    human_judgment: false
  - id: D2
    description: "Default creation bodies and search requests equal the base-commit snapshots (apart from the new lexical_bm25 record)"
    requirement: LEX-05
    verification:
      - kind: unit
        ref: "tests/rag/backend/lexical-params.test.ts#default requests are deep-equal to the base snapshot"
        status: pass
    human_judgment: false
  - id: D3
    description: "A mismatched index-bound collection is refused on ensure and on reads; the factory serves pgvector with backend_not_ready"
    requirement: LEX-05
    verification:
      - kind: unit
        ref: "tests/rag/backend/lexical-params.test.ts#mismatch falls back to pgvector"
        status: pass
    human_judgment: false
  - id: D4
    description: "rebuild-lexical: dry report without writes (exit 2), confirmed rebuild with re-sync (exit 0 when every tenant is ready), matching collections untouched, Qdrant refresh only"
    requirement: LEX-05
    verification:
      - kind: unit
        ref: "tests/rag/sync/lexical-rebuild-cli.test.ts"
        status: pass
      - kind: integration
        ref: "tests/rag/backend-conformance/lexical-params-parity.test.ts#after rebuild-lexical to k1 1.2 (real Weaviate and Qdrant)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Parity at k1 1.5 and the k1 1.2 control on pgvector, Weaviate and Qdrant, tenants kept apart"
    requirement: RET-06
    verification:
      - kind: integration
        ref: "CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary tests/rag/backend-conformance (local compose, pinned images)"
        status: pass
    human_judgment: false

duration: ~3h
completed: 2026-11-28
status: complete
---

# Phase 07 Plan 53: BM25 k1 and b on Weaviate and Qdrant (LEX-05) Summary

**Weaviate and Qdrant now score with the same k1 and b as pgvector, taken from `config.v2.lexicalScoring`. Each collection records its pair, a Weaviate index built with another pair is not served until `rag:vector-sync -- rebuild-lexical` rebuilds it, and on one fixture all three backends return the reference BM25 order at k1 1.5 and at k1 1.2.**

## Qdrant branch: query-bound

- Pinned client `@qdrant/js-client-rest` 1.20.0, `generated_schema.d.ts`: `TextQuery { text: TextInterface }`, `TextInterface = string | TextQueryInput`, `TextQueryInput { query: string; scoring?: { bm25: Bm25Params } }`, `Bm25Params { k?: number; b?: number }` ("Default is 1.2" / "Default is 0.75"). The text index's `TextScoringParams` is only `{ type: "bm25" }`, documented "`k1` and `b` are set per query".
- Probe of the pinned server image (`qdrant/qdrant:v1.20.2`, docker-compose.backends.yml), three points, tenant-scoped `idf.corpus`: `text: "alpha"`, `{ query: "alpha" }` and `{ query, scoring: { bm25: { k: 1.2, b: 0.75 } } }` all score 0.6640418 / 0.61339456; `k: 1.5` scores 0.69263697 / 0.6326972; `k: 3, b: 0` scores 1.074294 / 0.47000363. These match the Lucene reference exactly.
- What is sent: the lexical node only, `query: { text: { query: "<tokens>", scoring: { bm25: { k: <k1>, b: <b> } } } }`; the dense node never carries it; `params` is unchanged (`PARAM_KEYS` did not grow). The pair is left out when it equals the defaults, so the default request stays byte-identical to the base.
- `scoped-request.ts`: the document form accepts `text` as a string or as exactly `{ query: string, scoring?: { bm25: { k?: number, b?: number } } }` (finite numbers, no other key, no other scorer). It is still a lexical query, so the tenant `idf.corpus` is still injected and asserted; global idf and the forbidden selectors are refused as before.
- Collection metadata records `lexical_bm25 { k1, b }`. `ensureQdrantCollection` refreshes a differing record with `updateCollection(name, { metadata: { lexical_bm25 } })` and one `[Vector Sync] qdrant collection for profile <id>: recorded BM25 pair refreshed from ... to ... (k1 and b are sent per query; no rebuild)` line. Reads never refuse on the recorded pair.

## Weaviate: index-bound

- `weaviateCollectionSpec(profileId, dims, params)` writes `bm25k1`/`bm25b` from the pair and `lexical_bm25` into the JSON description. `describeWeaviateCollection` returns `lexicalParams` (the defaults for a description without the field, i.e. a collection created before this plan).
- `ensureWeaviateCollection` throws `LexicalParamsMismatchError` on a differing recorded pair. The sync store logs the message once per (profile, pair) as `[Vector Sync] ...`; drain rows fail with `backend_not_ready:collection_missing` and stay retryable.
- `createWeaviateReader` checks the recorded pair through the read client at most once per 30 s (`LEXICAL_PARAMS_CHECK_TTL_MS`, asserted equal to `READINESS_TTL_MS`) per (target, profile, configured pair) and process. A mismatch throws before any query and logs one `[RAG Backend]` line per window. A failed describe lets the search proceed. The message: `[RAG Backend] weaviate collection for profile <id> was built with BM25 k1 1.2, b 0.75 but the configuration says k1 1.5, b 0.75; it is not served until `npm run rag:vector-sync -- rebuild-lexical --target weaviate --confirm` rebuilds it` (no tenant key, no text).

## rebuild-lexical

- `npm run rag:vector-sync -- rebuild-lexical --target weaviate|qdrant` prints one line per synced profile (collection name, recorded pair, configured pair, `would rebuild` / `would refresh the record ...` / `matches` / `no collection`) and a count line ending "on --confirm every tenant of this profile is served by pgvector until the rebuild finishes" when something would be rebuilt. It exits 2 with no store or RPC write (it only reads `rag_vector_sync_profiles`).
- `--confirm`: the target must be enabled (backfill's message otherwise, exit 1). Each mismatched Weaviate collection is deleted and created again with the configured pair, then reconcile (enqueues every document of the empty collection), drain and a second reconcile run; exit 0 only when every tenant is ready. Tenants are re-created only by the worker's `ensureTenant` from canonical keys. Matching collections are left alone. For Qdrant it refreshes the record and deletes nothing.

## Real-store parity

Ran locally against the pinned compose images (qdrant v1.20.2, weaviate 1.40.7). The Docker daemon was started in the session. Fixture: tenant A, query `[parityrare, paritycommon]`; P = rare term once in 60 tokens, Q = common term ×30, R = common term once in 14 tokens, 6 docs with the common term once in 20 tokens, 4 one-token fillers; tenant B decoys would rank first if they leaked.

| Backend | k1 1.2 (P, Q, R) | k1 1.5 (Q, P, R) |
| --- | --- | --- |
| Reference (TypeScript) | 1.122165, 1.034358, 0.543881 | 1.158672, 1.068974, 0.548818 |
| pgvector `rag_bm25_search_chunks` | equal to 5 decimals | equal to 5 decimals |
| Qdrant | 1.1221654, 1.0343581, 0.5438808 | 1.1586719, 1.0689735, 0.5488181 |
| Weaviate | 0.5100752, 0.4701627, 0.2472186 | 0.4634687, 0.4275894, 0.2195272 |

All three return the reference order at both settings; the named swap is P ↔ Q. Weaviate's scores are the reference divided by (k1 + 1) (it leaves out the constant numerator factor), so its order is the same. Tenant B never received a tenant A id on any backend, at either setting, and the reverse holds too.

The external parity uses its own collection: in its PGlite database the only synced profile is `qwen3-8b-1024` (the legacy profile is retired there, vectors in `chunk_embeddings`). A collection built with k1 1.5 under the shared `openai-3-small-1536` name would be refused, by design, by the canary files running in parallel against the same store. With that, `tests/rag/canary` + `tests/rag/backend-conformance` passed 3 times in a row as CI runs them (11 files, 156 passed, 4 skipped).

## Task commits

1. Task 1 (tracer): `b12d04c4` feat(07-53): Weaviate and Qdrant take BM25 k1 and b from config.v2.lexicalScoring
2. Task 2: RED `a9f8d02f`, GREEN `768bc3df` (read-side refusal and rebuild-lexical)
3. Task 3: `bc53e844` test(07-53): k1 1.5 parity on pgvector, Weaviate and Qdrant with the k1 1.2 control
4. This SUMMARY.

Task 1's base snapshots (Weaviate and Qdrant creation bodies, one search request per store) were captured by running the snapshot tests against the unmodified base commit before any source edit, then moved into `lexical-params.test.ts`.

## Tests that failed before the fix

- RED `a9f8d02f`, on assertions: the five CLI cases (`rebuild-lexical` was an unknown subcommand, exit 2 with no plan lines) and "mismatch falls back to pgvector" (the Weaviate reader queried the store).
- Guard mutation checked on the real Weaviate: building the collection with the default pair under k1 1.5 fails "weaviate returns the reference order at k1 1.5" and the request-level case.

## Behaviour changes

- Default configuration: none in ranking or requests. Qdrant and Weaviate collections created from now on carry `lexical_bm25 { k1: 1.2, b: 0.75 }` in metadata or the description; existing collections without it read as the defaults and stay valid.
- `RAG_LEXICAL_SCORING=bm25` effective with a non-default pair: Qdrant queries carry the pair; Weaviate collections built with another pair are refused (pgvector serves, `backend_not_ready`) until rebuild-lexical runs.

## Deviations

1. **Parity margin 7%, not 10% (plan Task 3).** For a single query term, the BM25 order of two documents never depends on k1 (they cross only when `tf_Q·L_P = tf_P·L_Q`, which has no k in it), so the flip needs two terms with different IDF. Even then, the ratio of two documents' scores changes between k1 1.2 and 1.5 by at most about 1.219 (search over documents up to 300 tokens). A 10% margin on both sides needs 1/(0.9²) ≈ 1.235, so it cannot be reached. The fixture uses the best margin found with documents of at most 60 tokens: 7.8% (k1 1.2) and 7.7% (k1 1.5); the self-check asserts ≥ 7%. The order assertions are unchanged and strict, and pgvector's scores are additionally asserted equal to the reference.
2. **`src/lib/rag/backend/qdrant/client.ts`**: `updateCollection` added to the `QdrantApi` pick (allowed by the plan, listed here as asked).
3. **Existing shape assertions updated**: `tests/rag/sync/qdrant-store.test.ts` and `tests/rag/sync/weaviate-store.test.ts` asserted the exact metadata, description and describe results; they now include `lexical_bm25` / `lexicalParams` (the plan adds those fields). The isolation suites `tests/rag/canary`, `tests/rag/backend/qdrant-scoped.test.ts` and `tests/rag/backend-conformance` (cases, dataset) have no edited assertion.
4. **Qdrant omits the scoring object whenever the pair equals the defaults**, not only when the mode is ts_rank_cd. Under bm25 with 1.2/0.75 the server's default is the same pair (probe), so scores are identical and the request stays equal to today's.
5. **Weaviate creation body**: equal to the base snapshot apart from the new `lexical_bm25` key in the description (the plan states this exception for Qdrant's metadata; the same record is required for Weaviate by the "both stores record the pair" truth).
6. The search for a reachable margin and the probe ran in the scratchpad only; no fixture file under `eval/fixtures/parse/` was touched.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no Phase 1 type errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok
- `npx eslint` on every changed file: 0 errors in changed code. The 2 errors reported are pre-existing in the untouched `src/lib/rag/backend/weaviate/client.ts` (`_kind`, `_apiKey`).
- `npx vitest run` on every test file importing a changed module plus `tests/rag/backend` and `tests/rag/sync`: 33 files passed, 497 tests passed, 48 skipped
- `node --import tsx --test tests/rag-db/vector-sync-cli.test.mts tests/rag-db/vector-sync-purge-drain.test.mts tests/rag-db/vector-sync-tracer.test.mts`: 21/21
- Conformance and canary on the real stores: `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary tests/rag/backend-conformance` with the compose backends, 3 consecutive runs: 11 files, 156 passed, 4 skipped. In CI mode without the URLs, the two external parity cases fail; outside CI mode they are skipped.
- Off state: `npm run test-rag -- --out eval/out/p7-53` PASS and `jq -e '.passed == true and .paired.all_zero == true' eval/out/p7-53/gate.json` → true; `npm run test-rag -- --fixture-mode ingest --out eval/out/07-53-ingest` PASS
- `uv run --directory eval python -m rag_eval.phase44_gate --spec eval/config/phase44-comparison.json --out eval/out/p7-53-phase44`: exits 1 at HEAD and exits 1 at the base commit `11d5a71a` (run in a separate worktree). Both report the same `v2-lexical-bm25-on-*` recall drops (the known `not_flipped` state of 04.4). The two gate.json files are identical apart from four wall-clock `retrieval_total.p95_ms` values, so this plan changes no cell

## Hand-offs (not done here)

- Documentation: plan 07-51 (amended for LEX-05) adds the rebuild command and the mismatch rule to README_RAG_PIPELINE.md and AGENTS.md.
- Live check: plan 07-33 runs `tests/rag/backend-conformance/lexical-params-parity.test.ts` against the hosted backends with the live canary.
- REQUIREMENTS.md: LEX-05 stays `Pending` until this SUMMARY exists and G1 and G2 of the 04.4 verification close (04.4-VERIFICATION, recommendation 7).

## Operator actions

- Before setting `RAG_LEXICAL_SCORING=bm25` with a non-default `RAG_LEXICAL_BM25_K1`/`_B` on a deployment with Weaviate enabled: run `npm run rag:vector-sync -- rebuild-lexical --target weaviate` (dry), then with `--confirm`. Every tenant of the rebuilt profile is served by pgvector until it finishes. Qdrant needs no rebuild; `rebuild-lexical --target qdrant --confirm` only refreshes the recorded pair (the drain's ensure does the same on its own).

## Decisions for STATE

- LEX-05 Qdrant binding: query-bound (`TextQueryInput.scoring.bm25.{k,b}`), Weaviate: index-bound (rebuild).
- External backends keep 1.2/0.75 under ts_rank_cd (one line in `externalLexicalParams` if the owner lifts it later).
- Parity margin rule for k1 1.2 vs 1.5 at b 0.75: 7% (10% is mathematically unreachable).
