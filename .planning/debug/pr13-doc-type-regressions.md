---
status: awaiting_human_verify
trigger: "PR #13 (plan 04-37: doc types in fixture corpus + selective_filter golden items) regresses on top of trunk 2b8bd59: fixture-relex (migrations:false frozen pre-Phase-3 setup -> column doc_type does not exist), schema-migrations (documents migrations; chunk columns and legacy-compat triggers), rechunk (4 assertions), possibly characterize-voice v2 wire contract."
created: 2026-11-24T00:00:00Z
updated: 2026-11-24T00:00:00Z
---

## Current Focus

bug_class: Bohrbug (deterministic, 100% repro alone)
status_note: root causes confirmed; entering fix (TDD: existing failing tests + new focused harness test)
next_action: add tests/rag-db/fixture-doc-type.test.mts (RED on the frozen setup), then make createFixtureDatabase write doc_type only to columns that exist

reasoning_checkpoint:
  hypothesis: "(1) createFixtureDatabase (04-37) names doc_type in all four prechunked INSERTs; the frozen pre-Phase-3 setups have no documents.doc_type / document_chunks.doc_type, so every migrations:false fixture built on them aborts at the first document INSERT (fixture-relex frozen subtests, 12 schema-migrations subtests). (2) schema-migrations 'rows inserted by the fixture loader after the migrations carry the column defaults' asserts doc_type='general' for all rows, which 04-37 intentionally changed. (3) rechunk: the corpus now contains one contract_legal document (scanned-contract.zh, tenant u:...f1, prechunked, no parse output) that the rechunk job correctly records as a no_parse_output gap, breaking the suite's global counts and readiness assumptions."
  confirming_evidence:
    - "error text names relation documents/column doc_type; frozen setups have 0 doc_type references; folded-setup migrations:false subtests pass"
    - "schema-migrations subtest 2 is an AssertionError on the migrations:true folded path, not a column error"
    - "rechunk 23/23 pass when only scanned-contract.zh.md is retyped to general; report shows documentsGapped 2 / missingInScope 2"
    - "full rag-db run: failures are exactly fixture-relex, schema-migrations, rechunk plus the optional ingestion-ledger-pg"
  falsification_test: "If writing doc_type only when the column exists does not turn the frozen-setup subtests green, or if the folded fixtures stop carrying the corpus types (eval baselines would drift; test-rag gate fails), (1) is wrong. If the rechunk suite still fails with a corpus that has no contract_legal document, (3) is wrong."
  fix_rationale: "(1) The frozen setup represents a database before Phase 3: there is no doc type to record, and 0301/0304 give every row the 'general' default on upgrade, which is exactly what schema-migrations asserts. Detecting the columns keeps 04-37's typed rows wherever the schema has the columns (folded setup, migrated DB) and leaves the relex gating untouched. (2) The test must assert the new contract precisely (each row's doc_type equals its corpus doc_type; the other columns keep defaults) rather than the superseded all-general one. (3) The rechunk job is right; the suite silently depended on the shared corpus being untyped. It owns its contract_legal/invoice_receipt populations (EMPTY_TYPE literally names an invoice_receipt profile with no documents), so it builds its two-tenant DB on an empty corpus; no assertion changes."
  blind_spots: "Other createTwoTenantDatabase() consumers that may now silently see typed corpus docs (they pass, but their premises were not re-audited); doc_type_origin stays 'fallback' for typed prechunked rows (not consumed by retrieval/eval)."
  candidate_causes:
    - "code (harness): unconditional doc_type column in INSERTs vs frozen schema (CONFIRMED)"
    - "data (fixture corpus): new contract_legal corpus doc enters rechunk scope (CONFIRMED for rechunk)"
    - "code (rechunk job): wrong eligibility/gap logic (ELIMINATED: behaviour is correct, test passes with corpus contract retyped)"
    - "config/environment: load/timing (ELIMINATED: deterministic alone, same counts every run)"
  and_gate: "yes for (1): unconditional doc_type INSERT AND a caller building on a setup without the column (folded-setup callers pass). no for (3): a single corpus document suffices."

## Symptoms

expected: the four files pass as on trunk 2b8bd59
actual: fixture-relex "a migrations:false fixture on the frozen pre-Phase-3 setup ..." fails with column "doc_type" of relation "documents" does not exist; schema-migrations "documents migrations" and "chunk columns and legacy-compat triggers" fail; rechunk 4 assertions fail
errors: column "doc_type" of relation "documents" does not exist
reproduction: node --import tsx --test tests/rag-db/fixture-relex.test.mts (and the others) in /home/user/wt/fix-13
started: merge of exec/04-37 (a734ee3 adds doc_type to the fixture INSERTs and corpus)

## Eliminated

## Evidence

- timestamp: 2026-11-24T00:00:00Z
  checked: .planning/debug/knowledge-base.md
  found: no knowledge base file in this worktree; prior session relex-rpc-failed-pglite.md covers the migrations:false relex gating (5ec76dc)
  implication: no known-pattern candidate; keep relex gating semantics intact

- timestamp: 2026-11-24T00:00:00Z
  checked: git diff 2b8bd59..HEAD -- eval/harness/pglite-supabase.mts
  found: 04-37 added doc_type to all four INSERTs (documents and document_chunks, both modes) in createFixtureDatabase
  implication: any setup without the doc_type columns breaks at corpus load

- timestamp: 2026-11-24T00:20:00Z
  checked: fixture-relex.test.mts alone on train/pr-13
  found: 6/8 pass; both "frozen pre-Phase-3 setup" subtests fail with column "doc_type" of relation "documents" does not exist; folded-setup migrations:false subtests pass
  implication: failure is specific to a setup without documents.doc_type; folded setup has the column even before migrations

- timestamp: 2026-11-24T00:22:00Z
  checked: grep doc_type tests/fixtures/sql/pre-phase3-*-setup.sql; supabase/single-tenant-setup.sql:1863/2008
  found: frozen setups contain 0 doc_type references; folded setups add documents.doc_type (1863) and document_chunks.doc_type (2008); migrations 0301 (documents) and 0304 (chunks) add them on upgrade
  implication: whether doc_type can be written depends on the schema present at corpus load, not on options.migrations alone

- timestamp: 2026-11-24T00:25:00Z
  checked: schema-migrations.test.mts alone
  found: 14/28 fail. 12 of them (documents migrations 1,3,4,5,6 + 0304 backfill, both modes) build migrations:false on the frozen setup and fail with the same doc_type column error. Subtest "rows inserted by the fixture loader after the migrations carry the column defaults" (migrations:true, folded) fails differently: an AssertionError, because it requires doc_type = 'general' for every fixture row and 04-37 now writes the corpus type (product_technical, invoice_receipt, ...)
  implication: two causes in this file: (a) same frozen-setup column error, (b) a test expectation that encodes "loader writes no doc_type", which plan 04-37 intentionally changed (PLAN must-have: prechunked loader writes it to documents.doc_type and the chunk doc_type column)

- timestamp: 2026-11-24T00:35:00Z
  checked: rechunk.test.mts alone; probe of createTwoTenantDatabase() doc types
  found: 8/23 fail (not 4): builds, profile-ready, resume, dry-run, runRechunkBatch x2, CLI exit 0, CLI resume. The two-tenant DB now holds one corpus document of type contract_legal: scanned-contract.zh.md, tenant u:...f1, status ready, current, prechunked (no stored parse output). There is no financial_report document in the corpus (13 docs: 6 general, 3 product_technical, 2 invoice_receipt, 1 contract_legal, 1 scanned_image)
  implication: the "three financial_report documents" hypothesis is wrong; the extra contract_legal corpus doc is an extra rechunk gap (no_parse_output) in a third tenant

- timestamp: 2026-11-24T00:40:00Z
  checked: differential: scanned-contract.zh.md fixture-meta doc_type set to general (temporarily), rechunk.test.mts rerun, file restored
  found: 23/23 pass
  implication: the single contract_legal corpus document fully explains the rechunk failures; rechunk code is behaving correctly (a prechunked contract without parse output is a real gap); the test's world assumed no background contract_legal document

- timestamp: 2026-11-24T01:10:00Z
  checked: harness fix (column-aware INSERTs) + new tests/rag-db/fixture-doc-type.test.mts
  found: new test RED 5/7 before the fix (both frozen-setup cases: column doc_type does not exist), GREEN 7/7 after; fixture-relex 8/8; schema-migrations 26/28, remaining 2 = subtest 2 with 6 !== 13 (exactly the 6 general corpus docs match)
  implication: (1) confirmed and fixed; (2) is the superseded all-general expectation

- timestamp: 2026-11-24T01:20:00Z
  checked: rechunk with createTwoTenantDatabase({ corpusDir: <empty tmp dir> })
  found: 23/23 pass, no assertion changed
  implication: (3) fixed by isolating the suite from the shared typed corpus

- timestamp: 2026-11-24T01:25:00Z
  checked: npx vitest run tests/rag/characterize-voice.test.ts alone, 3 runs
  found: 3/3 fail deterministically: v2 run returns 131 entries, snapshot voice-v2.json has 119. The extra 12 are the selective_filter golden questions 04-37 added. voice-v2.json came from trunk ef0c40f (not an ancestor of 04-37's f90cd42); 04-37 re-recorded voice.json/chat.json/embed.json (additions only) but could not know voice-v2.json
  implication: not flaky; semantic merge conflict between trunk and 04-37: the v2 snapshot needs the same 12 additions, provided the 119 existing entries are unchanged

## Resolution

root_cause: "(1) 04-37 put doc_type into all four prechunked INSERTs of createFixtureDatabase; the frozen pre-Phase-3 setups have neither documents.doc_type nor document_chunks.doc_type, so every migrations:false fixture on them aborted at the first INSERT (fixture-relex frozen subtests; 12 schema-migrations subtests). (2) schema-migrations 'rows inserted by the fixture loader ... carry the column defaults' still required doc_type='general' on every loader row, which 04-37 intentionally replaced with the corpus type. (3) rechunk: the corpus now has one contract_legal document (scanned-contract.zh, tenant u:...f1, prechunked, no parse output); the rechunk job correctly counts it as a no_parse_output gap, which breaks the suite's global counts and readiness. (4) characterize-voice v2: trunk ef0c40f added the voice-v2.json snapshot keyed on the golden question list; 04-37 branched before it and re-recorded voice/chat/embed for its 12 selective_filter questions but not voice-v2 (semantic merge conflict)."
fix: "(1) createFixtureDatabase checks information_schema for each doc_type column and only names it when present (insertRow/hasPublicColumn helpers); relex gating unchanged. (2) the subtest asserts each row's doc_type equals its corpus document's docType and the other Phase 3 columns keep their defaults. (3) rechunk builds its two-tenant DB on an empty corpus (mkdtemp, removed after load); no assertion changed. (4) voice-v2.json re-recorded with UPDATE_CHARACTERIZATION=1: 12 entries added, the 120 existing entries identical."
oracle_type: "specified (per-row doc_type vs loadCorpus docType; column presence via information_schema; per-entry snapshot equality)"
verification:
  target_test: { result: pass, detail: "fixture-relex 8/8, schema-migrations 28/28, rechunk 23/23, characterize-voice 3/3 (x3 alone), fixture-doc-type 7/7" }
  mutation_check: { result: pass, reason_if_skipped: "Stryker not configured for node:test .mts; manual mutants instead", mutant_killed: "documentsDocType/chunksDocType forced true -> 4 frozen-setup failures; forced false -> 4 folded/migrated failures" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, note: "harness: conditional column, no behaviour removed for schemas that have doc_type; rechunk: background corpus removed from the suite, justified by (3); no assertion weakened" }
  adjacent_tests: { result: pass, detail: "rag-db 806 tests: 801 pass, 0 fail, 2 cancelled (optional ingestion-ledger-pg, pg_ctl as root), 3 skipped; vitest eval-corpus/eval-harness/rag/v2 143/143; characterize chat/embed/chat-overview 4/4; pytest 30/30; test-rag PASS paired.all_zero; ingest PASS paired.all_zero recall@10 0.638; check-rag-boundary ok; tsc 0 errors" }
  revert_and_reconfirm: { result: pass, detail: "harness: RED 5/7 before fix -> GREEN 7/7; rechunk: HEAD test 15/23 -> fixed 23/23; voice: 3 fails before re-record -> 3 passes" }
  guardrail_verdict: accepted
files_changed:
  - eval/harness/pglite-supabase.mts
  - tests/rag-db/fixture-doc-type.test.mts
  - tests/rag-db/schema-migrations.test.mts
  - tests/rag-db/rechunk.test.mts
  - tests/fixtures/characterization/voice-v2.json
