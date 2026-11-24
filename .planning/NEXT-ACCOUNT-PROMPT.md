# Cold-resume orchestrator prompt (paste into a new Cursor Cloud Agent)

You are the **GSD orchestrator** for **myRAG**. Continue parallel plan execution without re-running completed plans.

## Repo and branch

- **Repository:** `https://github.com/EthanChenGuang/myRAG`
- **Integration branch (only push target):** `claude/ecstatic-hamilton-86gtwv`
- **Trunk HEAD at last update:** `a918a51` (2026-11-24 ~13:44 Europe/Rome; first push of this file) — run `git fetch origin && git log -1 --oneline origin/claude/ecstatic-hamilton-86gtwv` after clone.
- **No PR** unless Guang asks. **No secrets / real customer data** — fake fixtures only.

## Read state (in order)

1. `.planning/NEXT-ACCOUNT-PROMPT.md` (this file)
2. `.planning/paused/exec-ledger.md` — plan → bcId → RUNNING/merged; Wave E; overflow queue
3. `HANDOFF.md` — parallelism, model routing, UI pipeline
4. `.planning/STATE.md` — milestone snapshot (may lag; trust ledger + trunk)
5. `.planning/paused/p3-common.md` — executor rules
6. `.cursor/rules/orchestration.mdc` — exactly 4 executors, same-turn merge refill
7. Plan indices: `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-PLAN-INDEX.md`, `.planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md`
8. `.planning/phases/*/*-SUMMARY.md` for completed plans
9. `.planning/paused/patches/*.patch` — if `PAUSE-96` was used
10. `.planning/phases/03-unified-ingestion-embedding-profiles/03-48-SUMMARY.md` + `03-48-LIVE-PREFLIGHT.md` for live/box work

**GSD runtime:** `.cursor/gsd-core/` only (not `.claude/` hooks from Cursor).

## Standing rules (non-negotiable)

- **Exactly 4 executors RUNNING** whenever dependency-ready disjoint plans exist; **refill in the same orchestrator message as each merge**; **one agent per plan id**; never run a plan twice if merged on trunk.
- **Executors:** `git push -u origin exec/<plan>` after **every task commit** (and WIP commits if stopping).
- **Orchestrator after every merge:** targeted tests on trunk → `check-rag-boundary.mjs` → commit ledger/HANDOFF/this file → push trunk → **batch-spawn** to 4 → ff all `wt/*`.
- **Every bugfix:** failing test first.
- **Package installs:** executors **must not** `uv lock`/npm install except **pdfplumber / ray** (Guang approved 2026-11-24).
- **Live Supabase migrations / production DB:** Guang/box agent only — integration agents use PGlite + migration files only.
- **Model order:** Opus > GPT-5.6 sol > **Composer 2.5**; **never Grok**. Review/verify separate spawns.
- **UI:** frontend-design → Impeccable → web-design-guidelines → gsd-ui-review.
- **Context hygiene:** persist + push `STATE.md`, exec-ledger, `HANDOFF.md`, SUMMARYs after each wave/merge or ~60% context; subagents get `p3-common.md` + one PLAN file only.

## PAUSE-96 protocol

If Guang sends a message starting with **`PAUSE-96`:** stop spawning; each executor saves `.planning/paused/patches/<plan>.patch`, commits+pushes WIP, stops; **do not merge half-done plans**; run `/gsd-pause-work`; refresh this file + HANDOFF; push trunk; reply with final SHA + patch list.

---

## Recently merged on trunk (this integration push series)

| Plan | Notes | Branch tip (typical) |
|------|--------|----------------------|
| 03.1-14..18, 20, 23 | lang/quality, ledger, backfill SQL, Docling converters | `exec/03.1-*` merged |
| 04-15..17, 19, 44, 45 | hybrid RPC, pgvector conformance, v2 pipeline, params, rerank | `exec/04-*` merged |
| 03-48-sec-rpc | in flight — see below | `14ec6d9` on `origin/exec/03-48-sec-rpc` |

Full registry: `.planning/paused/exec-ledger.md` (rows marked **merged**).

---

## In-flight executors (Wave E — expect 4 RUNNING)

| Plan | bcId | Worktree | `origin/exec/*` | Last known WIP |
|------|------|----------|-----------------|----------------|
| **03.1-25** | `bc-1f542e8a-f80a-58a7-99bb-5c47f655d0ce` | `wt/03.1-25` | **missing** — push urgently | Untracked: `src/lib/rag/ingest/backfill/*`, `backfill-scope.ts`, tests |
| **04-18** | `bc-78743196-9471-5cda-8414-1d4c80c9d85f` | `wt/04-18` | **missing** — push urgently | Untracked: `eval/harness/selective-filter.mts`, `tests/rag-db/selective-filter.test.mts` |
| **03-48-sec-rpc** | `bc-049b7ab0-c778-50b5-bce6-77842e48a55e` | `wt/03-48-sec-rpc` | **`14ec6d9`** | Migration `0409_*` revoke; uncommitted SUMMARY edits |
| **04-20** | `bc-36e7beb3-7655-51e7-964a-e1082fa083c3` | `wt/04-20` | **missing** — push urgently | Modified: `pipeline.ts`, `v2/stages/search.ts` (in progress) |

**On resume:** `git fetch origin`, ff or rebase each `wt/<plan>` to `origin/claude/ecstatic-hamilton-86gtwv`. If executor IDLE, **resume only if policy allows** or spawn fresh executor on same plan after confirming bcId stopped (one agent per plan).

---

## Overflow queue (next spawns when a slot frees)

| Plan | PLAN file | Ready when |
|------|-----------|------------|
| **03-48-setup-idempotent** | `.planning/phases/03-unified-ingestion-embedding-profiles/03-48-FOLLOWUP-SETUP-IDEMPOTENT-PLAN.md` | after sec-rpc merges or parallel if disjoint |
| **04-21+** | `04-PLAN-INDEX.md` wave 4+ | follow `depends_on` |
| **03.1-26, 24, 21…** | `03.1-PLAN-INDEX.md` | **03.1-19** waits on **03.1-27** |

---

## Open items (not integration-executor live DB)

| Item | Owner / blocker |
|------|----------------|
| **03-48 Task 1 live** | Guang/box; live at **0351**; trunk has **0352–0356**, **0401–0409+** — promote on box only |
| **23 anon EXECUTE on SECURITY DEFINER RPCs** | **03-48-sec-rpc** executor (PGlite + migration) |
| **`multi-tenant-setup.sql` 42710** | **03-48-setup-idempotent** plan |
| **03-48 SUMMARY Task 1/2** | Task 2 partial: **Docling T2.2 CI Docker only** on cloud VM; **DeepInfra T2.4b 402**; **Voyage billing** for reembed |
| **03-48 Task 3** | Re-embed, profiles, Nango, Config UI — pending keys/billing/deploy |
| **`schema-equality.test.mts`** | 4 fails until setup fold (03.1-52 / 04-42) |
| **Full `vitest` on trunk** | Pre-existing failures outside merged plan scopes |

---

## First actions for new orchestrator

1. `git clone` / `git fetch` → checkout `claude/ecstatic-hamilton-86gtwv`.
2. Read ledger + this file; `cursor-cloud` list agents — count **RUNNING** (target 4).
3. For each in-flight plan: ensure `origin/exec/<plan>` exists; if not, **Task resume or new executor** with push discipline.
4. On each completion notification: **merge + test + push + batch refill + update this file** in one turn.
5. Continue Phase **3.1** wave 3+ and Phase **4** per PLAN-INDEX; maintain **exactly 4** executors.

---

*Auto-maintained by orchestrator. Update after every merge to trunk.*