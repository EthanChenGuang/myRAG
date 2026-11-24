# Executor ledger (one executor per plan)

**Rule (Guang):** Keep **exactly 4 executors RUNNING** at all times; refill **in the same step as each merge** (batch `Task` spawns in one orchestrator message). At most one **executor** subagent per plan id. Parallelism is across **different** plans with **disjoint** `files_modified`. Review/verify agents are separate roles and may run in parallel with executors.

**Account switch (Guang 2026-11-24):** Maintained cold-resume doc `.planning/NEXT-ACCOUNT-PROMPT.md` on trunk; update after every merge. Executors **push after each task commit**. `PAUSE-96` → pause protocol in that file.

**Parallelism failure mode (2026-11-24):** Orchestrator handled completion notifications **one per turn** → only the latest `Task` was visible while 3 others stayed `RUNNING`; worktrees were **not ff’d** and **no `origin/exec/*` pushes** → looked like a single agent. Fix: verify `cursor-cloud` RUNNING count; batch refill; ff/rebase all `wt/*`; require push after each task commit.

## Remaining plans (execution queue)

| Phase | Plans left | Notes |
|-------|------------|-------|
| **3** | **03-48** only | 03-48 Guang live / secrets — preflight `03-48-LIVE-PREFLIGHT.md` |
| **3.1** | **03.1-01 … 03.1-55** | 54 automated + 03.1-53/54 human; start after 03-47 merges (policy) but wave-1 file-disjoint plans may run **in parallel with 03-47** |
| **4** | **04-01 … 04-45** | Index: 14 waves; Phase 3 complete required — **04-01+ may start in worktrees** on trunk after 03-46 merge |

ROADMAP checkboxes for 03-01..03-37 are stale (implemented); trust SUMMARY + trunk.

## Active wave A (now) — up to 4 concurrent executors

| Slot | Plan | Worktree / branch | Subagent | Overlap rationale |
|------|------|-------------------|----------|-------------------|
| E0 | **03-47** | `wt/03-47` → `exec/03-47` | [bc-6d671721](bc-6d671721-c089-50a8-9012-53f242a64a1e) **merged** | `84753a3` on trunk |
| E1 | **03.1-01** | `wt/03.1-01` → `exec/03.1-01` | bc-287a3b2b… **merged** | `0351_ingestion_schema.sql` |
| E2 | **03.1-02** | `wt/03.1-02` → `exec/03.1-02` | [bc-167b7120](bc-167b7120-83b6-508c-be23-d2b2d109ed27) **merged** | contracts only |
| E3 | **04-01** | `wt/04-01` → `exec/04-01` | bc-6e56c3c5… **merged** | `src/lib/rag/*` type files |
| E4 | **04-03** | `wt/04-03` → `exec/04-03` | bc-61b56d0b… **merged** | lexical v2 on trunk |

**Serialized (why):**

| Plan | Waits on | Reason |
|------|----------|--------|
| **03.1-03** | **04-02** not running / merged | Shared: `scripts/init-env.js`, `src/lib/env.ts`, config UI, `check-config.mjs` |
| **04-02** | **03.1-03** complete preferred | Same config five-location files |
| **04-05, 04-06, 04-07** | Each other + after **04-05** first | Shared `createFixtureDatabase` / migration shim (per 04-PLAN-INDEX) |
| **03.1-04** | **03-48** only for live verification narrative | Package gate **cleared** (`approved`); locks on trunk — executor task 3 |
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
| 03.1-01 | bc-287a3b2b… | **merged** | exec/03.1-01 |
| 03.1-02 | bc-167b7120… | **merged** | exec/03.1-02 |
| 04-01 | bc-6e56c3c5… | **merged** | exec/04-01 |
| 04-03 | bc-61b56d0b… | **merged** | exec/04-03 |
| 04-04 | bc-66bbcf6a… | **merged** | exec/04-04 |
| 03.1-05 | bc-94d16ba7… | **merged** | exec/03.1-05 |
| 03.1-06 | bc-cf431776… | **merged** | exec/03.1-06 |
| 03.1-04 | bc-4969184f… | **merged** | exec/03.1-04 |
| 03.1-07 | — | **merged** | exec/03.1-07 |
| 04-05 | bc-91985997… | **merged** | exec/04-05 |
| 04-06 | [bc-f05b8cec](bc-f05b8cec-070a-54b4-a156-96d6167bdbb7) **merged** | exec/04-06; smoke `eval/out/p4-06` PASS |
| 03.1-08 | [bc-97f53a60](bc-97f53a60-1976-53e8-a0e4-10113dc0a4bb) **merged** | exec/03.1-08 — 28 PGlite tests pass on trunk |
| 04-07 | [bc-b39f21bf](bc-b39f21bf-71db-54ba-81d3-327871eb3a63) **merged** | exec/04-07 — 0403–0406; smoke eval/out/p4-07 |
| 03.1-03 | [bc-c5cb9fe1](bc-c5cb9fe1-91ef-5ec1-80f3-480362bbb755) **merged** | exec/03.1-03 — 12 switches, check-config manifest |
| 03.1-09 | [bc-2d791368](bc-2d791368-dff2-51b6-b84c-3678f8e3ed4c) **merged** | exec/03.1-09 — 32 PGlite tests |
| 03.1-10 | [bc-662f8704](bc-662f8704-0693-5e51-9771-f8aaaf281623) **merged** | exec/03.1-10 — 7 PGlite tests |
| 04-08 | [bc-b8d286f0](bc-b8d286f0-f82f-5d7d-b33e-a945526384a1) **merged** | exec/04-08 — vitest 56 pass on trunk |
| 03.1-11 | [bc-b18bbe3f](bc-b18bbe3f-b7f9-57e3-8d19-200f419a1891) **merged** | exec/03.1-11 — routing JSON + loaders |
| 04-09 | [bc-d7fa6093](bc-d7fa6093-307f-5298-8249-06913c219f67) **merged** | exec/04-09 — vitest 12 pass |
| 04-10 | [bc-ea9f7b6f](bc-ea9f7b6f-dc74-5d17-9573-573c0d79ab57) **merged** | exec/04-10 — vitest 50 + fixture-edge |
| 04-02 | [bc-5a4f4e08](bc-5a4f4e08-1575-5ed0-a16f-35d23901bcfd) **merged** | exec/04-02 — 122 manifest vars |
| 03.1-12 | [bc-6699e991](bc-6699e991-7801-5751-be34-7d73844505c5) **merged** | exec/03.1-12 — pytest 14 |
| 04-07 | [bc-b39f21bf](bc-b39f21bf-71db-54ba-81d3-327871eb3a63) **merged** | exec/04-07 |
| 04-11 | [bc-ff29f720](bc-ff29f720-c984-5a3b-82e5-ff26dea712ca) **merged** | exec/04-11 — fusion vitest 10 |
| 04-12 | [bc-7e4cdf1c](bc-7e4cdf1c-68e8-51f1-92c1-f1c5b1bb0abc) **merged** | exec/04-12 — context 31 tests |
| 03.1-12 | [bc-6699e991](bc-6699e991-7801-5751-be34-7d73844505c5) **merged** | exec/03.1-12 |
| 03.1-13 | [bc-e72d1c49](bc-e72d1c49-cec3-59a1-ad07-7c158b89a381) **merged** | exec/03.1-13 — parse fixtures 12 pass |
| 04-02 | [bc-5a4f4e08](bc-5a4f4e08-1575-5ed0-a16f-35d23901bcfd) **merged** | exec/04-02 |
| 04-13 | [bc-1df13648](bc-1df13648-cd9d-57fe-b726-181165f7ff56) **merged** | exec/04-13 — refusal 21 pass |
| 04-11 | [bc-ff29f720](bc-ff29f720-c984-5a3b-82e5-ff26dea712ca) **merged** | exec/04-11 |
| 04-14 | [bc-136b100d](bc-136b100d-6b2f-51bc-b0da-cf8849a609c2) **merged** | exec/04-14 — query 16 pass |
| 04-13 | [bc-1df13648](bc-1df13648-cd9d-57fe-b726-181165f7ff56) **merged** | exec/04-13 |
| 04-15 | [bc-2f4f0524](bc-2f4f0524-6984-5e57-a50a-249d0a960a27) **merged** | exec/04-15 — hybrid 35 pass |
| 04-12 | [bc-7e4cdf1c](bc-7e4cdf1c-68e8-51f1-92c1-f1c5b1bb0abc) **merged** | exec/04-12 |
| 04-16 | [bc-d3b679cb](bc-d3b679cb-baac-50ce-8ff9-c0829a4fb24f) **merged** | exec/04-16 — relex 9+8 tests |
| 04-14 | [bc-136b100d](bc-136b100d-6b2f-51bc-b0da-cf8849a609c2) **merged** | exec/04-14 |
| 03.1-14 | [bc-6ed38246](bc-6ed38246-5368-58ee-9409-cafed132af21) **merged** | exec/03.1-14 — vitest 34, pytest 50 |
| 03.1-13 | [bc-e72d1c49](bc-e72d1c49-cec3-59a1-ad07-7c158b89a381) **merged** | exec/03.1-13 |
| 03.1-15 | [bc-7064801d](bc-7064801d-6459-56da-b3bf-9ee5be726931) **merged** | exec/03.1-15 — pytest 31 |
| 03.1-16 | [bc-572eafe6](bc-572eafe6-375e-5fac-b690-23e40f4403cd) **merged** | exec/03.1-16 — pytest 17 |
| 03.1-17 | [bc-d27c0a4b](bc-d27c0a4b-accb-54b2-a27a-29c7aa443e15) **merged** | exec/03.1-17 — pytest 19 |
| 04-16 | [bc-d3b679cb](bc-d3b679cb-baac-50ce-8ff9-c0829a4fb24f) **merged** | exec/04-16 |
| 03.1-18 | [bc-34cb4e3b](bc-34cb4e3b-b843-5ba6-94da-c58cb5093dc2) **merged** | exec/03.1-18 — vitest 14 + PGlite 6 |
| 04-17 | [bc-c1e4ed28](bc-c1e4ed28-8308-557d-a69c-46ed9166e777) **merged** | exec/04-17 — conformance 42 |
| 04-15 | [bc-2f4f0524](bc-2f4f0524-6984-5e57-a50a-249d0a960a27) **merged** | exec/04-15 |
| 04-18 | [bc-78743196](bc-78743196-9471-5cda-8414-1d4c80c9d85f) **merged** trunk `a064d99` (Claude Code resume) | `origin/exec/04-18` @ `b4a6b3c` |
| 03.1-20 | [bc-7530e5d1](bc-7530e5d1-02b0-5c59-bf06-0bd96367216e) **merged** | exec/03.1-20 — PGlite 13 |
| 03.1-23 | [bc-ab1e9b2d](bc-ab1e9b2d-301d-50ad-85d3-54b3af5e3261) **merged** | exec/03.1-23 |
| 04-44 | [bc-e6e2bd84](bc-e6e2bd84-1486-5c1d-b545-6f44a20de765) **merged** | exec/04-44 — params-hash 15 |
| 03.1-25 | [bc-1f542e8a](bc-1f542e8a-f80a-58a7-99bb-5c47f655d0ce) **merged** trunk `feb9555` (Cursor) then superseded by Claude executor `d544c36` | `origin/exec/03.1-25` @ `494d60a` |
| 04-19 | [bc-eafdad13](bc-eafdad13-4e57-5750-a00f-8bc029517ee2) **merged** | exec/04-19 — tracer 6 + vitest 18 |
| 04-45 | [bc-32843230](bc-32843230-3c15-53cb-be49-93f84da0a3bb) **merged** | exec/04-45 — vitest 13 |
| 03-48-sec-rpc | [bc-049b7ab0](bc-049b7ab0-c778-50b5-bce6-77842e48a55e) **merged** | exec/03-48-sec-rpc — PGlite 2/2 |
| 04-20 | [bc-36e7beb3](bc-36e7beb3-7655-51e7-964a-e1082fa083c3) **merged** trunk `6418feb` (Claude Code resume) | `origin/exec/04-20` @ `081224a` |
| 03-48-setup-idempotent | [bc-b37c0b7a](bc-b37c0b7a-eb5e-51b0-83b2-b0e870bb6318) **merged** trunk `da1ed63` (Claude Code resume) | `origin/exec/03-48-setup-idempotent` @ `90635ae` |

## Remaining plan inventory (file-overlap basis)

| Phase | Automated plans | Skipped | Next waves (index) |
|-------|-----------------|---------|-------------------|
| 3 | **03-47** only | 03-48 (Guang live) | — |
| 3.1 | **03.1-01 … 03.1-55** (54 exec; 53/54 human) | — | [03.1-PLAN-INDEX.md](../phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-PLAN-INDEX.md) waves 1–14 |
| 4 | **04-01 … 04-45** | — | [04-PLAN-INDEX.md](../phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md) waves 1–14 |

**Wave 1 (3.1):** 03.1-01–06 — internally disjoint per index. **Do not** pair **03.1-03** with **04-02** (6 shared config paths; `src/lib/env.ts` not in overlap set but five-location sync still required).

**Wave 1 (4):** 04-01–04 **parallel**; **04-05 → 04-06 → 04-07** one executor tree (PGlite migration order).

## Wave F — Claude Code (2026-11-24, base `7a9b96f`; Guang: up to 9 parallel agents)

| Plan | Worktree / branch | Status |
|------|-------------------|--------|
| 03.1-19 | `wt/03.1-19` / `exec/03.1-19` | **RUNNING** (gsd-executor) |
| 04-21 | `wt/04-21` / `exec/04-21` | **RUNNING** (gsd-executor) |
| 04-22 | `wt/04-22` / `exec/04-22` | **RUNNING** (gsd-executor) |
| 03.1-24 | `wt/03.1-24` / `exec/03.1-24` | **RUNNING** (gsd-executor) |
| 03.1-26 | `wt/03.1-26` / `exec/03.1-26` | **RUNNING** (gsd-executor) |
| 04-31 | `wt/04-31` / `exec/04-31` | **RUNNING** (gsd-executor) |

## Wave E — **PAUSE-96 STOPPED** (2026-11-24 ~13:48 Europe/Rome; Claude Code resumes)

All four executors **stopped**; WIP on `origin/exec/*` + patches in `.planning/paused/patches/`. **Do not spawn** until `/gsd-resume-work`. See `.planning/CLAUDE-CODE-HANDOFF-PROMPT.md`.

## Wave E snapshot at pause (was **4 RUNNING**)

| Plan | bcId | Cloud | Worktree | WIP signal |
|------|------|-------|----------|------------|
| 03.1-23 | [bc-ab1e9b2d](bc-ab1e9b2d-301d-50ad-85d3-54b3af5e3261) | **merged** | — | pytest 67 |
| 03-48-setup-idempotent | [bc-b37c0b7a](bc-b37c0b7a-eb5e-51b0-83b2-b0e870bb6318) | **merged** | `wt/03-48-setup-idempotent` | **merge-ready** `90635ae`; idempotency tests pass; note residual `schema-equality` relex RPC failures on merge |
| 03.1-25 | [bc-1f542e8a](bc-1f542e8a-f80a-58a7-99bb-5c47f655d0ce) | **merged** | `wt/03.1-25` | **merge-ready** `494d60a` (DATA-16); run backfill vitest on merge; full vitest may need larger worker (listSource OOM note) |
| 04-18 | [bc-78743196](bc-78743196-9471-5cda-8414-1d4c80c9d85f) | **merged** | `wt/04-18` | **merge-ready** `b4a6b3c` (RET-10 harness; 7 PGlite tests) |
| 04-20 | [bc-36e7beb3](bc-36e7beb3-7655-51e7-964a-e1082fa083c3) | **merged** | `wt/04-20` | **merge-ready** `081224a` (`11c0e0f` feat + SUMMARY); supersedes pause WIP `b5e47fe` — **do not merge until resume** |

**Overflow queue (spawn next free slot, same turn as merge):**

| Plan | Worktree ready | Notes |
|------|----------------|-------|
| **03-48-setup-idempotent** | `wt/03-48-setup-idempotent` | **merged** `da1ed63` |
| **03-48-sec-rpc-2** | `wt/03-48-sec-rpc-2` | **merged** `7ea728a` (0410 + 0409 single-tenant guard; 109 signatures locked); [03-48-FOLLOWUP-SECURITY-RPC-2-PLAN.md](../phases/03-unified-ingestion-embedding-profiles/03-48-FOLLOWUP-SECURITY-RPC-2-PLAN.md) — full DEFINER inventory (live 23); `tests/rag/search-rpc-grants.test.ts` must pass |

**03-48 follow-ups (one executor per plan when a slot frees — do not duplicate running work):**

| Plan id | PLAN file | Priority |
|---------|-----------|----------|
| `03-48-sec-rpc` | [03-48-FOLLOWUP-SECURITY-RPC-PLAN.md](../phases/03-unified-ingestion-embedding-profiles/03-48-FOLLOWUP-SECURITY-RPC-PLAN.md) | **merged** — four search RPCs (`0409`) |
| `03-48-sec-rpc-2` | [03-48-FOLLOWUP-SECURITY-RPC-2-PLAN.md](../phases/03-unified-ingestion-embedding-profiles/03-48-FOLLOWUP-SECURITY-RPC-2-PLAN.md) | **merged** `7ea728a` |
| `03-48-setup-idempotent` | [03-48-FOLLOWUP-SETUP-IDEMPOTENT-PLAN.md](../phases/03-unified-ingestion-embedding-profiles/03-48-FOLLOWUP-SETUP-IDEMPOTENT-PLAN.md) | 42710 on re-run setup |

**03-48 live Supabase:** Guang/box agent only for production DB; Task 1 logged in `03-48-SUMMARY.md`.

**Recently merged (no follow-up merge needed):** [03.1-04 Task 3](bc-4969184f-7107-55b3-a450-d63435dcb0a0), [03.1-07](bc-4a221b6f-f6a6-507b-8da0-d497c6662c2a), [04-05](bc-91985997-25a1-5b37-a987-32cb579c4746) → trunk `7d98d53`…`a06efce`.

**04-05 smoke (orchestrator):** `npm run test-rag -- --out eval/out/p4-05` → `gate.json` `passed: true`, `paired.all_zero: true` (uv on VM).

**Concurrent spawn (2026-11-24 ~13:05 Europe/Rome):** 5 `Task` calls in one turn — **4 succeeded** (gsd-executor ×4), **1 failed** (gsd-verifier + `claude-opus-5-5-medium`: *user exceeded selected model’s available usage*). No platform limit on concurrent subagents observed.

## Package legitimacy (03.1-04)

| Package | Pin | Lock commit (trunk) |
|---------|-----|---------------------|
| pdfplumber | 0.11.11 | `3e83978` |
| pdfminer-six | 20260107 | (transitive in uv.lock) |
| ray[data] | 2.60.1 | optional extra in pyproject |
| pypdfium2 | 5.15.2 | preflight extra |

Guang approval: **批准安装** → `approved` (2026-11-24 Europe/Rome). Orchestrator owns Task 2 lock; executor **must not** `uv lock`/install.

## DUPLICATE EXECUTION (2026-11-24)

**03-44:** Three executors (bc-cdb95a3d, bc-9cd7df41, bc-645e437f). Canonical merge: bc-645e437f.

**03.1-25:** Two executors (Cursor bc-1f542e8a → `494d60a`; Claude Code pre-/clear executor → `c8d0b6f`), both from WIP `7c5f7f8`. Merged Cursor first (`feb9555`), then the Claude version (`d544c36`), which passes the Cursor tests and adds SSRF/symlink/bucket hardening. Canonical: `d544c36`. Deferred from its SUMMARY: folder upload to `rag-originals` belongs to **03.1-46**; generated Zod lacks the path/url cross-field rule (`tests/ingest-queue-contracts.test.ts`, 03.1-02).

**03-48-sec-rpc-2:** A pre-/clear Claude Code executor and this session's executor shared `wt/03-48-sec-rpc-2`. The first stopped editing once it saw the second's commits and only reviewed. One set of commits (`17f5b29`, `0a6db8a`, `48cbf62`), merged as `7ea728a`. No duplicate code.

## Spawn checklist

1. Read **Active wave** and **Serialized** tables.
2. If plan already has `running`/`merged` executor → no second executor.
3. Create `wt/<plan>` + `exec/<plan>` if missing; base = `origin/claude/ecstatic-hamilton-86gtwv`.
4. Update registry row before `Task`; set `merged` after merge to trunk; **same run** refill to 4 executors (see §2 merge refill in `orchestration.mdc`).