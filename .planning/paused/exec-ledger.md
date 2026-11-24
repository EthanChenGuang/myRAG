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
| E0 | **03-47** | `wt/03-47` → `exec/03-47` | [bc-6d671721](bc-6d671721-c089-50a8-9012-53f242a64a1e) **merged** | `84753a3` on trunk |
| E1 | **03.1-01** | `wt/03.1-01` → `exec/03.1-01` | [bc-287a3b2b](bc-287a3b2b-c427-5a49-900b-3e5a9e4a7afc) **RUNNING** | `0351_ingestion_schema.sql` only — **no** overlap with 03-47 |
| E2 | **03.1-02** | `wt/03.1-02` → `exec/03.1-02` | [bc-167b7120](bc-167b7120-83b6-508c-be23-d2b2d109ed27) **merged** | contracts only |
| E3 | **04-01** | `wt/04-01` → `exec/04-01` | bc-6e56c3c5… **merged** | `src/lib/rag/*` type files |
| E4 | **04-03** | `wt/04-03` → `exec/04-03` | [bc-61b56d0b](bc-61b56d0b-2381-5356-8d68-b8224a022d56) **RUNNING** | tokenizer — disjoint; **not** 04-02 yet (config overlap with 03.1-03) |

**Serialized (why):**

| Plan | Waits on | Reason |
|------|----------|--------|
| **03.1-03** | **04-02** not running / merged | Shared: `scripts/init-env.js`, `src/lib/env.ts`, config UI, `check-config.mjs` |
| **04-02** | **03.1-03** complete preferred | Same config five-location files |
| **04-05, 04-06, 04-07** | Each other + after **04-05** first | Shared `createFixtureDatabase` / migration shim (per 04-PLAN-INDEX) |
| **03.1-04** | **03-48** SUMMARY + Guang `approved` | Package-legitimacy gate (pdfplumber / ray); executor idle at task 0 |
| **03.1-52**, **04-42** | Prior waves | Fold migrations into setup — overlaps **03-47** files |
| **All 3.1** wave 2+ | Wave 1 merge to trunk | `depends_on` + ledger |

## Review / verify (parallel, not executors)

| Target | Role | Subagent | Status |
|--------|------|----------|--------|
| **03-46** merge on trunk | gsd-verifier + gates | [bc-834d683b](bc-834d683b-cd64-560c-936d-eba3fe025afc) **done** (`human_needed` 4/5) | `03-46-VERIFICATION.md`; e2e harness = Guang/manual |
| **03-43..03-45** | code-review already done for 03-43 | bc-061a508f IDLE | optional |

## Plan registry (executor slots)

| Plan | Subagent (bcId) | Status | Branch |
|------|-----------------|--------|--------|
| 03-43 | bc-2d2764a8… | merged | exec/03-43 |
| 03-44 | bc-645e437f… | merged | exec/03-44 |
| 03-44 | bc-cdb95a3d, bc-9cd7df41 | **duplicate** | — |
| 03-45 | orchestrator | merged | trunk |
| 03-46 | bc-a7d242c2… | merged | exec/03-46 |
| 03-46 | [bc-88f166a9](bc-88f166a9-cbf1-5906-851a-88b7b561593a) | **superseded** (finished after merge; `origin/exec/03-46` = `de688e9`, trunk `883927b`) | no executor |
| 03-47 | bc-6d671721… | **merged** | exec/03-47 |
| 03.1-01 | bc-287a3b2b… | **running** | exec/03.1-01 |
| 03.1-02 | bc-167b7120… | **merged** | exec/03.1-02 |
| 04-01 | bc-6e56c3c5… | **merged** | exec/04-01 |
| 04-03 | bc-61b56d0b… | **running** | exec/04-03 |
| 04-04 | bc-66bbcf6a… | **merged** | exec/04-04 |
| 03.1-05 | bc-94d16ba7… | **running** | exec/03.1-05 |
| 03.1-06 | bc-cf431776… | **running** | exec/03.1-06 |

## Remaining plan inventory (file-overlap basis)

| Phase | Automated plans | Skipped | Next waves (index) |
|-------|-----------------|---------|-------------------|
| 3 | **03-47** only | 03-48 (Guang live) | — |
| 3.1 | **03.1-01 … 03.1-55** (54 exec; 53/54 human) | — | [03.1-PLAN-INDEX.md](../phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-PLAN-INDEX.md) waves 1–14 |
| 4 | **04-01 … 04-45** | — | [04-PLAN-INDEX.md](../phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md) waves 1–14 |

**Wave 1 (3.1):** 03.1-01–06 — internally disjoint per index. **Do not** pair **03.1-03** with **04-02** (6 shared config paths; `src/lib/env.ts` not in overlap set but five-location sync still required).

**Wave 1 (4):** 04-01–04 **parallel**; **04-05 → 04-06 → 04-07** one executor tree (PGlite migration order).

## Wave B (spawned)

| Plan | bcId | Worktree |
|------|------|----------|
| 03.1-04 | [bc-4969184f](bc-4969184f-7107-55b3-a450-d63435dcb0a0) **blocked** (human) | wt/03.1-04 — needs `03-48-SUMMARY.md` + package approval (`approved` / `approved ray 2.60.0`) |
| 04-04 | [bc-66bbcf6a](bc-66bbcf6a-fea9-522c-9d57-3ef3695ca16a) **merged** | trunk `55fb76f` |
| 03.1-05 | [bc-94d16ba7](bc-94d16ba7-3968-5075-9a7b-d09e071ca6e4) RUNNING | wt/03.1-05 |
| 03.1-06 | [bc-cf431776](bc-cf431776-961d-5942-b066-822c3bec106b) RUNNING | wt/03.1-06 |

## Wave C (queued — spawn when Active wave &lt; 4 executors)

| Plan | Worktree | Blocked by |
|------|----------|------------|
| 03.1-05 | `wt/03.1-05` ready | concurrency cap (not 03.1-04) |
| 03.1-06 | `wt/03.1-06` ready | concurrency cap |

**Concurrent spawn (2026-11-24 ~13:05 Europe/Rome):** 5 `Task` calls in one turn — **4 succeeded** (gsd-executor ×4), **1 failed** (gsd-verifier + `claude-opus-5-5-medium`: *user exceeded selected model’s available usage*). No platform limit on concurrent subagents observed.

## DUPLICATE EXECUTION (2026-11-24)

**03-44:** Three executors (bc-cdb95a3d, bc-9cd7df41, bc-645e437f). Canonical merge: bc-645e437f.

## Spawn checklist

1. Read **Active wave** and **Serialized** tables.
2. If plan already has `running`/`merged` executor → no second executor.
3. Create `wt/<plan>` + `exec/<plan>` if missing; base = `origin/claude/ecstatic-hamilton-86gtwv`.
4. Update registry row before `Task`; set `merged` after merge to trunk.