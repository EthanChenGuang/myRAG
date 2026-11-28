---
phase: 07-external-backends-release-defaults
plan: 51
subsystem: docs
tags: [docs, agents-md, readme-rag-pipeline, adm-03, revision-4, lex-05]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-27 README and AGENTS.md sections and their tests; 07-35..07-49 and 07-52 revision-4 features; 07-45 regenerated switch tables; 07-53 LEX-05 BM25 parameters on external backends"
  - phase: 05.1.1-feedback-loop-and-real-domain-test-set-thumbs-failed-query-m
    provides: "05.1.1-22 last cross-phase AGENTS.md editor"
  - phase: 05-verified-citations-groundedness
    provides: "05-25"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-45"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-22"
provides:
  - "README_RAG_PIPELINE.md: Vector sync → Purges, Lexical parameters on external backends; Backends → Source-of-truth recheck, Access groups on external backends; Evaluation workflow → Decision-record numbers; new top-level sections Per-language monitoring, Rollouts, Language addition and removal, Red-team run; contents list updated"
  - "AGENTS.md §6 RAG pipeline: eight revision-4 bullets (purges, recheck, access groups, per-language monitoring, rollouts, languages, red team, decision records); Phase 4.4: one LEX-05 bullet; §16: rebuild-lexical on the vector-sync row and four new rows"
affects: [07-33]

actuals:
  tokens: 6500
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - README_RAG_PIPELINE.md
    - AGENTS.md
    - tests/rag/rag-pipeline-doc.test.ts
    - tests/rag/agents-guide.test.ts

key-decisions:
  - "Revision-4 workflows that belong to an existing section (purges, LEX-05, recheck, access groups, decision records) are subsections of it; the four standalone workflows are new top-level sections listed in Contents"
  - "LEX-05 Qdrant branch taken from 07-53-SUMMARY: Qdrant is query-bound (pair sent per query, record refreshed only); Weaviate is index-bound (mismatch → not served, pgvector degraded with backend_not_ready, until rebuild-lexical --confirm)"
  - "Red-team domain neutrality is documented as a review rule: 07-42 did a manual banned-term review and no automated check enforces it (see Deferred)"
  - "§16's four new commands: rag:rollout, rag:languages, rag:red-team and the language-confidence calibration (npx tsx; there is no npm script)"

requirements-completed: [ADM-03, LANG-10, LANG-11, SEC-11, RET-05]

coverage:
  - id: D1
    description: "README_RAG_PIPELINE.md documents every revision-4 workflow outside the generated markers"
    requirement: ADM-03
    verification:
      - kind: unit
        ref: "tests/rag/rag-pipeline-doc.test.ts#README_RAG_PIPELINE.md revision-4 workflows"
        status: pass
      - kind: other
        ref: "node scripts/rag/gen-pipeline-doc.mjs --check"
        status: pass
  - id: D2
    description: "AGENTS.md §6 bullets, Phase 4.4 LEX-05 bullet and §16 rows"
    requirement: ADM-03
    verification:
      - kind: unit
        ref: "tests/rag/agents-guide.test.ts#AGENTS.md reflects the Phase 7 revision-4 workflows"
        status: pass
---

# Phase 7 Plan 51: Revision-4 documentation Summary

README_RAG_PIPELINE.md and the AGENTS.md RAG section now describe the Phase 7 revision-4 workflows (purges, forced recheck, access groups on external backends, per-language monitoring, rollouts, language addition and removal, red-team run, decision-record numbers) and the LEX-05 BM25 parameters on Weaviate and Qdrant, with commands, switches and defaults taken from the code at HEAD.

## Branch setup

- `exec/07-51` was created from `origin/exec/07-49` (68fe36e0). The orchestrator authorized `--no-ff` merges of `origin/exec/07-52` (81d1328b), `origin/exec/07-39` (3a3f1adc), `origin/exec/07-30` (22c6f941) and `origin/ci/merge-train-41` (6fc5abc2).
- **Conflicts: none.** All four merges were clean. Migrations 0740, 0741, 0742, 0743, 0744 and 0745 are all present after the merges. This plan adds no migration.

## Preconditions

- 05-, 05.1- and 06-VERIFICATION.md are all `status: human_needed`.
- Every depends_on SUMMARY is present on the branch: 07-27, 07-35..07-49, 07-52, 07-53, 05.1.1-22, 05-25, 06-45 and 05.1-22.

## Commits

| Task | Commit | Type |
|------|--------|------|
| 1 RED | 0de284c8 | test: pipeline-guide revision-4 headings and fragments (24 assertion failures before the doc change) |
| 1 GREEN | 32b89a4c | docs: README_RAG_PIPELINE.md sections |
| 2 RED | fd47a279 | test: AGENTS.md revision-4 bullets, LEX-05, §16 (20 assertion failures before the doc change) |
| 2 GREEN | 038a8902 | docs: AGENTS.md bullets and §16 rows |

## Behaviour changes

None. The plan changes documentation and tests only. The generated switch tables are unchanged.

## Gates run

- `npx vitest run tests/rag/rag-pipeline-doc.test.ts tests/rag/agents-guide.test.ts`: 252 passed.
- `node scripts/rag/gen-pipeline-doc.mjs --check`: ok, 222 managed variables.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- These checks all exited 0:
  - `node scripts/ci/check-rag-boundary.mjs`
  - `node scripts/check-config.mjs`
  - `node scripts/ci/check-language-literals.mjs`
  - `node scripts/ci/check-settings-classification.mjs`
- Not run, because the plan does not touch their areas: rag-db, Python, schemas, test-rag, UI and workflows. No other test reads either document; I checked with `git grep`.

## Deviations

- The plan asks for a domain-neutrality rule for the red-team corpus. 07-42-SUMMARY records only a manual banned-term review, and no test or check enforces it. I documented it as a review rule and did not claim an automated check.
- The test-split ledger was not touched (D-37).

## Threat model

- T-07-169: the docs use placeholders only (`<key>`, `<id>`, `<rollout_id>`). The existing key-like and URL-host tests pass on the new text.

## Deferred

- No automated domain-neutrality check exists for `eval/fixtures/red-team/attack-corpus.jsonl` (low). A banned-term grep test would close it.
- From 07-46: there is no Config UI panel for `/api/rag/admin/language-quality`, so the docs describe the route only.
- From 07-43: the ADM-02 blocks in `eval/config/release-defaults.json` are not annotated yet. That needs the operator's live 07-33 run. The docs describe the writer only.

## Operator actions

None new.

## Decisions for STATE

- ADM-03 revision-4 delta is documented. LEX-05 doc must-have is met (the string `rebuild-lexical` is asserted in both doc tests).
