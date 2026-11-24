# Executor ledger (one executor per plan)

**Rule (Guang):** At most one **executor** subagent per plan id. Parallelism is across **different** plans with **disjoint** `files_modified`. Review/verify agents are separate roles and may run in parallel with executors.

## Remaining plans (execution queue)

| Phase | Plans left | Notes |
|-------|------------|-------|
| **3** | **03-47** (in flight), **03-48** | 03-48 Guang live only — no executor |
| **3.1** | **03.1-01 … 03.1-55** | 54 automated + 03.1-53/54 human; start after 03-47 merges (policy) but wave-1 file-disjoint plans may run **in parallel with 03-47** |
| **4** | **04-01 … 04-45** | Index: 14 waves; Phase 3 complete required — **04-01+ may start in worktrees** on trunk after 03-46 merge |

ROADMAP checkboxes for 03-01..03-37 are stale (implemented); trust SUMMARY + trunk.

## Active wave A (now) — up to 4 concurrent executors

| Slot | Plan | Worktree / branch | Subagent | Overlap rationale |
|------|------|-------------------|----------|-------------------|
| E0 | **03-47** | `wt/03-47` → `exec/03-47` | [bc-6d671721](bc-6d671721-c089-50a8-9012-53f242a64a1e) **RUNNING** | setup SQL + AGENTS — blocks other setup folds |
| E1 | **03.1-01** | `wt/03.1-01` → `exec/03.1-01` | [bc-287a3b2b](bc-287a3b2b-c427-5a49-900b-3e5a9e4a7afc) **RUNNING** | `0351_ingestion_schema.sql` only — **no** overlap with 03-47 |
| E2 | **03.1-02** | `wt/03.1-02` → `exec/03.1-02` | [bc-167b7120](bc-167b7120-83b6-508c-be23-d2b2d109ed27) **RUNNING** | contracts only — disjoint from E0/E1 |
| E3 | **04-01** | `wt/04-01` → `exec/04-01` | [bc-6e56c3c5](bc-6e56c3c5-3dbf-54db-9560-74ce13710279) **RUNNING** | `src/lib/rag/*` type files — disjoint from Phase 3 close |
| E4 | **04-03** | `wt/04-03` → `exec/04-03` | [bc-61b56d0b](bc-61b56d0b-2381-5356-8d68-b8224a022d56) **RUNNING** | tokenizer — disjoint; **not** 04-02 yet (config overlap with 03.1-03) |

**Serialized (why):**

| Plan | Waits on | Reason |
|------|----------|--------|
| **03.1-03** | **04-02** not running / merged | Shared: `scripts/init-env.js`, `src/lib/env.ts`, config UI, `check-config.mjs` |
| **04-02** | **03.1-03** complete preferred | Same config five-location files |
| **04-05, 04-06, 04-07** | Each other + after **04-05** first | Shared `createFixtureDatabase` / migration shim (per 04-PLAN-INDEX) |
| **03.1-52**, **04-42** | Prior waves | Fold migrations into setup — overlaps **03-47** files |
| **All 3.1** wave 2+ | Wave 1 merge to trunk | `depends_on` + ledger |

## Review / verify (parallel, not executors)

| Target | Role | Subagent | Status |
|--------|------|----------|--------|
| **03-46** merge on trunk | gsd-verifier + gates | (retry gpt-5.6) | Opus spawn failed: usage exceeded |
| **03-43..03-45** | code-review already done for 03-43 | bc-061a508f IDLE | optional |

## Plan registry (executor slots)

| Plan | Subagent (bcId) | Status | Branch |
|------|-----------------|--------|--------|
| 03-43 | bc-2d2764a8… | merged | exec/03-43 |
| 03-44 | bc-645e437f… | merged | exec/03-44 |
| 03-44 | bc-cdb95a3d, bc-9cd7df41 | **duplicate** | — |
| 03-45 | orchestrator | merged | trunk |
| 03-46 | bc-a7d242c2… | merged | exec/03-46 |
| 03-46 | bc-88f166a9 | **stale** | — |
| 03-47 | bc-6d671721… | **running** | exec/03-47 |
| 03.1-01 | bc-287a3b2b… | **running** | exec/03.1-01 |
| 03.1-02 | bc-167b7120… | **running** | exec/03.1-02 |
| 04-01 | bc-6e56c3c5… | **running** | exec/04-01 |
| 04-03 | bc-61b56d0b… | **running** | exec/04-03 |

## Remaining plan inventory (file-overlap basis)

| Phase | Automated plans | Skipped | Next waves (index) |
|-------|-----------------|---------|-------------------|
| 3 | **03-47** only | 03-48 (Guang live) | — |
| 3.1 | **03.1-01 … 03.1-55** (54 exec; 53/54 human) | — | [03.1-PLAN-INDEX.md](../phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-PLAN-INDEX.md) waves 1–14 |
| 4 | **04-01 … 04-45** | — | [04-PLAN-INDEX.md](../phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md) waves 1–14 |

**Wave 1 (3.1):** 03.1-01–06 — internally disjoint per index. **Do not** pair **03.1-03** with **04-02** (6 shared config paths; `src/lib/env.ts` not in overlap set but five-location sync still required).

**Wave 1 (4):** 04-01–04 **parallel**; **04-05 → 04-06 → 04-07** one executor tree (PGlite migration order).

**Concurrent spawn (2026-11-24 ~13:05 Europe/Rome):** 5 `Task` calls in one turn — **4 succeeded** (gsd-executor ×4), **1 failed** (gsd-verifier + `claude-opus-5-5-medium`: *user exceeded selected model’s available usage*). No platform limit on concurrent subagents observed.

## DUPLICATE EXECUTION (2026-11-24)

**03-44:** Three executors (bc-cdb95a3d, bc-9cd7df41, bc-645e437f). Canonical merge: bc-645e437f.

## Spawn checklist

1. Read **Active wave** and **Serialized** tables.
2. If plan already has `running`/`merged` executor → no second executor.
3. Create `wt/<plan>` + `exec/<plan>` if missing; base = `origin/claude/ecstatic-hamilton-86gtwv`.
4. Update registry row before `Task`; set `merged` after merge to trunk.