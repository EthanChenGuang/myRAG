# Phase 4.2 coordinator summary (D-38)

Written by plan 04.2-32 on 2026-11-27, at the phase close. One list of every upstream item and hand-off of the phase, with its status.

## D-38 items

| Item | Topic | Hand-off file | Status |
| --- | --- | --- | --- |
| (a) | ROADMAP 4.2 success criterion 5 wording breaks domain neutrality; proposed "a question naming two cell values of one table row" | `04.2-24-coordinator.md` | open: ROADMAP edit for the coordinator (executors do not edit ROADMAP.md) |
| (b) | EVAL-20 weekly-report row depends on FBK-10 (Phase 5.1.1) | none needed: `04.2-20-SUMMARY.md` | done: `rag_eval.weekly_report` existed, plan 04.2-20 added the per-tenant mean top-k redundancy table |
| (c) | RET-11 "set by QRY-10" | `04.2-15-version-scope-notes.md` | open, wording only: Phase 6.2 sets `retrievalFilters.versions` through the same field; no second path |
| (d) | LANG-07 picks up XLG-05 glossary pairs once Phase 6.2 stores them as `translation` entries | `04.2-19-xlg05.md` | open for Phase 6.2: no code needed here; a `--stale-dictionary` relex brings them in |
| (e) | Keeping superseded vectors | `04.2-15-version-scope-notes.md` | decided by the owner 2026-11-25, D-58: not kept; history retrieval is lexical and deterministic only |
| (f) | An embed-specific opt-in for `versions` | `04.2-15-version-scope-notes.md`, `04.2-21-embed-sources.md` | decided by the owner 2026-11-25, D-58: `RAG_EMBED_VERSION_SCOPE` (plan 04.2-39), stated in AGENTS.md |
| (g) | Order of the `hybrid_search_chunks` redefinitions between 3.2 and 4.2 | `04.2-09-hybrid-order.md` | done in code (0856 rebuilt on 0802); the coordinator confirms that any later 3.2 redefinition rebases on 0856 |
| (h) | Order of `diversify` relative to 06-25's `reserveSubQuestionCoverage` | none (pinned by `tests/rag/v2/rank-order.test.ts`) | done: rerank, refusal, diversify, then the sub-question reservation; Phase 6 plan 06-25 keeps the order |
| (i) | Voice TTFT measured in the voice agent, not the app | `04.2-11-voice-ttft-point.md` | done (D-39): agent posts to `/api/internal/voice-timing`; LAT-04 "server-side" wording for the coordinator |
| (j) | Domain-specific names in `src/lib/rag/retrieval/exact-id.ts` and `src/lib/rag/ids/shapes.ts` | `04.2-24-coordinator.md` | open: the cleanup needs an owner |

## Other hand-offs of the phase

| File | Status ("open": no later SUMMARY records a fix) |
| --- | --- |
| `04.2-01-sweep-cap-min.md` | done by 04.2-05 (cap minimum 25) |
| `04.2-01-upstream.md` | record of the 04.2-01 upstream gate |
| `04.2-02-config-ui-i18n.md` | done by 04.2-25 (zh and it strings) |
| `04.2-02-settings-classification.md` | open: the three backfill-dependent switches use mechanism `reparse` until dedicated rebuild mechanisms exist |
| `04.2-04-registry-stemmer.md` | open: registry fields the tokenizer does not drive yet |
| `04.2-06-eval-tuning-overrides.md` | open: eval tuning overrides do not reach the request hash yet |
| `04.2-07-fixture-drift.md` | addressed by 04.2-32 Task 3 (fixture calibration re-run) |
| `04.2-12-golden-rule.md` | open: GoldenItem category rule for no-answer near-miss items |
| `04.2-16-eval-run-clustering.md` | open: where a fixture duplicate threshold applies; live threshold is 04.2-33 |
| `04.2-21-embed-sources.md` | open: the embed route has no sources payload |
| `04.2-23-finding-copy.md`, `04.2-23-hidden-utility.md` | open UI follow-ups |
| `04.2-23-proxy-wildcard.md` | done: RAG proxy path bug fixed |
| `04.2-23-ui-review.md`, `04.2-25-ui-review.md` | UI review records |
| `04.2-26-panel-preexisting.md` | open: pre-existing sources-panel findings |
| `04.2-30-canary.md` | open for Phase 7 (RET-08 canary cases) |
| `04.2-38-purge-inventory.md` | open for Phase 6.3 (plan 06.3-19) |
| `04.2-32-gate-identifier.md`, `04.2-32-gate-versions.md` | resolved (PRs #125, #128) |
| `04.2-32-gate-diversity.md` | resolved: option 1 chosen by the orchestrator under owner delegation and fixed in `src/lib/rag/v2/diversify.ts` |

## Gate FAIL on `category:scanned` and the D-31 revision (2026-11-28)

Source: `.planning/debug/phase42-scanned-slice-regression.md` (branch `exec/debug-42-scanned`).

- **Correction of the quick-42-fixes note.** The W-3 entry of `exec/quick-42-fixes` (c50e5550) and its summary `.planning/quick/261127-q42-phase42-verify-fixes/261127-q42-SUMMARY.md` say the diversity and identifier gates fail "on the later `category:scanned` slice" and call the slice an addition made after Phase 4.2. That is wrong. The scanned items (`{en,it,zh}-scanned-00{1,2}`) came in with plan 01-15 and were in the gated population when the committed 4.2 report was made (152d29f61). What came after 4.2 is the fixture corpus of plan 05.2.1-12 (`calc-rules.*`, `long-reference.*`, 57 golden items). It changed the candidate pool of the reference run, one marginal item (`en-scanned-001`) moved in the reference, and that exposed two limits that were already there: the chunk-level identifier filter (b1) and MMR's sensitivity at the context cutoff (b2). When `exec/quick-42-fixes` is merged, read its W-3 sentence with this correction; its numbers are right, its cause is not.
- **D-59 (D-31 revision).** The identifier filter moves from chunk level to document level; the near-miss guard stays per chunk. Decided by the orchestrator under the owner's standing authorization, not an owner sign-off; the owner can overturn it. Text and evidence: 04.2-CONTEXT.md, "D-31 revision (2026-11-28)".
- **Gap plan 04.2-40** (wave 12; depends on 04.2-27, 04.2-29, 04.2-32, 04.3-11, 04.4-14, 05.2.1-12): the document-level predicate in `hybrid_search_chunks`, `rag_bm25_search_chunks`, `rag_exact_id_documents` and `rag_table_lookup`; failing-first and parity tests; `rag_eval.sweep diversity` re-run; the gate re-run with the unchanged spec, result recorded as measured.
- **Migration number.** The redefinition must sort after 0930, 0932 and 0933, which hold the newest bodies. A free 08xx number (0866 and up) would be overwritten by them in file order. The plan claims the lowest free number above the newest definer at execution, expected **0935**, inside Phase 4.3's gap-closure range (0935 to 0939). The Phase 4.3 owner should be told when the number is claimed.
- **Pending owner decisions, not applied by any plan:** (1) D-59 itself; (2) the gate rules of the debug report, section 4 item 3: a minimum slice size (`min_gate_n`) or paired item flips for small slices, a rule that plans adding shared fixture documents re-run the phase fixture gates, and whether `identifier_precise` accepts a cited chunk of a carrying document. Until (2) is decided the spec stays as it is; the diversity gate can stay FAIL on the 4-item slice after 04.2-40, and the plan records that as measured.
- The committed `eval/reports/phase-04.2/` (PASS) belongs to the corpus before 05.2.1-12 until plan 04.2-40 Task 5 re-renders it.

## Plan 04.2-40 migration claim (2026-11-28)

| Number | Plan | Note |
|---|---|---|
| 0936 | 04.2-40 | `0936_identifier_document_filter.sql`. It sits in Phase 4.3's block (0935 to 0939) because it redefines `hybrid_search_chunks`, `rag_bm25_search_chunks`, `rag_exact_id_documents` and `rag_table_lookup`, whose newest bodies are in 0930, 0932 and 0933. 0935 is already held by exec/04.4-16 for plan 04.4-17. Tell the Phase 4.3 owner. |

**Ordering requirement for 04.4-17 (required, not a suggestion).** 04.4-17 plans to redefine `rag_bm25_search_chunks` with `p_df_mode` in 0935. 0936 rebuilds that function from the 0932 body, and its precheck stops with 55000 when the function has an argument outside the 0932 signature. If 0935 ships with that body, a fresh apply in file order stops at 0936. 04.4-17 must give up 0935, take a number above 0936, rebuild from the 0936 body and keep the `identifier-document-filter` marker fragment. Details: `04.2-40-bm25-ordering.md`.

## Plan 04.2-40 result (2026-11-28)

- Gate on the current corpus, spec unchanged: off_identity, identifier, table, versions and dictionary PASS.
- Diversity FAILs on `category:scanned`: one item (`en-scanned-001`) drops out of the top 10 under MMR in a 4-item slice. Hand-off: `04.2-40-gate-diversity.md`.
- Identifier precision is 1.0 and leakage 0.0. `en-scanned-001` is retrieved at rank 2 under `v2-identifier-on`.
- Diversity sweep: no eligible lambda; `mmr_lambda` stays 0.9 (`04.2-40-diversity-sweep.md`).
- Ordering hand-off for 04.4-17: `04.2-40-bm25-ordering.md`.
- Pending owner decisions:
  1. D-59 itself.
  2. The gate rules of debug report section 4 item 3: `min_gate_n` or paired flips, whether plans that add fixtures must re-run the gates, and `identifier_precise` for a carrying document.
