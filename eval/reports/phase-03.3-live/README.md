# Phase 3.3 live verification (plan 03.3-26)

Eval project only (the owner's evaluation Supabase project; never production). Never part of CI.
Reports hold numbers, counts, function names, status codes, verdicts and versions only. No tenant text, pattern, attribute value,
template, file name or key is written here. Before every commit the owner runs the privacy check of
`.planning/phases/03.3-templated-collection-ingestion/03.3-26-CHECKPOINT.md`.

Status: waiting for the owner. The record lines below are filled in by the owner from the checkpoint steps; until then this
file holds no result line.

## Upstream (Task 1, executor)

- Plan 03.3-25: SUMMARY present; `eval/reports/phase-03.3/comparison.json` passed true.
- `eval/reports/phase-03.3/gates.json`: every gate passes except `no_other_slice_drop` (fixture mode, 1 of 11 items), carried into this
  plan by orchestrator decision (b) of `handoffs/03.3-25-requirement-TPL-09.md`. Its real-item check is step T below.
- Eval project migration head before this plan: `<owner: highest applied migration number>`.

## Task 2: migrations 1001 to 1009 and grants

- Applied in file order after `<owner: head>`; second apply: `<owner: no error | error code>`.
- Grants probe: `node scripts/rag/phase33-live-grants.mjs --out eval/reports/phase-03.3-live/grants.json`, exit `<owner>`;
  calls `<owner>`, failures `<owner>`.
- Record line (owner, when every client call was refused and every service-role call returned 2xx): see checkpoint step 2.

## Task 3: boilerplate residue (A1)

- Documents `<owner: n ≥ 5>`; Docling `<owner: version>`, docling-core `<owner: version>`; `rules_version` 1 (unchanged).
- False removals `<owner: total>`; repeated lines counted `<owner>`, removed `<owner>` (`<owner: share>`).
- Verdict: `<owner: trusted | not_trusted>`; hand-off `<owner: none | handoffs/03.3-26-thresholds.md>`.
- Record line: see checkpoint step 3.

## Task 4: one tenant import, A2 and A3

- Import counts: `import.json`; second apply changed `<owner: 0>` documents.
- A2 chunk copy trigger: `<owner: ms per 1,000 rows>`, `<owner: share of INSERT time>`; verdict `<owner: holds | fails>`.
- A3 id list: 2,000 ids status `<owner>`, p95 `<owner>` ms against the 100-id p95 `<owner>` ms; verdict `<owner: holds | fails>`.
- Record line: see checkpoint step 4.

## Step T: TPL-09 header A/B on real items (D-26 must-check from 03.3-25)

- Tool: `python -m rag_eval.header_ab_check` (from the repository root through `uv run --directory eval`), output
  `eval/reports/phase-03.3-live/tpl09/header-ab.json` and `header-ab.md`.
- Rule: header on vs header off, templated items left out, target `category:cache_near_miss` recall@5 and every other slice; a fall
  below the header-off value minus the noise band (floor 0.02, `eval/config/noise.json`) reopens D-26 (verdict `reopen_d26`).
- Verdict: `<owner: holds | reopen_d26 | missing_data>`; header on `<owner>`, header off `<owner>`, n `<owner>`.
- Record line: see checkpoint step T.

## Fixture rehearsal of step T (executor, 2026-11-27)

`tpl09-fixture-rehearsal/` holds the tool run on the fixture: `eval/config/tpl09-header-ab-comparison.json` (tpl-recommended with
`RAG_ATTRIBUTE_HEADER` true and false, ingest mode, fixture embedder), then `header_ab_check --population fixture`. It reproduces the
03.3-25 finding: cache_near_miss recall@5 0.8182 (header on) vs 0.9091 (off), threshold 0.8891, 1 of 11 items worse, no other slice
drop, verdict `reopen_d26`. This proves the tool and the run configs only; the hashed n-gram fixture embedder does not stand in for real
semantics, so the decision rests on step T. The same runs in real mode answer `missing_data` (`not_live_run`, `not_real_population`).
