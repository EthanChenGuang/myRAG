# Claude Code orchestrator handoff (myRAG)

You are the **GSD orchestrator** for **myRAG**, resuming on **Claude Code** with GSD in **`.claude/`** (not Cursor hooks). Guang invoked **PAUSE-96**; Cursor agents are **stopped**.

## First command

Run **`/gsd-resume-work`** before spawning executors or merging.

## Repo and branch

- **Repository:** https://github.com/EthanChenGuang/myRAG
- **Integration branch (only push target):** `claude/ecstatic-hamilton-86gtwv`
- **Trunk (PAUSE-96 handoff pushed):** `363a5c8c429e13c1c78350dbe2841f72ebd8c4c5` (`363a5c8`) — confirm with `git fetch origin && git log -1 origin/claude/ecstatic-hamilton-86gtwv` (pre-handoff tip was `201b66b`)
- **No PR** unless Guang asks. **No secrets / real customer data** — fake fixtures only.

## Read order (mandatory)

1. `.planning/.continue-here.md` — pause snapshot
2. `.planning/HANDOFF.json` — machine-readable pause state
3. This file
4. `.planning/paused/exec-ledger.md` — merged vs RUNNING/STOPPED
5. `HANDOFF.md` — parallelism, model routing, UI pipeline, PAUSE-96
6. `.planning/STATE.md` — milestone snapshot (may lag; trust trunk + ledger)
7. `.planning/NEXT-ACCOUNT-PROMPT.md` — cold-resume rules (adapt for Claude Code: use `.claude/CLAUDE.md`, `.claude/skills/`)
8. `.planning/paused/patches/*.patch` — WIP at pause if you need to re-apply on a fresh worktree
9. Plan indices: `03.1-PLAN-INDEX.md`, `04-PLAN-INDEX.md`
10. `03-48-SUMMARY.md`, `03-48-LIVE-PREFLIGHT.md` for live/box-only work

**GSD runtime for Claude Code:** `.claude/gsd-core/` and `.claude/skills/` per `.claude/CLAUDE.md`.

## Standing rules (non-negotiable)

1. **Push only** to `claude/ecstatic-hamilton-86gtwv` for integration; executors use `exec/<plan>` and push after **every task commit** (and WIP commits).
2. **No PR** unless Guang asks.
3. **No secrets, real phone numbers, or customer data** — placeholders and fake data only.
4. **Every bugfix starts with a failing test** (TDD).
5. **After every merge:** run targeted tests + `node scripts/ci/check-rag-boundary.mjs` on trunk before push.
6. **Never run a plan twice** if its SUMMARY is merged on trunk (check exec-ledger).
7. **Parallel executors:** up to **4 RUNNING**, **one agent per plan id**, refill in the **same turn** as each merge (see orchestration rules).
8. **Live Supabase / production DB:** Guang/box agent only; integration agents use PGlite + migration files.
9. **Package installs:** executors must not `uv lock`/npm install except **pdfplumber / ray** (Guang approved 2026-11-24).
10. **Model order:** Opus > GPT-5.6 sol > Composer 2.5; **never Grok**. Review/verify = separate spawns.
11. **Context hygiene:** update ledger, HANDOFF, STATE, SUMMARYs after merges; subagents get one PLAN + `p3-common.md`.
12. Follow **`.claude/CLAUDE.md`** and **AGENTS.md** for product/RAG boundaries.

## PAUSE-96 outcome

- **No new spawns** at pause (including **03-48-sec-rpc-2**).
- **No half-merges.**
- Four in-flight plans: patches on trunk + WIP pushed to `origin/exec/*`.

## Recently merged on trunk (representative SHAs)

| Plan | Trunk merge / note | SHA (short) |
|------|-------------------|-------------|
| 03-48-sec-rpc | `0409_search_rpc_revoke.sql` | merge `cec95b3`; feature `14ec6d9`; exec tip `44c0573` |
| 03.1-23 | Docling presets/range converters | merge `f864fea` |
| 03.1-20 | TS client ledger | merge `201401b` |
| 03.1-18 | PGlite dedup | merged (see ledger) |
| 04-19 | v2 pipeline + tracer | merge `39f7209` |
| 04-44 | params + config hash | merge `e4db87b` |
| 04-45 | rerank text/select | merge docs `de5bbd8` follow-up |
| 04-15..17 | hybrid RPC, conformance | see `exec-ledger.md` |

Full registry: `.planning/paused/exec-ledger.md` rows marked **merged**.

## In-flight plans (STOPPED — resume via exec branch)

| Plan | exec branch | WIP commit | Patch on trunk | Resume |
|------|-------------|------------|----------------|--------|
| **03.1-25** | `exec/03.1-25` | **`423f649`** (IN_PROGRESS) | patch superseded | Resume executor on branch; backfill scope/sources/inventory — **no SUMMARY yet** |
| **04-18** | `exec/04-18` | **`b4a6b3c`** (COMPLETE) | patch superseded | **Merge on resume** — `eval/harness/selective-filter.mts`, 7 PGlite tests (RET-10) |
| **04-20** | `exec/04-20` | **`081224a`** (COMPLETE) | `.planning/paused/patches/04-20.patch` (superseded) | **Merge first on resume:** SUMMARY on branch; feats `11c0e0f`, docs `081224a` |
| **03-48-setup-idempotent** | `exec/03-48-setup-idempotent` | **`90635ae`** (COMPLETE) | patch superseded | **Merge on resume**; idempotency re-run tests pass; full `schema-equality` may still show unrelated relex RPC fails |

**Apply patch (if worktree dirty or missing):** from repo root, `git apply --check .planning/paused/patches/<plan>.patch` then `git apply` on the correct branch (patches were captured pre-WIP-commit; prefer checking out WIP commit).

**Cursor bcIds (ignore / assume stopped):** `bc-1f542e8a`, `bc-78743196`, `bc-36e7beb3`, `bc-b37c0b7a`; duplicate push agents `bc-8f62493e`, `bc-ca34e9a0`.

## Queue after resume

1. **03-48-sec-rpc-2** — first **new** plan when a slot frees (overflow). Plan: `.planning/phases/03-unified-ingestion-embedding-profiles/03-48-FOLLOWUP-SECURITY-RPC-2-PLAN.md`. Gate: `npx vitest run tests/rag/search-rpc-grants.test.ts` (inventory test **still fails** on trunk until this lands).
2. Finish the four in-flight plans above (merge when green; do not duplicate).
3. **04-21+**, **03.1-26+** per PLAN indices and `depends_on`.

## Open items / blockers

| Item | Status |
|------|--------|
| **SECURITY DEFINER inventory test** | `tests/rag/search-rpc-grants.test.ts` — **1 failing** (10 pass); fixed by **03-48-sec-rpc-2**, not noise |
| **multi-tenant-setup idempotency** | **03-48-setup-idempotent** WIP `d1c5821` |
| **Docling T2.2** | CI Docker only on cloud VM |
| **Live DB** | Guang/box; live at **0351**; trunk has **0352–0356**, **0401–0409+** — **not live** |
| **Voyage billing** | blocks re-embed |
| **DeepInfra balance (402)** | blocks T2.4b paths |
| **Vercel deploy** | production behind trunk migrations |
| **schema-equality.test.mts** | fails until setup fold + related plans |
| **Full vitest** | pre-existing failures outside plan scopes |

## Verification commands (trunk at pause)

```bash
node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts   # 2/2 pass (0409)
npx vitest run tests/rag/search-rpc-grants.test.ts                        # 1 fail — sec-rpc-2
node scripts/ci/check-rag-boundary.mjs
```

## Resume workflow (suggested)

1. `/gsd-resume-work`
2. `git fetch origin`
3. Fast-forward or recreate `wt/*` from `origin/exec/*` for the four in-flight plans
4. Spawn up to **4 executors** (finish in-flight first; slot free → **03-48-sec-rpc-2**)
5. On each merge: gates → ledger → HANDOFF → push trunk
6. Do **not** apply live Supabase from integration agents

## UI / frontend (if touching UI)

Pipeline: **gsd-ui-phase** → frontend-design → Impeccable → web-design-guidelines → **gsd-ui-review** → verify. See `HANDOFF.md` and `.claude/rules/frontend-design.mdc`.