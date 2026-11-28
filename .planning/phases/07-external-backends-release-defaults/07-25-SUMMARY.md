---
phase: 07-external-backends-release-defaults
plan: 25
subsystem: rag-eval
tags: [regression, release-defaults, external-backends, qdrant, weaviate, eval-harness, run-manifest, adm-02, ret-09]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-24 regression CLI (plan, run, decide); 07-12 factory and test setter; 07-11 reconcile; 07-06/07/08 stores, adapters and the seed pattern; 07-36 purge in the drain; 07-37 forced source recheck"
  - phase: 04.1-hybrid-retrieval-and-rerank-on-by-default-proven-by-eval
    provides: "04.1-09 eval/decisions/04.1-retrieval-defaults.json (incumbent)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-21 run-config overlay; 04-35 last earlier run-eval editor"
provides:
  - "eval/harness/external-backends.mts: prepareExternalBackends (enable target, drain the backfill, reconcile to ready; real store with a URL, fake store through the factory test setter otherwise)"
  - "RunManifest.backend_snapshot (contract RunBackendSnapshot): backend, backend_impl, collection, hnsw_m, hnsw_ef_construction, lexical_mode, quantization"
  - "run-config overlay: RAG_GROUNDEDNESS, RAG_INGEST_PIPELINE, RAG_EMBEDDING_PROFILES (the D-17 names no earlier phase allowed)"
  - "eval tuning overrides (diversity, dup_cluster) reach the request hash and the diversify stage (04.2-06 hand-off, W-5)"
  - "fixture regression: two pre-registered plans, the test-split ledger, the provisional DefaultsDecision and defaults-fixtures.md"
affects: [07-30, 07-33, 07-43, 07-38, 07-39]

actuals:
  tokens: 38000
  tasks: 3  # W-5 hand-off + Task 1 + Task 2
  commits: 12  # 3 RED, 4 GREEN/fix, 1 test update, 2 records, 1 boundary fix, SUMMARY

tech-stack:
  added: []
  patterns:
    - "An eval test that needs several runEval calls runs each in a child process of the same test file (the app modules keep the first fixture edge's clients for the process)"

key-files:
  created:
    - eval/harness/external-backends.mts
    - tests/rag-db/eval-external-backend.test.mts
    - tests/rag-db/fake-edge-vendor-embeddings.test.mts
    - tests/rag/v2/eval-tuning-overrides.test.ts
    - eval/config/release-defaults.json
    - eval/decisions/regression-plan-fixtures-a.json
    - eval/decisions/regression-plan-fixtures-a.decision.json
    - eval/decisions/regression-plan-fixtures-b.json
    - eval/decisions/test-split-ledger.jsonl
    - eval/decisions/defaults-fixtures.md
  modified:
    - eval/harness/run-eval.mts
    - eval/harness/run-config.mts
    - eval/harness/fake-edge.mts
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/schemas/RunManifest.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - src/lib/rag/types.ts
    - src/lib/rag/v2/overrides.ts
    - src/lib/rag/v2/stages/rank.ts
    - src/lib/rag/index.ts
    - src/app/api/internal/rag/run/route.ts
    - tests/rag/v2/rank-order.test.ts
    - tests/rag-db/eval-v2-overlay.test.mts

key-decisions:
  - "W-5 (04.2-06 hand-off) closed here: the internal RetrievalOverrides carries diversity and dupCluster, toStageRetrievalOverrides (moved from the eval route into v2/overrides.ts, exported from @/lib/rag) maps the API blocks, evalTuningOverrides carries all three blocks, and the diversify stage now reads evalTuningOverrides like the hash does. table_lookup was already wired."
  - "The target is enabled after the corpus load, not before: createFixtureDatabase loads the prechunked corpus before the edge exists, and rag_vector_sync_set_target enqueues the backfill of every current document through the outbox (the production enable-on-existing-data path). The store is still written only by drain and reconcile; the test proves it from the call stacks."
  - "Real vs fake: QDRANT_URL / WEAVIATE_URL set → the production store (write key) and the production adapter built by the factory (read key), no test setter; unset → createFakeVectorStore installed with setExternalBackendForTests over createExternalBackend. Keys are only read by the client modules; the manifest has names and parameters only."
  - "The q62 isolated tenant is seeded too (through withQ62Tenant), so every fixture test item is served by the external store with no fallback (126 of 126 in each external stage-B run). table_split tenants exist only in ingest mode and are not seeded."
  - "backend_snapshot is written for every run (pgvector: m 64, ef_construction 200, lexical_mode postgres_fts, quantization none). It enters run_config_hash only for an external backend, so a pgvector run keeps its hash."
  - "Ingest-time switches RAG_INGEST_PIPELINE and RAG_EMBEDDING_PROFILES from a run config are layered into the ingest build env in --fixture-mode ingest (before the corpus loads); prechunked runs apply them at retrieval only."
  - "Fixture record: winner b.incumbent (pgvector, openai-3-small-1536, reranker auto); backend pgvector (no_valid_backend: all four external runs invalid as backend_impl_fake); RAG_INJECTION_CHECK=drop adopted under security_wins_ties, every other switch keeps the incumbent; confirmatory run held. Nothing in the code defaults, eval pins or thresholds changed."

patterns-established:
  - "Harness-only backend install: prepareExternalBackends uses the factory test setter; production wiring is unchanged"

requirements-completed: [ADM-02, RET-09]

coverage:
  - id: D1
    description: "Eval diversity and dup_cluster overrides reach the request hash and the diversify stage (04.2-06 hand-off)"
    requirement: RET-09
    verification:
      - kind: unit
        ref: "tests/rag/v2/eval-tuning-overrides.test.ts; tests/rag/v2/rank-order.test.ts#an eval diversity override reaches the diversify stage"
        status: pass
  - id: D2
    description: "External backends in fixture eval runs through resolveRetrievalBackend, seeded only via outbox/drain/reconcile, fallbacks visible, backend snapshot in run.json"
    requirement: RET-09
    verification:
      - kind: integration
        ref: "tests/rag-db/eval-external-backend.test.mts"
        status: pass
  - id: D3
    description: "D-17 overlay names accepted, unknown names still rejected"
    requirement: ADM-02
    verification:
      - kind: unit
        ref: "tests/rag-db/eval-external-backend.test.mts#D-17 overlay names; tests/rag-db/eval-v2-overlay.test.mts#the allow-list is"
        status: pass
  - id: D4
    description: "Fixture regression end to end and the provisional DefaultsDecision with its Markdown record"
    requirement: ADM-02
    verification:
      - kind: other
        ref: "uv run --project rag-sidecar python -c '<Task 2 validation>'; jq -e '.provisional == \"fixtures\"' eval/config/release-defaults.json"
        status: pass
---

# Phase 7 Plan 25: External backends in the eval harness and the fixture defaults record

The regression from plan 07-24 now runs end to end on the fixtures, across pgvector, Weaviate and Qdrant, through the same eval harness. A fixture run that picks an external backend seeds its store only through the outbox and the drain, reconciles it to ready and is served through the production `resolveRetrievalBackend` path. Every run's manifest records the backend implementation it measured. The provisional `DefaultsDecision` validates, keeps pgvector and changes no shipped default.

## Commits

| Task | RED | GREEN / fix |
| --- | --- | --- |
| W-5 hand-off (eval tuning overrides in the hash) | 80ef5203 | 282d55a4, 3e69152a (route imports through `@/lib/rag`) |
| 1 external backends in fixture runs, D-17 overlay | 7a513606 | 458d6e35, 4a8c3559 (allow-list test) |
| 2 fake DeepInfra bge-m3 dims (blocked stage A) | fdd65bda | c72b5590 |
| 2 fixture regression and record | — | efa894d7 (pre-registered plans), b08b1fa8 (record, ledger) |

Every RED commit failed on assertions or on a behaviour error (the old run-config threw `RunConfigError` for the new names), never on module-not-found.

## The W-5 hand-off (04.2 verification): eval tuning overrides were missing from the request hash

07-25-PLAN.md did not cover it, so I added it as a pre-task inside the plan's scope. The run configs this plan registers send `retrieval_overrides`, so without the fix the hash would not tell configs apart.

What I found at HEAD: 04.2-1x had already wired `table_lookup` into the internal type, the route, `evalTuningOverrides`, the hash and the search stage. `diversity` and `dup_cluster` were still accepted by the API contract and then dropped:
- the route did not map them;
- `evalTuningOverrides` returned only `table_lookup`;
- the diversify stage (`rank.ts`) called `effectiveTuningParams(..., undefined, ...)`.

So an eval `mmr_lambda` changed neither the hash nor the stage.

What I added:
1. `diversity` and `dupCluster` on the internal `RetrievalOverrides` (`src/lib/rag/types.ts`).
2. `toStageRetrievalOverrides` in `src/lib/rag/v2/overrides.ts`. It is the route's old mapper moved into the library, plus the two blocks, and it is exported from `@/lib/rag`.
3. `evalTuningOverrides` now carries all three blocks, for profile eval only.
4. The diversify stage reads the same effective parameters as the hash.

`dup_cluster` now reaches `effectiveTuningParams`. Its threshold has no query-time consumer, though: only the clustering build reads it, and the hash records only `dup_clusters: true`. So it moves neither the hash nor retrieval. That is correct, and the SUMMARY says so for the next reader.

## Behaviour changes

- Eval profile only: a `diversity` override in `retrieval_overrides` now changes the diversify stage and the retrieval config hash. Chat, embed and voice ignore it, as before (test: the chat hash is unchanged).
- `run.json` gains `backend_snapshot` on every run. `run_config_hash` changes only for external-backend runs.
- The run-config overlay accepts `RAG_GROUNDEDNESS`, `RAG_INGEST_PIPELINE` and `RAG_EMBEDDING_PROFILES`, each value-checked. Unknown names keep the existing error.
- The fake edge's DeepInfra route answers `BAAI/bge-m3` with 1024 dimensions. It used to answer 1536, so the `bge-m3-1024` re-embed failed with `embedding_profile_mismatch`.
- No app behaviour change and no code default change: `npm run test-rag` has `paired.all_zero == true` before and after.

## Tests that failed before the change

- `tests/rag/v2/eval-tuning-overrides.test.ts`: 3 of 4 (mapping, `evalTuningOverrides`, two lambdas giving two hashes).
- `tests/rag/v2/rank-order.test.ts`: the new diversify-override test.
- `tests/rag-db/eval-external-backend.test.mts`: the overlay names and all three fake-store scenarios.
- `tests/rag-db/fake-edge-vendor-embeddings.test.mts`: the bge-m3 dimension.
- `tests/rag-db/eval-v2-overlay.test.mts` "the allow-list is …": this one was already failing before this plan, because `RAG_DOC_ACCESS_GROUPS` (Phase 4.3) was never added to the expected list. I added it together with the three new names.

## Fixture regression (Task 2)

- Stage A, dev split, 8 configs on pgvector (`openai-3-small-1536` and `bge-m3-1024`, each with `none`, `local_bm25`, `auto` and `cohere:fake-quality-v1`). Ranking on Recall@10 plus correct refusal:

  | Config | Score |
  | --- | --- |
  | openai / cohere-fake | 0.6288 |
  | bge-m3 / cohere-fake | 0.6246 |
  | openai / none | 0.6018 |
  | openai / auto | 0.5986 |
  | openai / local_bm25 | 0.5986 |
  | bge-m3 / none | 0.5936 |
  | bge-m3 / auto | 0.5894 |
  | bge-m3 / local_bm25 | 0.5894 |

  Top two: openai/cohere-fake and bge-m3/cohere-fake.
- Stage B, test split, 25 registered configs:
  - the incumbent;
  - c1 and c2 on pgvector, weaviate and qdrant;
  - 17 ablations;
  - the confirmatory run.

  The plan was committed and pushed (efa894d7) before its first run.
- Results:
  - Winner: `b.incumbent` (pgvector, `openai-3-small-1536`, reranker `auto`).
  - c1 and c2 on pgvector: `keep_incumbent` (slice_regression, delta −0.2105, band 0.02).
  - All four external runs were served by the fake store with no fallback (126/126 traces each). They are invalid for a backend decision (`backend_impl_fake`), so the result is `no_valid_backend` and the record keeps pgvector.
  - `RAG_INJECTION_CHECK=drop`: adopt (`security_wins_ties`, ASR 0).
  - Every other ablation: `keep_incumbent`.
  - Confirmatory run: held.
  - Noise band: max(3 × spread, 0.02), Holm alpha 0.05, min_gate_n 10.
  - Every slice is listed as too small to gate (each has fewer than 10 fixture test items).
- Config hashes, every number and the use table are in `eval/decisions/defaults-fixtures.md`.
- Test-split uses: **26** against a budget of 25. One extra use came from `b.weaviate.c2`: my first foreground `run` hit the 10-minute tool timeout in the middle of that config, and the resume recorded a second use. I left the ledger as written, append-only, rather than editing it.
- Elapsed time:
  - Stage A: about 28 minutes wall time, which includes diagnosing and fixing the bge-m3 dimension bug (each config takes about 1 to 2 minutes).
  - Stage B: about 33 minutes wall time, including the interrupted first attempt.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`: ok. It first flagged the route's deep import, fixed in 3e69152a.
- `node scripts/check-config.mjs`, `check-language-literals.mjs`, `check-settings-classification.mjs`: ok.
- `npm run gen:schemas`: no diff after the contract commit.
- vitest:
  - `tests/rag/v2/{eval-tuning-overrides,rank-order,params-hash,tuning-params}.test.ts`: 153 passed.
  - The 22 test files that import `v2/overrides`, `v2/stages/rank` or the eval route: 363 passed.
  - `tests/eval-env-pin.test.ts`: 16 passed.
  - Full `npx vitest run` (because `src/lib/rag/types.ts` changed): see the result under "Full vitest".
- `node --import tsx --test`:
  - `tests/rag-db/eval-external-backend.test.mts`: 5 passed, 1 skipped (real Qdrant: `QDRANT_URL` unset).
  - `--test-name-pattern="backend_not_ready"`: 1 passed.
  - `tests/rag-db/eval-v2-overlay.test.mts` and `eval-query-layer-overlay.test.mts`: 49 passed, plus the allow-list test fixed after its pre-existing failure.
  - `tests/rag-db/fake-edge-vendor-embeddings.test.mts`: 2 passed.
- pytest:
  - `eval`: `tests/test_regression.py tests/test_regression_rules.py`, 40 passed.
  - `rag-sidecar`: `tests/test_contract_export.py tests/test_contract_models.py`, 80 passed.
- `npm run test-rag -- --out eval/out/p7-25-default` and `--out eval/out/p7-25-final`: gate PASS, `paired.all_zero == true`. The report-only absolute gate line (false refusal rate, en) was already failing before this plan and does not change the exit code.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/07-25-ingest`: gate PASS.
- Task 2 validation (DefaultsDecision and both RegressionPlans validate; provisional fixtures; backend pgvector; uses present) and every acceptance grep:
  - `prepareExternalBackends` = 1
  - `backend_impl` in run-eval = 1
  - provisional = fixtures
  - "too small to gate" = 2
  - test-split ledger lines = 26
- Not run:
  - The rag-db SQL suites: no SQL or migration change.
  - The workflow check: no workflow change.
  - The UI gate: no UI.
  - The acceptance's mutation guard (forcing readiness true in the harness): I did not run that mutation. The backend_not_ready test reads readiness from the database state the harness forced to stale, so the mutation would turn it red.

### Full vitest

`npx vitest run --maxWorkers=2` (the first full run at default workers was killed with exit 137 when the container restarted): 868 files passed, 2 failed, 3 skipped; 16396 tests passed, 2 failed.
- `tests/eval-phase33-run-configs.test.ts` "a name outside the allowlist is rejected" used `RAG_INGEST_PIPELINE` as its example of a disallowed name, which D-17 now allows. I changed the example to an unknown name, and the test passes.
- `tests/rag/characterize-chat.test.ts` explicit legacy: it fails the same way on the base `d0d6a445` (worktree run: `it-colloquial-001` refusal text is Spanish where Italian is expected). This failure was already there before this plan and is not caused by it.

## Deviations

1. **W-5 hand-off added** (see above). The plan did not cover it.
2. **Target enabled after the corpus load** rather than before (see key decisions). It is the same outbox-only write path, through the enable backfill.
3. **Contract change:** `RunManifest.backend_snapshot` (`RunBackendSnapshot`). The manifest is a strict contract, so the snapshot fields could not be added without it. 07-24's `_backend_impl` already reads the key one level down.
4. **Files outside files_modified:**
   - `eval/harness/run-config.mts`, which holds the allow-list;
   - `eval/harness/fake-edge.mts` (the bge-m3 bug that blocked stage A);
   - the contract files;
   - `src/lib/rag/{types,index}.ts`, `v2/overrides.ts`, `v2/stages/rank.ts` and the eval route (W-5);
   - the two overlay test files and `tests/eval-phase33-run-configs.test.ts`.
5. **Test layout:** each eval scenario in `eval-external-backend.test.mts` runs in a child process. A second `runEval` in one process returns 500, because the app modules keep the first fixture edge's clients. No other test file runs `runEval` twice.
6. **`eval/decisions/regression-plan-fixtures-a.decision.json`** is committed too. `decide` writes it and stage B's plan reads it.
7. **Test-split uses 26/25** (see above).

## Operator actions

- Live regression (plan 07-33) with `QDRANT_URL` / `WEAVIATE_URL` set, so the backend runs are real (`backend_impl: real`).
- The real-store test in `eval-external-backend.test.mts` runs only when `QDRANT_URL` is set (compose or CI backend tier).

## Deferred

- `dup_cluster` override: it now reaches `effectiveTuningParams`, but no query-time stage reads the threshold. If a later plan uses it at query time, add it to `tuningHashComponent`.
- table_split tenants (ingest mode only) are not seeded into external stores. Their items would fall back as `backend_not_ready` in an external ingest-mode run.
- The 07-24 regression CLI's `run` records a second ledger use when a config is interrupted and resumed. A resume marker that skips the second use would keep the count equal to the budget. This belongs to 07-24's module; I did not change it here.
- `tests/rag/characterize-chat.test.ts` (explicit legacy) already failed on the base: the it-colloquial-001 refusal is in Spanish.
- The report-only absolute gate (false_refusal_rate language:en 0.3133 > 0.25) was already failing before this plan and is unchanged.

## Decisions for STATE

- W-5 (04.2-06 eval tuning overrides in the request hash): closed by 07-25.
- The fixture record keeps pgvector. `RAG_INJECTION_CHECK=drop` is adopted in the provisional record only; code defaults are untouched, and only the live record (07-33) may change them (D-18).
