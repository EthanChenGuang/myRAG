---
quick_id: 261127-lx5
slug: plan-07-lex05
status: complete
date: 2026-11-27
branch: exec/plan-07-lex05
base: origin/ci/merge-train-39
key-files:
  created:
    - .planning/phases/07-external-backends-release-defaults/07-53-PLAN.md
  modified:
    - .planning/phases/07-external-backends-release-defaults/07-PLAN-INDEX.md
    - .planning/phases/07-external-backends-release-defaults/07-31-PLAN.md
    - .planning/phases/07-external-backends-release-defaults/07-38-PLAN.md
    - .planning/phases/07-external-backends-release-defaults/07-51-PLAN.md
    - .planning/ROADMAP.md
---

# Quick 261127-lx5: Phase 7 plan for the LEX-05 adapter gap

Planning only; no product code changed.

## Why

Gap G3 of the Phase 4.4 verification (`04.4-VERIFICATION.md` on verify/04.4): `src/lib/rag/backend/weaviate/collection.ts` hard-codes BM25 k1 1.2 and b 0.75, the Qdrant adapter passes no BM25 parameter, and no Phase 7 plan carried the 04.4-14 hand-off. LEX-05 asks every backend to score with `config.v2.lexicalScoring.k1` and `.b`.

## What was written

- **New plan 07-53**, wave 7, 3 tasks, autonomous, requirements LEX-05 and RET-06.
- `depends_on`: 07-03, 07-07, 07-08, 07-09, 07-12, 07-13, 07-14, 07-16, 07-36, 04.4-08, 04.4-14. All are executed, so the plan can run now.
- A new plan, not an amendment: the only plans that cover adapter BM25 (07-07, 07-08) are already executed.
- Amended for LEX-05: 07-38 (`depends_on` + 07-53, file order), 07-31 (`depends_on` + 07-53, phase close), 07-51 (`depends_on` + 07-53 and one documentation must-have).
- 07-PLAN-INDEX: revision 5 section, wave 7 row, coverage rows, threat range (T-07-173 to T-07-177), checks. ROADMAP: Phase 7 is 53 plans (49 active), 07-53 listed.

## What plan 07-53 covers

| Requirement of the task | Where in the plan |
|---|---|
| Both adapters read `config.v2.lexicalScoring.k1/b` | Task 1: one helper `externalLexicalParams(config)`, no literal pair left in either adapter directory |
| Pair recorded in collection metadata; a change must be rebuilt, with a clear message | Task 1 (`lexical_bm25` field, ensure refuses), Task 2 (reads fall back to pgvector as `backend_not_ready`; message names `npm run rag:vector-sync -- rebuild-lexical --target <t> --confirm`; dry report without `--confirm`) |
| k1 = 1.5 parity on pgvector, Weaviate and Qdrant | Task 3: one fixture whose top order flips between k1 1.2 and 1.5, checked against the reference BM25 on all three backends |
| Switch off equals today | Under `ts_rank_cd` the default pair is used whatever the two variables say; snapshot tests of creation bodies and search requests; no config-hash edit |
| Tenant filtering not weakened | Parameters only on the lexical node through `qdrantScopedBatch`; `withTenant`, per-tenant IDF and the global-IDF refusal untouched; two-tenant parity case; canary and scoped-request suites must pass unedited |

## Planner resolutions for the owner to confirm

1. **Meaning of "off".** The effective mode decides: with `RAG_LEXICAL_SCORING=ts_rank_cd` Weaviate and Qdrant keep 1.2 and 0.75 even if `RAG_LEXICAL_BM25_K1` or `_B` is set. The 04.4-14 hand-off note would also allow reading the pair regardless of mode; that would change external ranking with the switch off.
2. **Qdrant and "must rebuild".** Weaviate binds the pair to the index, so a change means a rebuild. Qdrant is expected to take the pair per query (04.4 D-29); in that case nothing depends on the stored pair, so the plan refreshes the recorded pair with one log line and rebuilds nothing. If the pinned server binds the pair to the text index, Qdrant follows the Weaviate rule. The executor decides from the pinned client types and a probe, and records the branch.
3. **Strict parity.** If a real store orders the parity fixture differently from the reference at a 10% score margin, the plan stops and reports the scores instead of loosening the test.

## Checks

- `gsd-tools validate health`: 0 errors before and after (status `degraded` from the same 9 warnings; 13 info lines, the only change being Phase 7 plans without a summary 25 to 26).
- `gsd-tools query verify.plan-structure`: valid, no error for 07-53 (no warning), 07-31, 07-38, 07-51.
- `gsd-tools query frontmatter.validate --schema plan`: valid for 07-53.
- Dependency script: every dependency of 07-53 executed and in an earlier wave; no shared file inside wave 7; every plan sharing a file is ordered by a `depends_on` path; no cycle.

## Not done

- No product code, no PR, no force-push, nothing touched in production.
- `REQUIREMENTS.md` is unchanged: LEX-05 stays `Pending` (04.4 verification, recommendation 7).
