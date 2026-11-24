---
phase: 03-unified-ingestion-embedding-profiles
plan: 20
subsystem: security
tags: [prompt-injection, quarantine, ingest, retrieval, d-08, tenant-scope, rls]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest stage runner with scan_injection registered, fail-closed placeholder and writer.setFields (03-13, 03-13b); D-08 filter in the search RPCs (03-01/0306, 0308); generated InjectionRuleSet schema (03-02)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "runRetrieval, voice keyword fallback, document reference resolver, overview lookup, fake edge"
provides:
  - "config/rag/injection-rules.json: 16 synthetic zh, en, it and any rules as data (D-30)"
  - "src/lib/rag/security/injection-scan.ts: scanText(text), loadInjectionRules(), parseInjectionRuleSet(), memoised and compiled once; reusable by Phase 5.1 (SEC-03)"
  - "scan_injection stage: a match quarantines the document before its chunks are written, chunks are kept, ingest returns quarantined"
  - "D-08 filter (is_current and status = 'ready') on the three retrieval-side table readers that do not call match_* functions"
  - "Fake edge: typed eq filters and readable columns for is_current, status, tenant_key, version, doc_type (and lineage_id on documents)"
affects: [03-29, 03-30, 03-37, 03-38, 03-43, phase-5.1]

tech-stack:
  added: []
  patterns:
    - "Injection rules are data; broad phrases are regexes with a negative lookahead for known benign continuations, pinned by a false-positive list in the test"
    - "Quarantine is written with setFields before the chunk stage, so the SQL chunk writer stamps every chunk with the document status and no later step has to flip chunks"
    - "Every retrieval-side table read applies the D-08 filter in one helper next to the tenant predicate"

key-files:
  created:
    - config/rag/injection-rules.json
    - src/lib/rag/security/injection-scan.ts
    - tests/rag/injection-scan.test.ts
    - tests/rag-db/quarantine-retrieval.test.mts
    - tests/rag/retrieval-readers-current.test.ts
  modified:
    - src/lib/rag/ingest/stages/scan-injection.ts
    - src/lib/rag/voice/keyword-fallback.ts
    - src/lib/rag/refs/resolve.ts
    - src/lib/rag/context/overview.ts
    - eval/harness/fake-edge.mts
    - tests/fixture-edge.test.mts
    - tests/helpers/ingest-fakes.ts
    - tests/rag/ingest/runner.test.ts
    - tests/rag/ingest/ingest-trace.test.ts
    - tests/rag/refs.test.ts
    - tests/rag/local-hybrid.test.ts

key-decisions:
  - "A quarantine match calls writer.setFields({status:'quarantined', metadata:{quarantine:{rule_ids, snippets, quarantined_at}}}) in the scan stage, before chunk exists. rag_write_chunks copies the document status to each chunk and rag_publish_document_version returns 'quarantined' without promoting, so a quarantined version is never current and its chunks are never ready. The quarantine metadata lives on the document row only; chunk rows carry the status"
  - "Rules that would be too broad as bare phrases (you are now, 你现在是, ora sei, disregard the above, system prompt) are regexes with a context or a negative lookahead; the benign continuations are pinned in tests/rag/injection-scan.test.ts. Operators tune the JSON file, never code"
  - "scanText throws when the rule file is invalid; the stage turns that into the existing fail-closed result injection_scan_unavailable. Text is never published unscanned under quarantine"
  - "The loader rejects back-references, any quantified group that holds a *, + or {} quantifier at any depth, an unbounded repeat of a group with alternatives, patterns over 200 characters, patterns that do not compile and patterns that match empty text; each error names the rule id"
  - "Zero-width and bidi controls are removed; because a zero-width space can stand in for a space, the text is also scanned with those characters turned into spaces when any are present. Chinese rules (language zh, or a CJK pattern) are also matched on the text with all spaces removed"
  - "The D-08 filter on table readers sits in the same helper as the tenant predicate (refs) or in the single chunk/document select helper (keyword fallback), so a new query in those files cannot skip it. fetch-rows stays unfiltered: its ids come from RPC results that are already filtered"

patterns-established:
  - "Test that a security filter holds on every retrieval profile by dumping the document-bearing fields of the result (not the echoed query terms) and checking a distinctive token, document id and chunk ids are absent, with a visible control that proves the check can fail"

requirements-completed: [SEC-01]

actuals:
  tokens: 21400
  tasks: 3
  commits: 7

plan_head_before: 63a758b1dad8537a16d286c4c17692ff5a2d3931
plan_head_after: 2bbb8dd8360d86d956844621ab215100f5927f1f

coverage:
  - id: D1
    description: "config/rag/injection-rules.json holds 16 rules in zh, en, it and any, valid against the generated InjectionRuleSet schema; the ten D-30 phrases each match in a sentence"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/rag/injection-scan.test.ts#injection rules file and #scanText detects the D-30 phrases"
        status: pass
    human_judgment: false
  - id: D2
    description: "scanText sees through case, full-width letters, zero-width and bidi characters and Chinese OCR spacing, stays clean on a pinned list of benign texts, returns at most three snippets of at most 80 characters, never logs, and scans 1 MB inputs in well under one second"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/rag/injection-scan.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "The loader rejects nested and ambiguous repetition, back-references, over-long, uncompilable and empty-matching patterns, each naming its rule"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/rag/injection-scan.test.ts#rule loading limits"
        status: pass
    human_judgment: false
  - id: D4
    description: "With RAG_INJECTION_SCAN=quarantine a zh, an en and an it injection document end quarantined with chunks kept, status quarantined on the document and every chunk, rule ids and snippets in metadata.quarantine, and no snippet in any log line; off, a profile with scan_injection false, clean text and unloadable rules behave as specified"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag-db/quarantine-retrieval.test.mts"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/runner.test.ts#registered stages and their switched-off behaviour"
        status: pass
    human_judgment: false
  - id: D5
    description: "chat, embed, voice, media and eval retrieval return none of a quarantined document's text, document id or chunk ids, while a clean document and an unscanned document with the same phrasing are returned; another tenant sees neither"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag-db/quarantine-retrieval.test.mts#profile chat/embed/voice/media/eval"
        status: pass
    human_judgment: false
  - id: D6
    description: "The voice keyword fallback, document reference resolution (by id and by name) and the overview documents lookup read only current, ready rows; by-id assembly reads are unchanged; the fake edge supports the new columns and filters"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/rag/retrieval-readers-current.test.ts"
        status: pass
      - kind: integration
        ref: "tests/rag-db/quarantine-retrieval.test.mts#the voice keyword fallback / #a chat request that references a quarantined document"
        status: pass
      - kind: integration
        ref: "tests/fixture-edge.test.mts"
        status: pass
    human_judgment: false
  - id: D7
    description: "Choice of rule wording and the false-positive trade-off of each starter rule is acceptable for the operator's documents"
    verification: []
    human_judgment: true
    rationale: "Which phrases are benign in the operator's own corpus is a judgement the pinned test list cannot settle; review config/rag/injection-rules.json before enabling quarantine"

duration: "about 45 min (start time not recorded; estimated from the session clock)"
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 20: Prompt-Injection Scan and Quarantine Summary

**Documents with zh, en or it prompt-injection phrasing are quarantined at ingestion by a rule-file matcher (NFKC, zero-width and OCR-spacing aware, ReDoS-bounded), and every retrieval-side table reader now applies the D-08 current-and-ready filter, so a quarantined chunk is absent from chat, embed, voice, media and eval retrieval and from document references**

## Performance

- **Duration:** about 45 min (not measured; the start time was not recorded)
- **Completed:** 2026-11-24
- **Tasks:** 3 (all TDD; seven commits)
- **Files:** 5 created, 11 modified, 1358 insertions, 40 deletions

## Accomplishments

- `scanText(text)` and the 16-rule file: phrases and context regexes for zh, en, it and chat-template tokens; matches through upper case, full-width letters, U+200B and bidi controls (also when a zero-width space replaces a space), and Chinese OCR spacing; at most three 80-character snippets; no logging. A 1 MB scan takes about 0.15 to 0.4 s here, including hostile inputs.
- The loader names the rule on every rejection and refuses nested or ambiguous repetition, back-references, long or empty-matching patterns. A rule file that cannot load makes `scanText` throw and the stage fail the run closed.
- The `scan_injection` stage: switch off or profile flag off skips (span `disabled`); a match sets the document quarantined before chunking, so chunks are written with status quarantined, the version is never promoted, and `ingest()` returns `quarantined`. Rule ids go to the `[Ingest]` log; snippets only to metadata.
- D-08 on table readers. The voice keyword fallback (document ids and every chunk query), the document reference resolver (three documents queries, two chunk queries) and the overview documents lookup filter `is_current` and `status = 'ready'`. A quarantined document referenced by id or name returns no chunk, no text and no used-document entry; a keyword hit on a quarantined chunk is gone.
- The fake edge reads and eq-filters `is_current`, `status`, `tenant_key`, `version`, `doc_type` (and `lineage_id` on documents) with typed values, so the filters run against PGlite instead of being unsupported.

## Task Commits

1. **Task 1: rules as data and the normalising matcher (TDD)**
   - RED: `aa1f2c1` (test)
   - GREEN: `d7a0597` (feat)
2. **Task 2: scan_injection stage and exclusion from every profile (TDD)**
   - RED: `6eb8f5a` (test)
   - GREEN: `9692920` (feat)
3. **Task 3: retrieval-side table readers honour the D-08 filter (TDD)**
   - RED: `6c1f57f` (test)
   - GREEN: `5250e2d` (feat)
4. **Type fix in the new DB test:** `2bbb8dd` (test)

**Plan metadata:** committed after this file (docs: complete plan)

## Files Created/Modified

- `config/rag/injection-rules.json` - 16 synthetic rules (zh 5, en 6, it 4, any 1)
- `src/lib/rag/security/injection-scan.ts` - loader, ReDoS checks, normaliser, `scanText`; no ingestion types
- `src/lib/rag/ingest/stages/scan-injection.ts` - the real stage
- `src/lib/rag/voice/keyword-fallback.ts`, `refs/resolve.ts`, `context/overview.ts` - the D-08 filter on table reads
- `eval/harness/fake-edge.mts` - new readable columns and typed eq filters
- `tests/rag/injection-scan.test.ts` (45 tests), `tests/rag-db/quarantine-retrieval.test.mts` (10), `tests/rag/retrieval-readers-current.test.ts` (10) - new
- `tests/fixture-edge.test.mts`, `tests/helpers/ingest-fakes.ts`, `tests/rag/ingest/runner.test.ts`, `tests/rag/ingest/ingest-trace.test.ts`, `tests/rag/refs.test.ts`, `tests/rag/local-hybrid.test.ts` - extended or updated

## Decisions Made

See `key-decisions` above. Two that later plans depend on: the document's `metadata.quarantine` shape is `{rule_ids: string[], snippets: string[] (at most 3), quarantined_at: ISO string}` and `processing_state.quarantine` is `{ruleIds, released: false}`; plan 03-37 adds `released_by` and `released_at` to the former. Chunk rows carry only the status.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Tests that pinned the placeholder or the replaced reader shape were rewritten**
- **Found during:** Tasks 2 and 3
- **Issue:** `runner.test.ts` and `ingest-trace.test.ts` asserted that quarantine mode fails closed on any text; `refs.test.ts` and `local-hybrid.test.ts` pinned the exact query-builder sequence and `eq` calls of the readers and seeded rows without `is_current` or `status`, so the filter removed every row.
- **Fix:** The fail-closed assertions now run through unloadable rules (`setInjectionRulesForTests`); clean text and injection text have their own cases. Reader tests list the new `eq` calls and their fixtures carry `is_current: true, status: 'ready'`. No case was dropped.
- **Files modified:** tests/rag/ingest/runner.test.ts, tests/rag/ingest/ingest-trace.test.ts, tests/rag/refs.test.ts, tests/rag/local-hybrid.test.ts
- **Committed in:** 6eb8f5a, 5250e2d

**2. [Rule 2 - Missing Critical] Test-only additions outside the plan's file list**
- `tests/fixture-edge.test.mts` (two tests for the new edge columns and typed rejections) and `tests/helpers/ingest-fakes.ts` (the fake DB answers `quarantined` from publish once a document was set quarantined, as the SQL does). Both additive.
- **Committed in:** 6eb8f5a, 6c1f57f

**3. [Rule 2 - Missing Critical] Extra exports on the matcher module**
- `parseInjectionRuleSet` (validation without loading the file, used by the tests and available to a future admin check) and `setInjectionRulesForTests` / `resetInjectionRulesForTests` (same pattern as `setIngestDepsForTests`). The plan names `scanText` and `loadInjectionRules` only; both still exist with the specified behaviour.

**4. [Rule 1 - Bug in my own commit] The RED commit of Task 1 contains literal invisible characters**
- **Found during:** lint after the first GREEN run
- **Issue:** The file-writing tool turned the `U+200B` and `U+202E` escapes I typed in `tests/rag/injection-scan.test.ts` into literal characters, against the plan's instruction. `aa1f2c1` therefore holds literal U+200B and U+202E in that test file; the first GREEN draft had them in the matcher's character classes too.
- **Fix:** `d7a0597` rewrites every one as an escape sequence (the matcher source and the test). History is not rewritten, so the RED commit keeps the literals.
- **Committed in:** d7a0597

---

**Total deviations:** 4 (1 blocking, 2 missing-critical, 1 own-commit defect)
**Impact on plan:** None on scope. Every production edit is in a file the plan lists; the extra files are tests and the shared test fake.

## TDD Gate Compliance

All three tasks have a `test(03-20)` commit followed by a `feat(03-20)` commit; no refactor commits. `gsd_run check tdd-red-evidence` was not run: the previous plan found it returns `INVALID_RED (invalid_record)` for vitest TAP output and `workflow.tdd_mode` is off. The RED assessment is manual, from the runner output of each RED commit, and every failure was an assertion:

- **Task 1 RED (`aa1f2c1`):** 29 of 45 failed with `expected false to be true`, `expected [Function] to throw`, `expected 0 to be greater than or equal to 10`, and a source-shape assertion. 16 passed as guards (benign texts that a stub also leaves clean, empty input). The commit carries inert stubs so the tests load.
- **Task 2 RED (`6eb8f5a`):** the 8 DB tests failed (`expected 'quarantined'`, actual `'failed'`; then the controls, `expected 'ready'`, actual `'failed'`); in the vitest files 4 of 34 failed on assertions (clean text under quarantine ended `failed`, injection text ended `failed`, no rule id in the `[Ingest]` log, the profile flag returned `fail`); the off-switch and unloadable-rules tests passed already as regression guards.
- **Task 3 RED (`6c1f57f`):** 9 of 10 vitest tests failed (`expected [] to deeply equal ArrayContaining`, `held chunk of a ready document` found in context, ...); `tests/fixture-edge.test.mts` 1 failed (new filter columns unsupported); in the DB file 2 of 10 failed on `the keyword fallback does not return a chunk of the quarantined zh document` and `no text or filename of the zh document`.

## Issues Encountered

- The query terms are echoed in `RetrievalResult.queryTerms` and `queryContext`, so my first DB assertion (the whole serialised result must lack the token) tripped on the query itself. The helper now serialises only the document-bearing fields, and the controls prove it can fail.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 126 files, 1662 tests passed |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 170 tests: 167 passed, 0 failed, 3 skipped (single-tenant variants skipped by design in earlier plans) |
| `node --import tsx --test tests/rag-db/quarantine-retrieval.test.mts` | 10 passed (criterion: at least 5) |
| `npx vitest run tests/rag/injection-scan.test.ts` | 45 passed (criterion: at least 8) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 690 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, sidecar untouched |
| eval pytest | not run, no Python touched (the orchestrator runs it); `eval/harness/fake-edge.mts` is TypeScript and is covered by `tests/fixture-edge.test.mts` and the DB tests |
| `tests/rag/langfuse-pins.test.ts` | passed here, no ENOENT |

Acceptance: rules count 16 (EXPECT >= 10); `InjectionRuleSetSchema` in injection-scan.ts 2 (EXPECT >= 1); `scanText` in the stage 2 lines (EXPECT >= 1); `is_current` in keyword-fallback.ts 2 (EXPECT >= 1); `'is_current'` in fake-edge.mts 2 lines (EXPECT >= 2).

## Threat Surface

T-03-55 (injection in documents): mitigated by the scan and the no-switch D-08 filter, now also on table readers. T-03-56 (rule regex DoS): length cap, repetition checks, bounded windows, 1 MB tests including hostile inputs. T-03-57 (snippets): at most three of at most 80 characters, stored in metadata, never logged; a test captures every console method and finds none. T-03-58 (legacy writers bypass the scan): unchanged, accepted. No new network endpoint, auth path or schema change.

## Known Stubs

None.

## Remaining quarantine-bypass readers (follow-ups)

The sweep covered `.from('documents')`, `.from('document_chunks')`, the search RPCs and the SQL files. Closed here: the three retrieval-side readers above. Not closed, and why:

| Reader | What it exposes | Owner or suggested fix |
|---|---|---|
| `GET /api/documents` (`src/app/api/documents/route.ts`, both modes) | Lists every document row, quarantined ones included (filename, metadata, source). Its status is derived from chunk count, so a quarantined document with chunks shows `ready`. Chunk counts read `document_chunks` unfiltered | Plan 03-30 owns this file. Note its design: it deliberately lists a quarantined document with status `quarantined` (T-03-87) and adds `is_current`, but a first upload that is quarantined is not current, so the two rules interact; decide whether owners see quarantined items. Either way the status must come from the column, not the chunk count |
| `GET /api/images` (`src/app/api/images/route.ts`) | Image preview URLs from `document_chunks.metadata.image_url` of any image document | 03-30 Task 2 (current versions only). A quarantined version is never current, so that filter closes it; add `status = 'ready'` as well |
| `GET /api/scrapers/status` | Document row and chunk count by source URL, unfiltered | 03-30 Task 2 |
| `src/lib/rag/context/fetch-rows.ts` | By-id document and chunk-metadata reads | Intentionally unfiltered (plan and D-31, so stored citations resolve). Safe today because its ids come from filtered RPC output; unsafe if a caller ever passes ids from elsewhere. Defence in depth: add the filter for documents and keep a separate citation-resolve path |
| Table SELECT RLS policies | Single-tenant: `FOR SELECT USING (true)` on `documents` and `document_chunks` for anon and authenticated, so a direct PostgREST read returns quarantined text. Multi-tenant: owner or member of the tenant | Needs a migration (policy `status <> 'quarantined'` for non-service roles, or revoke direct reads) and both setup files. I did not add one: migration numbers 0311 to 0316 are claimed by parallel plans. Fold into plan 03-37's migration or a gap plan |
| `get_document_chunks(doc_id)` (single-tenant SQL) | Returns the chunks of any document id with no D-08 filter and no revoke from anon or authenticated. Not called from `src/` | Same migration: add the filter or revoke |
| `get_documents_by_type_slug`, `get_documents_by_type_slug_workspace`, `get_workspace_context` (multi-tenant SQL) | Unfiltered; revoked from anon and authenticated, service role only; not called from `src/` | Low risk; add the filter when next touched |
| `scripts/rag/reprocess-documents.js`, `check-url-metadata.js` | Operator CLIs reading all chunks with the service role | Operator tools; leave |
| Legacy writers (`process-document`, `ai-to-rag`, nango sync, scrapers, `storeDocument`) | Never scanned: documents written there are never quarantined | T-03-58, accepted while `RAG_INGEST_PIPELINE=legacy` is the default; the scan runs only through `ingest()` |
| Captions and invoice party names | Not scanned yet | Plans 03-38 and 03-29 call `scanText` as the plan says |

## User Setup Required

None. This plan adds no environment variable, migration or package.

## Operator actions

- **Migrations:** none added. The three readers now filter on `documents.is_current`, `documents.status`, `document_chunks.is_current` and `document_chunks.status`, which migrations 0301 and 0304 add. Apply 0301 to 0310 to a project before deploying this code to it, or the voice keyword fallback and document references fail on a missing column (the fallback stage skips and degrades; a reference is ignored).
- **Enable the scan:** set `RAG_INJECTION_SCAN=quarantine` with `RAG_INGEST_PIPELINE=unified` (default `off`, no behaviour change). Review `config/rag/injection-rules.json` against your own documents first; a false positive hides a document until an admin releases it.
- **Release and delete** have no UI until plan 03-37 (routes) and 03-43 (panel). Until then a release needs a direct database call to the publish path.
- An invalid or edited rule file makes quarantine-mode ingests fail with `injection_scan_unavailable`; fix the file and re-ingest.

## Next Phase Readiness

- 03-29 and 03-38 call `scanText` on invoice party names and image captions; 03-37 reads `metadata.quarantine` (`rule_ids`, `snippets`, `quarantined_at`) for its list and writes `released_by` and `released_at`.
- Phase 5.1 (SEC-03) imports `scanText` at retrieval time; its signature takes a string only.
- Decision needed before 03-30 and 03-37 are finalised: whether owners see their own quarantined documents in the list, and the RLS follow-up above.

## Self-Check: PASSED

All five created files exist on disk. Commits `aa1f2c1`, `d7a0597`, `6eb8f5a`, `9692920`, `6c1f57f`, `5250e2d` and `2bbb8dd` are ancestors of HEAD and the measured count from the ledger is 7.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
