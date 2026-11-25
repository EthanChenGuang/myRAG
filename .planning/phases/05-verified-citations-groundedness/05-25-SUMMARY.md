---
phase: 05-verified-citations-groundedness
plan: 25
subsystem: database, eval, docs
tags: [rag_answer_records, setup-fold, schema-equality, phase-compare, d-25, citations, groundedness, agents-md]

requires:
  - phase: 05-verified-citations-groundedness
    provides: "0501/0502 rag_answer_records (05-06); citation metrics (05-24); fake citation generator and fake groundedness in the harness (05-22); every other Phase 5 plan except 05-26"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "phase_compare tool and spec pattern (04-40); setup fold and schema-equality structure (04-42, 04-47)"
provides:
  - "Both setup files close with a verbatim 'Phase 5: Answer records' section (0501 plus the mode's own 0502)"
  - "schema-equality: 0501-0502 in the folded set, Phase 5 section placement, and answer-record security assertions on a fresh install (RLS, select-own policy, mode tenant_key expression, anon none, authenticated SELECT only)"
  - "phase_compare schema 2: switch runs (process-env switches, harness flags, named checks paired_all_zero, retrieval_unchanged, no_slice_drop, citation_validity, plus named commands)"
  - "eval/config/phase5-comparison.json and the recorded eval/reports/phase-05/comparison.{json,md} (passed: true)"
  - "AGENTS.md Phase 5 section, anthropicId in the Model schema, §14 additive-behaviour line, fold note"
affects: [05-26]

actuals:
  tokens: 70000
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Schema-2 comparison specs set feature switches in the harness process environment, never in the run-config env overlay, whose allowlist stays the Phase 4 retrieval switches"
    - "Switch names in a comparison spec must match RAG_* and may not look like credentials (KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL)"

key-files:
  created:
    - eval/config/phase5-comparison.json
    - eval/reports/phase-05/comparison.json
    - eval/reports/phase-05/comparison.md
  modified:
    - supabase/single-tenant-setup.sql
    - supabase/multi-tenant-setup.sql
    - tests/rag-db/schema-equality.test.mts
    - eval/src/rag_eval/phase_compare.py
    - eval/tests/test_phase_compare.py
    - AGENTS.md

key-decisions:
  - "Fold 0501 and 0502 verbatim after the 0425 section (migration order); 0426 and 0427 stay unfolded, as before (they do not touch rag_answer_records)"
  - "phase_compare gets a second spec schema (schema_version 2) dispatched by main(); the Phase 4 schema-1 path is unchanged"
  - "retrieval_unchanged reuses the gate's answer-only option exclusion (citations, groundedness, generator_model) and fails on any non-zero Recall@5, Recall@10 or MRR paired cell or any data mismatch; paired_all_zero also covers refusal cells"
  - "citation_validity fails when invalid_citation_rate is unmeasured or measured over zero citations, not only when it is above 0"
  - "Off runs set all six Phase 5 switches to false explicitly, so an operator's shell cannot leak a switch into the comparison"
  - "Command checks run with the run's switches in the environment and are cached per (command, switch set)"

requirements-completed: [GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, EVAL-16]

coverage:
  - id: D1
    description: "Fresh install from either setup file equals frozen setup plus migrations, re-applying migrations changes nothing, and rag_answer_records is secured"
    requirement: GEN-06
    verification:
      - kind: integration
        ref: "tests/rag-db/schema-equality.test.mts (single-tenant setup, multi-tenant setup, folded migration set, Phase 3.1 fold)"
        status: pass
      - kind: integration
        ref: "tests/rag-db/answer-records-rls.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-25 a and b on the fixture corpus: switches off paired differences all zero plus characterization; switches on retrieval unchanged, no slice drop, invalid_citation_rate 0, strict refusal suites"
    requirement: EVAL-16
    verification:
      - kind: integration
        ref: "uv run --directory eval python -m rag_eval.phase_compare --spec eval/config/phase5-comparison.json --out eval/reports/phase-05"
        status: pass
      - kind: unit
        ref: "eval/tests/test_phase_compare.py (schema 2 cases, including synthetic failing inputs)"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-25 c, d, e: success-criteria, RLS and strict-refusal suites in one full run"
    requirement: GEN-05
    verification:
      - kind: unit
        ref: "npx vitest run; node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts"
        status: pass
    human_judgment: false
  - id: D4
    description: "AGENTS.md documents Phase 5 switches, strategies, Vectara acknowledgement, anthropicId, rag_answer_records and routes, review queue, hhem target"
    verification:
      - kind: unit
        ref: "tests/rag/agents-guide.test.ts; acceptance greps"
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 25: Fold, D-25 proof and guide Summary

**A fresh install now gets `rag_answer_records` with the same columns, tenant key, RLS, policy and grants as a migrated database. The fixture corpus shows that the Phase 5 switches change nothing when off, leave retrieval unchanged when on, and produce zero invalid citations. AGENTS.md documents Phase 5.**

## Performance

- **Duration:** about 75 min
- **Tasks:** 3
- **Files modified:** 9

## Task Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Fold 0501/0502 (D-16) | `31175c7` test: 8 subtests failed on assertions (setup lacked the table, the fold placement test, the equality diffs) | `86d69e3` feat |
| 2. D-25 comparison (D-25 a, b) | `a733aef` test: 7 cases failed on assertions against stub checks that returned `passed=False` | `6160157` feat: real checks and the recorded report |
| 3. AGENTS.md and full gates | — | `a982093` docs |

## Behaviour changes

- **New installs:** both setup files end with the "Phase 5: Answer records" section (0501, then `0502_rag_answer_records_tenant.<mode>.sql`). Upgrades still use migrations; 0501 and 0502 are idempotent on top of the new setup.
- **phase_compare:** a `schema_version: 2` spec is a new input form. The Phase 4 schema-1 spec, its rules and its report are unchanged. `RunRequest` gained optional `process_env` and `harness_flags`; empty values keep the old spawn exactly.
- **Product runtime:** no change. No switch, env variable, route or prompt was added or changed.

## Recorded comparison (eval/reports/phase-05)

| Run | Mode | Checks | Result |
|-----|------|--------|--------|
| off-prechunked | prechunked | paired_all_zero, characterization | PASS |
| off-ingest | ingest | paired_all_zero, characterization | PASS |
| on-prechunked | prechunked | retrieval_unchanged, no_slice_drop, citation_validity (0.0 over 92 citations), strict_refusal | PASS |
| on-ingest | ingest | retrieval_unchanged, no_slice_drop, citation_validity (0.0), strict_refusal | PASS |

Citation coverage: 0.974 for prechunked and 0.985 for ingest. Both are report-only.

## Gate results (final run, branch HEAD a982093)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 316 files, 5126 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 172 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1474 tests: 1470 pass, 0 fail, 4 skipped (the known ingestion-ledger-pg skips) |
| `check-rag-boundary.mjs` + node test | pass |
| `node scripts/check-config.mjs` | ok: 161 variable(s) match the manifest |
| `check-workflows.py` | OK |
| `eval` pytest | 771 passed |
| `rag-sidecar` pytest (chunking extra) | 1464 passed, 11 skipped |
| `npm run gen:schemas` | no diff |
| `npm run test-rag -- --out eval/out/05-25` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/05-25-ingest` | gate PASS (7 skipped) |
| phase5 comparison | PASS, `jq -e '.passed == true'` true |

D-25 c, d and e are the named suites inside this run: the citation, Claude-path, groundedness and feedback suites under `tests/rag/`; `tests/rag-db/answer-records-rls.test.mts`; and `tests/chat-strict.test.ts`.

## Deviations

1. **Switches go into the process env, not the run-config overlay.** The run-config allowlist in `eval/harness/run-config.mts` only takes the Phase 4 retrieval switches. phase_compare therefore passes the Phase 5 switches as environment variables of the harness process and of the command checks. The allowlist stays as it is. The fixture answer path follows the `--citations` and `--groundedness` harness flags.
2. **Extra check beyond the plan.** On runs also run a `strict_refusal` command: `chat-strict`, `chat-citations-route` and `answer-finish-groundedness-route`. This covers D-25 e inside the comparison. Off runs run the `characterization` command: the characterize-chat/overview/embed/voice, chat-strict, chat-websearch and chat-source-images suites.
3. **Folded-set comment and AGENTS.md.** The fold note now also names 0425 under Phase 4 and says that 0426 and 0427 are not folded. This states facts; nothing about them changed.
4. **Ruff.** `ruff` is not a gate. The 12 findings that were already in the two Python files are left as they were. The findings this plan introduced were fixed.

## Requirements and decisions for STATE

- Requirements: GEN-01 to GEN-07 and EVAL-16 are complete on the fixture corpus (D-25 a to e). Live verification is plan 05-26.
- Decision: phase_compare schema 2 is the template for future phase comparisons. It sets switches through the process env, checks names against RAG_* and rejects anything that looks like a credential.

## Operator actions

None for this plan. Applying 0501/0502 on live Supabase, and the live Anthropic, Vectara and HHEM checks, are plan 05-26.

## Deferred

- Folding 0426 and 0427 into the setup files: this plan did not own them.
