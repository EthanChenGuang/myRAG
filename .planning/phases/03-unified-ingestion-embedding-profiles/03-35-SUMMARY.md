---
phase: 03-unified-ingestion-embedding-profiles
plan: 35
subsystem: retrieval
tags: [exact-id, invoice, tax-id, partita-iva, uscc, eu-vat, pipeline-stage, tenant-scope, tdd]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: tests/fixtures/ingest/tax-id-vectors.json from python-stdnum (03-14); embed and search through the active profile (03-26); rag_exact_id_documents, promoted invoice columns and the invoice_header chunk (03-29)
provides:
  - TypeScript tax-id validators (classifyTaxId, isValidPartitaIva, isValidUscc, isValidEuVat) that agree with python-stdnum on every shared vector
  - extractExactIds, exactIdLookup, exactIdStage and mergeExactCandidates in src/lib/rag/retrieval/exact-id.ts
  - Optional exact_id_lookup stage behind RAG_EXACT_ID_LOOKUP (default false) in the chat, embed and eval pipelines, absent from the stage list when off
affects: [03-37, 03-41, 03-44, 04-13, 04-20]

actuals:
  tokens: 14500
  tasks: 2
  commits: 4
plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: da61d7d874adf8fe76f3c8bc8246fcf7423aa840

tech-stack:
  added: []
  patterns:
    - "Optional stage gated by a config flag: the stage is only built when the switch is on, so the off path keeps the same stage list, objects and call order"
    - "Exact chunks are merged in front of the vector candidates with the best vector final_score and similarity 1, relying on the stable legacy sort and the relevance filters to keep them first"
    - "Query tokens travel to SQL only as one text[] parameter next to the tenant key"

key-files:
  created:
    - src/lib/rag/ids/tax-ids.ts
    - src/lib/rag/retrieval/exact-id.ts
    - tests/rag/tax-id-vectors.test.ts
    - tests/rag/exact-id.test.ts
    - tests/rag-db/exact-id-lookup.test.mts
  modified:
    - src/lib/rag/config.ts
    - src/lib/rag/deps.ts
    - src/lib/rag/pipeline.ts
    - tests/rag/config.test.ts

key-decisions:
  - "A token counts when it is a checksum-valid tax id, or an identifier-shaped token (the lexical tokenizer's shape) of at least four characters with a letter and a digit; a digits-only number (five or more digits, or two groups such as 03/2025) counts only when the question mentions an invoice (zh, en, it cue words). Years, dates and amounts give nothing. Kind is invoice when the cue is present, otherwise model"
  - "EU VAT checksums are implemented for IT, DE, FR, AT, BE and NL because the shared vectors include them; any other prefix is reported not valid, which only changes the token's label (it is still looked up as an identifier). This is the one place TypeScript is narrower than python-stdnum"
  - "Italian VAT numbers are looked up with and without the IT prefix, whichever way the question wrote them, because the stored supplier_tax_id is the text of the document"
  - "Exact chunks get similarity 1 and the best vector final_score (at least 1), so the stable legacy_rank sort and the 0.65 post filter keep them first; a chunk both routes found is listed once, as exact_id, with the vector route's metadata and scores of temporal and financial"
  - "The merged list is cut at maxResults unless the exact chunks alone exceed it, so the caller's result cap still holds"
  - "A question with no identifier records the stage ok with zero candidates and makes no RPC; a failing or slow lookup is skipped (status degraded, reason exact_id_lookup_failed or exact_id_lookup_timeout) with the vector results intact"
  - "The media and voice pipelines do not run the stage (no legacy_rank, different context shape); their stage timeouts exist so RAG_STAGE_TIMEOUTS and the profile table stay complete"

requirements-completed: [DATA-09]

coverage:
  - id: D1
    description: "TypeScript tax-id checks (Partita IVA, USCC, EU VAT with the IT, DE, FR, AT, BE and NL checksums) agree with every entry of tax-id-vectors.json, scheme and validity"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "tests/rag/tax-id-vectors.test.ts (49 tests, one per vector plus direct-validator, normalisation, province and alphabet cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "extractExactIds returns invoice numbers, valid tax ids (also written with spaces or dots) and model numbers; plain questions, years, dates and amounts give no token; digits-only numbers need an invoice cue; the token count is capped and hostile input stays linear"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "tests/rag/exact-id.test.ts#extractExactIds (D-28)"
        status: pass
    human_judgment: false
  - id: D3
    description: "With RAG_EXACT_ID_LOOKUP=true the stage runs after search and before legacy_rank, calls rag_exact_id_documents with scopeKey(scope) and the tokens as a text[], puts the exact chunks first with match_reason exact_id without duplicates, and is skipped (degraded) on failure or timeout; disabled via RAG_DISABLED_STAGES it is recorded as disabled"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "tests/rag/exact-id.test.ts#mergeExactCandidates, #exactIdLookup, #the exact_id_lookup stage in runRetrieval; tests/rag/config.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "With the switch off (default, empty or invalid) the stage is neither run nor recorded and retrieval equals today's: legacy differential over the 72 frozen questions, smoke tier gate PASS with paired.all_zero true"
    requirement: DATA-09
    verification:
      - kind: integration
        ref: "tests/rag-legacy-differential.test.mts; npm run test-rag -- --out eval/out/p3-exact-off (gate.json passed true, paired.all_zero true); tests/rag/exact-id.test.ts#with the switch off"
        status: pass
    human_judgment: false
  - id: D5
    description: "On the two-tenant fixture an invoice-number question returns tenant A's invoice_header chunk first for A and nothing of A for B (by A's number, by a shared number, by A's supplier tax id); quarantined and superseded invoices are never returned"
    requirement: DATA-09
    verification:
      - kind: integration
        ref: "tests/rag-db/exact-id-lookup.test.mts (6 tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The eval endpoint cannot disable or time the stage per request (its StageName contract is the Pydantic literal and was not extended); the env switch and RAG_DISABLED_STAGES work"
    verification: []
    human_judgment: true
    rationale: "Extending the Pydantic StageName literal regenerates four JSON schemas and the generated Zod file; left to whichever plan next touches the eval contract"

duration: about 20 min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 35: Exact-id lookup stage Summary

**An invoice number, a valid tax id or a model number in a question now retrieves the exact current chunk of the caller's tenant ahead of the vector results, through an optional exact_id_lookup stage on rag_exact_id_documents, with hand-written TypeScript tax-id validators held to the sidecar's python-stdnum vectors and no change at all while RAG_EXACT_ID_LOOKUP is off.**

## Performance

- **Duration:** about 20 min
- **Started:** 2026-11-24T08:24:00Z (approximate; the ledger was seeded at 08:26)
- **Completed:** 2026-11-24T08:43:00Z
- **Tasks:** 2
- **Files:** 5 created, 4 modified (src and tests)

## Accomplishments

- `src/lib/rag/ids/tax-ids.ts`: Partita IVA (all-zero rule, province rule 001-100/120/121/888/999, Luhn), USCC (alphabet, weighted check character) and EU VAT with the IT, DE, FR, AT, BE and NL checks; shape-based scheme choice and normalisation identical to the sidecar. Every one of the 43 vectors, including the spaced IT number and the hyphenated USCC, gives the file's scheme and validity.
- `extractExactIds` reads tokens on `IDENTIFIER_PATTERN` (the lexical tokenizer's shape), so a token matches the `lexical_text` written at ingestion; spaced or dotted tax ids are found by a bounded second scan and a span that was already taken as a tax id is not repeated as a plain token.
- `exactIdLookup` calls `rag_exact_id_documents(p_tenant_key, p_tokens, p_limit)` with `scopeKey(scope).toLowerCase()` and the tokens as a single array (at most 20 values, limit 10); no tokens, no call; a scope that was not minted is refused before any call.
- `mergeExactCandidates` and the stage in `runPipeline`: after `search`, before `legacy_rank`, for chat, embed and eval; with the switch on a question like "What is the total of invoice FT-2025-00417?" returns the invoice_header chunk first with `match_reason: 'exact_id'`, similarity 1, followed by the vector candidates without duplicates.
- `config.ts` / `deps.ts`: `exact_id_lookup` in `OPTIONAL_STAGES`, timeouts 1000 ms (500 ms voice), `RAG_EXACT_ID_LOOKUP` in `RagEnvInput`, the snapshot of `ragEnv` and `RagConfig.exactIdLookup` (true only for `true`, case and spaces ignored; any other value warns once and means off).

## Task Commits

1. **Task 1: Tax-id validators and query identifier extraction** - RED `c0285f3` (test), GREEN `656cd09` (feat)
2. **Task 2: The optional exact_id_lookup stage** - RED `48fb891` (test), GREEN `da61d7d` (feat)

**Plan metadata:** the commit that adds this file (docs). `commits: 4` is measured from the ledger base `14f30e5` and excludes this commit.

## TDD Gate Compliance

`type: execute` with task-level `tdd="true"`; `workflow.tdd_mode` is off and earlier plans found `tdd-red-evidence` rejects vitest's TAP output, so the classifier was not run. RED was assessed from the runner output; every failure is an assertion on the planned behaviour, never a missing module (inert stubs were committed with each RED).

- Task 1 RED: 49 of 58 tests failed (for example `expected 'unknown' to be 'eu_vat'`, `expected false to be true` for `it_iva 99999999990`, `expected 'it 999 999 999 90' to be 'IT99999999990'`); 9 passed (invalid vectors and plain-question cases, which the stub satisfies).
- Task 2 RED: 14 of 26 unit tests failed on assertions (`expected [ 'v1', 'v2' ] to deeply equal [ 'e1', 'v1', 'v2' ]`, `expected 'ok' to be 'degraded'`, `expected undefined to match object { status: 'disabled' }`); 4 of 27 config tests failed (stage list, profile defaults, the switch, the timeout); 3 of 6 DB tests failed (`expected: 1 actual: 0` exact calls, `expected 'exact_id' actual 'similarity: 0.606'`), 3 passed as guards that must stay true (shared number, quarantined and superseded rows, switch off).
- Tests that failed before the change and pass now: the 49 Task 1 tests listed above, the 14 unit and 4 config tests, and DB tests 1, 2 and 4.

## Files Created/Modified

- `src/lib/rag/ids/tax-ids.ts` - validators and `classifyTaxId`
- `src/lib/rag/retrieval/exact-id.ts` - extraction, lookup, stage function and merge
- `src/lib/rag/config.ts`, `src/lib/rag/deps.ts`, `src/lib/rag/pipeline.ts` - stage name, timeouts, switch, env snapshot and the stage in `runPipeline`
- `tests/rag/tax-id-vectors.test.ts`, `tests/rag/exact-id.test.ts`, `tests/rag-db/exact-id-lookup.test.mts`, `tests/rag/config.test.ts`

## Decisions Made

See key-decisions. `src/lib/rag/index.ts` was not touched: nothing outside `@/lib/rag` needs these functions yet, and the parallel plans edit that file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Commit branch guard does not fit the assigned branch**
- **Found during:** first commit
- **Issue:** the executor commit guard allows only `agent-*` / `worktree-agent-*` / `worktree-wf_*` branches in a linked worktree; the brief assigns `exec/03-35`, which is not a protected branch.
- **Fix:** committed on `exec/03-35` as briefed (the protected-branch check and the cwd check were run); no branch was created or switched.

**2. [Interpretation] EU VAT checks beyond Italy**
- **Found during:** Task 1
- **Issue:** the plan says "EU VAT shape with the IT checksum", but the shared vectors hold valid and invalid DE, FR, AT, NL and BE numbers, and the must-have truth is agreement with python-stdnum on every entry.
- **Fix:** hand-written checks for IT, DE, FR, AT, BE and NL (ported from the stdnum rules); every other prefix is reported not valid. A real Spanish or Polish VAT number is therefore not labelled a tax id, but it is still looked up as an identifier token, so retrieval is unaffected.

**3. [Interpretation] Media and voice pipelines do not run the stage**
- **Found during:** Task 2
- **Issue:** the plan sets stage timeouts for voice and media and places the stage "after search, before legacy_rank"; only the chat, embed and eval pipeline has a `legacy_rank`. Voice reranks with its own hybrid scorer and media formats raw chunks.
- **Fix:** the stage runs in `runPipeline` only; the timeouts for all five profiles exist in the table (the tests pin them). A test asserts media and voice make no exact lookup.

**4. [Rule 1 - Bug] Tests that pinned the stage and default tables**
- **Found during:** Task 2
- **Issue:** `tests/rag/config.test.ts` asserted the exact optional stage list and per-profile defaults, which this plan extends.
- **Fix:** updated to the new list and defaults and added the switch and override cases. The file is not in the plan's list.
- **Committed in:** `48fb891`

**5. [Ordering] `RagEnvInput.RAG_EXACT_ID_LOOKUP` landed in the RED commit**
- **Issue:** the new tests set the field, so the type was added with the inert stubs to keep the tree compiling; it has no behaviour until the GREEN commit.

---

**Total deviations:** 5 (1 process, 2 interpretations, 1 test update, 1 ordering)
**Impact on plan:** no scope change; deviation 2 and 3 narrow how far the plan's wording reaches.

## Issues Encountered

- `tests/rag/injection-scan.test.ts` ("scans hostile 1 MB inputs in under one second") failed once under full-suite load (1135 ms against 1000 ms) and passes alone (45 of 45); the same flake was recorded by 03-26. Unrelated to this plan.
- The first DB test draft flipped `documents.is_current` by hand and expected the chunks to follow. They do not: the chunk flags are written by the writer functions, not mirrored by a trigger, and every reader (including `rag_exact_id_documents`) filters on the chunk columns. The test now uses the real supersede (a second ingest of the same source key) and the real quarantine path.

## Gate Results (worktree /home/user/wt/03-35, branch exec/03-35)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 149 files, 2149 passed, 1 failed: `tests/rag/injection-scan.test.ts` timing assertion under load, 45 of 45 pass alone; `langfuse-pins` passed |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed (includes the legacy differential); the differential plus the new DB file alone: 11 passed |
| `node --import tsx --test tests/rag-db/exact-id-lookup.test.mts` | 6 passed, 0 failed (criterion at least 4) |
| `npx vitest run tests/rag/tax-id-vectors.test.ts` | 49 passed (criterion at least 3) |
| `npx vitest run tests/rag/exact-id.test.ts tests/rag/config.test.ts tests/rag/stage-runner.test.ts` | 83 passed |
| Related DB tests (invoices, invoice-ingest, profile-search, quarantine-retrieval, exact-id-lookup) | 49 passed |
| `npm run test-rag -- --out eval/out/p3-exact-off` | gate PASS (7 skipped), `jq -e '.passed == true and .paired.all_zero == true'` true |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 757 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables (no new variable) |
| rag-sidecar pytest, eval pytest | not run (untouched) |

Acceptance greps: `grep -c "exact_id_lookup" src/lib/rag/config.ts` = 4 (EXPECT >= 1, HEAD 0).

## Threat Surface

T-03-99 (cross-tenant disclosure): the tenant key is `scopeKey(scope).toLowerCase()` and nothing else, the function filters tenant, current and ready in SQL, and the two-tenant PGlite test asserts tenant B gets none of A's document or chunk ids or text through A's number, a shared number and A's supplier tax id. T-03-100 (token injection): tokens are bound as a `text[]` parameter next to the tenant key, no SQL is built in TypeScript, and a test sends a quote-and-semicolon payload and checks the argument names and values. T-03-SC: no package changes. No new endpoint, auth path or environment variable (`RAG_EXACT_ID_LOOKUP` was wired in the five config places by 03-03). The stage trace detail carries a token count only, never the query or a token.

## Known Stubs

None.

## User Setup Required

None for configuration. To use the stage an operator sets `RAG_EXACT_ID_LOOKUP=true`; it needs migration 0314 applied (already required by 03-29), `SUPABASE_SERVICE_ROLE_KEY` (retrieval searches on the admin client) and invoices ingested through the unified pipeline, otherwise the lookup finds nothing.

## Next Phase Readiness

- 03-44 and later plans can rely on `match_reason: 'exact_id'` candidates and the `exact_id_lookup` stage record in traces; Phase 4 hybrid retrieval should treat exact chunks as already first (similarity 1) when it fuses lists.
- Not done here: the Pydantic `StageName` literal and generated schemas do not list `exact_id_lookup`, so an eval run cannot disable or time it per request (D6).

## Self-Check: PASSED

Created files exist (tax-ids.ts, exact-id.ts, the three test files and the DB test); commits `c0285f3`, `656cd09`, `48fb891` and `da61d7d` are ancestors of HEAD; the measured count from the ledger is 4.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
