---
phase: 06-query-layer-llamaindex-langchain
plan: 45
subsystem: database, docs
tags: [setup-fold, schema-equality, agents-guide, phase-close]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-40 last product change, 06-44 phase comparison"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-42 fold pattern and per-mode schema-equality cases"
  - phase: 05-verified-citations-groundedness
    provides: "05-25 last fold of both setup files before Phase 6"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-22 last Phase 5.1 edit of AGENTS.md"
provides:
  - "Migrations 0601-0603 folded into supabase/single-tenant-setup.sql and supabase/multi-tenant-setup.sql"
  - "Per-mode schema-equality cases for the Phase 6 fold (one hybrid_search_chunks overload, service_role-only Phase 6 functions, rag_semantic_cache RLS with no client privilege)"
  - "AGENTS.md Phase 6 guidance (query layer, semantic cache, small-talk and cache-hit behaviour, zod isolation and LangChain/query-LLM boundary rules)"
affects: [06.2, 06.3, 07]

requirements-completed: [CACHE-01, XLG-01, LAT-03, QRY-05, QRY-08]

actuals:
  tasks: 2
  commits: 5
---

# 06-45 Summary: Phase 6 close-out (setup fold, gates, agents guide)

**This was a FINISH run.** An earlier session pushed both tasks to `exec/06-45` but never wrote a SUMMARY. I checked the work on this tree (`base/06-45` = `exec/06-45` + origin/main `5f165998`, now fast-forwarded onto `exec/06-45`), ran the plan's gate chain with every switch at its default and wrote this SUMMARY. I made no code change: both tasks were already complete and their tests pass.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | `581fbd4f` | test(06-45): Phase 6 fold cases in schema-equality (RED) |
| 1 GREEN | `2a0f2cdd` | feat(06-45): fold migrations 0601-0603 into both setup files |
| 2 RED | `502c2706` | test(06-45): AGENTS.md guide cases for the Phase 6 query layer and cache (RED) |
| 2 GREEN | `0ae0e7ba` | docs(06-45): AGENTS.md Phase 6 query layer, semantic cache and checks |
| — | this commit | docs(06-45): summary |

(The earlier session wrote the RED commits. I did not re-run them on their parent trees.)

## Behaviour

- **Setup files.** Each setup file gains a Phase 6 section after the Phase 5.1.1 section, holding 0601 (`rag_tenant_language_shares`), 0602 (`hybrid_search_chunks` with `p_include_undated`) and 0603 (`rag_semantic_cache` table, `rag_cache_*` functions, `documents` statement triggers). They are copied verbatim, in migration order. The Phase 4.1.1 (0471-0473) and Phase 6.1 (0651-0654) sections that came later follow it, and 6.1 still closes the file. Every REVOKE from PUBLIC, anon and authenticated is kept.
- **New projects** get the Phase 6 schema without running 0601-0603. Existing projects keep using the idempotent migrations.
- **AGENTS.md.** §6 gains the "Query layer and semantic cache (Phase 6)" section, and its fold sentence names Phase 6 (0601-0603). §14 gains the line about small talk, strict refusal and `cache: hit`. §15 gains the zod isolation check and the LangChain and query-LLM boundary rules.
- **Runtime.** No product code, env default or switch changed.

## Acceptance criteria

- `grep -c rag_semantic_cache supabase/single-tenant-setup.sql` = 36 (>= 1)
- `grep -c rag_tenant_language_shares supabase/multi-tenant-setup.sql` = 4 (>= 1)
- `grep -c "RAG_QUERY_LAYER\|RAG_SEMANTIC_CACHE" AGENTS.md` = 4 (>= 1 each)

## Gates run (this session, defaults, trees identical to main `5f165998`)

| Gate | Result |
|---|---|
| `node --import tsx --test tests/rag-db/schema-equality.test.mts` (both per-mode setup cases included) | 43/43 pass, `# fail 0` |
| `npx vitest run tests/rag/agents-guide.test.ts` | 132/132 pass |
| `npx vitest run` (full) | 706 files passed, 2 skipped; 12923 tests passed, 56 skipped |
| `node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts` | at the time of writing, 326 top-level suites ok, 0 `not ok`, run still in progress (see note) |
| `uv run --directory eval pytest -q` | 2294 passed |
| `uv run --directory rag-sidecar pytest -q` | 2675 passed, 12 skipped |
| `node scripts/check-config.mjs` | ok (255 variables) |
| `node scripts/ci/check-rag-boundary.mjs` | ok (2298 files) |
| `node scripts/ci/check-zod-isolation.mjs` | ok |
| `node scripts/ci/check-language-literals.mjs` | ok |
| `node scripts/ci/check-settings-classification.mjs` | ok (207 variables) |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx next build` with the CI placeholder env (pr-smoke.yml `build` job) | pass |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/p6-45-ingest` | exit 0; `.passed == true and .paired.all_zero == true` |
| `npm run test-rag -- --out eval/out/p6-45` (plan command, enforce mode) | gate.json `.passed == true`, `.paired.all_zero == true`; exit 11 from the **absolute** gate (see deviations) |
| same tier with `--gates-mode report` (as CI runs it) | exit 0 |
| legacy tier: `--run-config eval/config/runs/legacy.json --baseline eval/baselines/fixture-baseline.json --gates-mode report` | exit 0; passed, paired all zero |
| legacy ingest tier: `--run-config eval/config/runs/legacy.json --fixture-mode ingest --baseline eval/baselines/fixture-ingest-baseline.json` | exit 0; passed, paired all zero |

Note: the Node/DB run (about 300 PGlite test files) was still running when this SUMMARY was committed, because the orchestrator asked for the push. If it finishes with a failure, a follow-up commit updates this table.

## Deviations and decisions

1. **The 0602 fold appends rather than editing the earlier definition.** The plan says 0602 "replaces the folded hybrid_search_chunks definition rather than adding a second one". The fold appends 0602 verbatim, and 0602 itself drops the 0407 signature first. The result is the same: one overload, asserted in the per-mode cases. Copying verbatim keeps the setup file byte-equal to the migration bodies, which is what the equality test compares. I kept this choice.
2. **`next build` without env fails here** with `supabaseUrl is required` (collecting page data for `/api/ai-to-rag`) because the sandbox has no `.env.local`. With CI's placeholder env (`.github/workflows/pr-smoke.yml`, build job) it passes. This is environment only, not a code issue.
3. **The default fixture tier's absolute gate fails in enforce mode**: `false_refusal_rate language:en: measured 0.3143 vs max 0.2500` (overall false_refusal 0.246). This is **pre-existing**: HEAD's tree is identical to origin/main `5f165998` (`git diff --stat 5f165998 HEAD` is empty), and CI runs this tier with `--gates-mode report`. The plan's own checks (`.passed == true and .paired.all_zero == true`) hold. 06-45 cannot affect it: it changes only setup SQL, tests and AGENTS.md, and the harness's retrieval scores do not change with the fold. I recorded it here rather than loosening any threshold. It belongs to the Phase 4.1 / 7 false-refusal work.
4. **Plan 06-44 recorded FAIL** for D-42 (b) and (d) in `eval/reports/phase-06/comparison.md`. This plan does not reopen it. The plan's phase-close claim ("phase closes green") is limited to the gate chain with defaults off, which is green apart from item 3.

## Decisions for STATE

- Phase 6 migrations 0601-0603 are folded. The fold note in AGENTS.md now reads Phase 6 (0601-0603) folded.
- The absolute false-refusal (en) gate failure on the default fixture tier is pre-existing on main and report-only in CI.

## Operator actions

None. No live check is needed: the fold is proven by PGlite equality with the migrations.

## Deferred

- The full Node/DB suite result, if it was not yet final at the time of this commit (see note above).
