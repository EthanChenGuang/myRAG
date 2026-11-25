---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 11
subsystem: retrieval
tags: [eval-route, runRetrieval, evalScope, stage-status, parity, legacy-replica-removal]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: stage runner, status, trace collector and finishTrace (02-08); assembleContext and assembly stages (02-09); evalScope and scope brand (02-07, 02-10)
provides:
  - eval endpoint (POST /api/internal/rag/run) on the shared pipeline, minted scope through evalScope, profile eval
  - RagTrace.stage_status (dict[str, str]) and stage-named stage_latency_ms keys
  - parity proof of the pipeline against the unchanged Phase 1 golden set and baseline (all paired differences zero)
  - tests/rag/entrypoints-call-pipeline.test.ts (spy test for entry routes)
  - scopeKey exported from src/lib/rag/index.ts
affects: [02-12, 02-16, 02-18, 02-19]

requirements-completed: [PIPE-01, PIPE-05, PIPE-09]

actuals:
  tokens: 21000
  tasks: 2
  commits: 2
plan_head_before: cf070c32d6f244335579d0a83178b005751fe38c
plan_head_after: e5b17522d752a77869c7d9547e8d0da280c913bb

tech-stack:
  added: []
  patterns:
    - "The route creates the trace collector itself (tenantKey from scopeKey), passes it as `trace`, and calls finishTrace in a finally block, so generation is recorded as a stage and a failed response still logs the trace"
    - "Entry-route spy tests wrap runRetrieval through vi.doMock('@/lib/rag') with importOriginal and inject deps through setRagDepsForTests after vi.resetModules()"

key-files:
  created:
    - tests/rag/entrypoints-call-pipeline.test.ts
  modified:
    - src/app/api/internal/rag/run/route.ts
    - src/lib/rag/index.ts
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/schemas/RagTrace.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - tests/eval-route-auth.test.ts
    - tests/legacy-post-filter.test.ts
    - tests/legacy-post-filter-sentinel.test.ts
  deleted:
    - src/lib/rag-eval/legacy-post-filter.ts

key-decisions:
  - "Eval refusal is RetrievalResult.refusalCandidate (strict, no web search, zero Filter-2 documents, context starts with the no-context text); refusal_reason is no_relevant_context"
  - "Status error returns HTTP 500 { error: 'retrieval failed', reason }; so does a result whose assemble stage did not finish ok (degraded with no context), so a broken assembly cannot look like a correct refusal (T-02-27)"
  - "Candidate document_name and has_image still come from document and chunk rows: the route does one extra fetchAssemblyRows (two GETs) over the returned candidates, because RetrievalResult does not carry the rows. A lookup failure degrades to null names, it never fails the request"
  - "retrieval_strategy is read from the search stage record's detail (02-08 stores it there)"
  - "generation is recorded in the collector as a stage, so stage_latency_ms and stage_status include it when an answer is produced"

patterns-established:
  - "scopeKey is exported from the rag barrel so a route can name its collector's tenant without minting"

coverage:
  - id: D1
    description: "Eval route keeps its access check and allow-list, mints scope only through evalScope, retrieves through runRetrieval with profile eval"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/entrypoints-call-pipeline.test.ts (3 tests); tests/eval-route-auth.test.ts (15 tests)"
        status: pass
  - id: D2
    description: "RagTrace.stage_latency_ms keys are stage names and stage_status carries each stage's status; a retrieval error is HTTP 500, never a refusal"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/eval-route-auth.test.ts (error responses: embed failure, backend error, empty corpus refusal trace)"
        status: pass
  - id: D3
    description: "Parity: npm run test-rag through the pipeline on the unchanged golden set and baseline exits 0, gate passed, paired.all_zero true, mismatches empty"
    requirement: PIPE-09
    verification:
      - kind: integration
        ref: "npm run test-rag -- --out ./eval/out/parity-eval; jq -e '.passed == true and .paired.all_zero == true and (.mismatches | length == 0)' gate.json"
        status: pass
  - id: D4
    description: "The eval route's private post-filter replica is deleted; its cases now run against the shared assembleContext"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/legacy-post-filter.test.ts (21 tests) and tests/legacy-post-filter-sentinel.test.ts"
        status: pass
---

# Phase 2 Plan 11: Eval Route on the Pipeline Summary

**The eval endpoint now retrieves through `runRetrieval({ profile: 'eval' })` with an `evalScope`-minted scope and stage-named latencies plus stage statuses, and the unchanged Phase 1 golden set and baseline show zero paired differences, proving D-22 parity.**

## Performance

- **Tasks:** 2 of 2
- **Files:** 1 created, 10 modified, 1 deleted
- **Verification:**
  - `npx vitest run` passes (45 files, 485 tests)
  - `npm run gen:schemas` exits 0; `cd rag-sidecar && uv run pytest -q` passes (138 tests)
  - `node --import tsx --test tests/rag-legacy-differential.test.mts tests/rag-assemble-differential.test.mts tests/eval-answer.test.mts` passes (5, 3, 14 tests)
  - `npx next typegen && node scripts/ci/tsc-ratchet.mjs` reports ok (58 errors, 59 files improved); `tsc` reports 0 errors in the route file
  - Acceptance greps: `from '@/lib/rag'` in the route (1), `stage_status` in eval_run.py (1), replica file absent, no remaining reference to the replica path under src or tests

## Accomplishments

- Task 1 (dae67b3): rewrote the route body after the unchanged access check and validation: `evalScope` mints the scope (403 path unchanged), `runRetrieval` replaces the private retrieval, the N+1 per-chunk document and chunk lookups and the replica post-filter. The trace maps `kept`, `usedDocuments` (document_id, name, similarity, image_url), `context`, `refusalCandidate`, `queryContext` and the search stage's strategy onto the existing RagTrace fields. `RagTrace` gained `stage_status`; the contract sample uses stage-named keys; `gen:schemas` regenerated the JSON schema, Zod file and sample fixture.
- Task 2 (e5b1752): `tests/legacy-post-filter.test.ts` keeps all cases and expectations against `assembleContext` (input construction adapted only; `refused` is `refusalCandidate`, `document_id` is `id`). The replica file is deleted.

## Parity proof (D-22), unchanged golden set and baseline

Command: `npm run test-rag -- --out ./eval/out/parity-eval` (exit 0, output directory is gitignored).

```
overall: items=72 gated_dev=56 recall@5=0.574 (n=47) recall@10=0.574 (n=47) mrr=0.596 (n=47) correct_refusal=0.333 (n=9) false_refusal=0.319 (n=47)
gate: PASS (0 skipped)
gate.json: passed true, offenders [], skipped [], mismatches [], paired.all_zero true (seed 20261123, 10000 resamples)
```

Paired differences (95% percentile bootstrap interval, every cell [+0.0000, +0.0000]):

| Slice | Metric | n | n_nonzero | mean_d |
| --- | --- | --- | --- | --- |
| language:en | recall_at_5 | 18 | 0 | +0.0000 |
| language:en | recall_at_10 | 18 | 0 | +0.0000 |
| language:en | mrr | 18 | 0 | +0.0000 |
| language:en | correct_refusal_rate | 3 | 0 | +0.0000 |
| language:en | false_refusal_rate | 18 | 0 | +0.0000 |
| language:it | recall_at_5 | 13 | 0 | +0.0000 |
| language:it | recall_at_10 | 13 | 0 | +0.0000 |
| language:it | mrr | 13 | 0 | +0.0000 |
| language:it | correct_refusal_rate | 3 | 0 | +0.0000 |
| language:it | false_refusal_rate | 13 | 0 | +0.0000 |
| language:zh | recall_at_5 | 16 | 0 | +0.0000 |
| language:zh | recall_at_10 | 16 | 0 | +0.0000 |
| language:zh | mrr | 16 | 0 | +0.0000 |
| language:zh | correct_refusal_rate | 3 | 0 | +0.0000 |
| language:zh | false_refusal_rate | 16 | 0 | +0.0000 |
| overall | recall_at_5 | 47 | 0 | +0.0000 |
| overall | recall_at_10 | 47 | 0 | +0.0000 |
| overall | mrr | 47 | 0 | +0.0000 |
| overall | correct_refusal_rate | 9 | 0 | +0.0000 |
| overall | false_refusal_rate | 47 | 0 | +0.0000 |

The run was done twice (once with the replica still present, once after deleting it); both gave identical results. No non-zero difference appeared, so no pipeline fix and no baseline change was needed.

## Consumer grep for the old `retrieval` latency key

`stage_latency_ms` consumers in the repo: the contract files, the route, `tests/eval-answer.test.mts`, `tests/fixtures/contracts/samples.json` and four `eval/tests/*.py` fixtures that set `"stage_latency_ms": {}`. A grep of `eval/` (excluding `.venv` and `out`) for the `retrieval` key, `stage_latency` access or `.retrieval` use found only those empty-dict fixtures, so renaming the key breaks nothing.

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Eval route on runRetrieval with stage-named latencies and stage statuses | dae67b3 |
| 2 | Delete the post-filter replica, retarget its tests, parity proof | e5b1752 |

## Deviations from Plan

**1. [Rule 3 - Blocking] Sentinel test message text edited**
- **Issue:** the plan says `tests/legacy-post-filter-sentinel.test.ts` stays as is, but two of its failure-message strings name `src/lib/rag-eval/legacy-post-filter.ts`, which makes the acceptance grep (`rag-eval/legacy-post-filter` under src and tests prints 0) fail once the file is deleted.
- **Fix:** only those two message strings now point to `src/lib/rag/context/assemble.ts`. The pinned regions, hashes and literals are untouched, so the sentinel still pins the unchanged chat route; plan 02-12 still retargets the pinned regions.
- **Commit:** e5b1752

**2. [Rule 3 - Blocking] `scopeKey` exported from the rag barrel**
- **Issue:** the route must create the trace collector (it owns `finishTrace` when it passes `trace`) and `createTraceCollector` needs a tenant key; `scopeKey` was not exported from `@/lib/rag`, and the route may import only the barrel.
- **Fix:** `export { isTenantScope, scopeKey } from './tenant/scope'` (one existing line edited in place, not appended, to keep the file easy to merge with the parallel 02-16 and 02-18 edits of index.ts).
- **Commit:** dae67b3

**3. [Rule 2 - Correctness] Incomplete assembly is a 500, not a trace**
- A result with status `degraded` whose `assemble` stage was skipped has an empty context and would score as a non-refusal. The route returns 500 with the stage reason for that case as well as for status `error` (T-02-27).

**4. [Scope] Candidate rows looked up once more in the route**
- See key-decisions. Cost: two GETs per eval request. Alternative (adding rows to `RetrievalResult`) would touch `pipeline.ts` and `types.ts`, which parallel plans 02-16 and 02-18 are editing.

## Intended behaviour changes

- Eval traces now carry `stage_status` and stage-named latency keys (`analyze`, `embed`, `search`, `legacy_rank`, `post_filter`, `assemble`, `generation`); the old `retrieval` and combined `post_filter` timing keys are gone. Stage timeouts and request abort now apply to the eval endpoint (15 s per stage by default for the eval profile).
- A pipeline failure in eval is HTTP 500 `{ error: 'retrieval failed', reason }` instead of `retrieval failed: <ErrorName>`; the raw message is still never returned.

## Known Stubs

None.

## Threat Flags

None. T-02-26 (access check and allow-list unchanged, scope only through `evalScope`, 403 path covered by `tests/eval-route-auth.test.ts` and the new spy test) and T-02-27 (status error and incomplete assembly return 500) are mitigated and tested.

## Notes for later plans

- `tests/rag/entrypoints-call-pipeline.test.ts` has one describe block per route; later plans append their own block. 02-16 and 02-18 also create or edit this file, so expect a trivial add/add merge conflict to resolve by keeping both describe blocks.
- The trace ownership rule held: the route passes `trace`, so `runRetrieval` does not call `finishTrace`; the route does, in a `finally`.
- Unit tests that need to inject deps into a route imported after `vi.resetModules()` must call `setRagDepsForTests` on the freshly imported `@/lib/rag/deps` module.

## Self-Check: PASSED

- `src/app/api/internal/rag/run/route.ts` and `tests/rag/entrypoints-call-pipeline.test.ts` exist; `src/lib/rag-eval/legacy-post-filter.ts` is absent.
- Commits dae67b3 and e5b1752 are ancestors of HEAD.
