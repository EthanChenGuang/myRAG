# HANDOFF — Trunk merge train pause (Claude Code takeover)

**Branch:** `claude/ecstatic-hamilton-86gtwv` (push only; no PR)  
**Trunk HEAD:** see git log (paused 2026-11-25, handoff in .planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/.continue-here.md)  
**Resume:** `/gsd-resume-work` + `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/.continue-here.md`

## Merge train status (stopped)

Cursor **killed** `tmux merge-train`. **#15** was mid-gate and was **not** merged. Local trunk **matches** `origin` (no dangling unpushed merges).

### Merged to trunk (with SHAs)

| PR | Plan | Merge SHA |
|----|------|-----------|
| #10 | bisect-ingest | `778f460b2477e2f5591c353ad505af95491c2859` |
| #9 | 03.1-27 | `cfeffab4b4443f5897f878f095968b98ebcb40b3` |
| #4 | 03.1-28 | `ea1fd7c02de34dac34679c40b40306ad8b3bcfe9` |
| #5 | 03.1-33 | `56b0349d6307b757e4df1eab897878f11e4b8d81` |

Each passed local gate with **no new failures vs baseline** (17 PASS / 1 FAIL `ts-typecheck-new` / 1 SKIP `docker-build`).

### Pre-gate agents (stopped; trunk merged, gates **not** run)

All agents below were **stopped** before local gates. Each **merged trunk `56b0349d` into its PR branch and pushed** — treat as **unverified** until full `local-pr-smoke` + compare vs baseline.

| PR | Branch | Tip after trunk merge | Gate |
|----|--------|------------------------|------|
| #20 | `exec/03.1-37` | `9a4095e1` | not run |
| #16 | `exec/03.1-32` | `d38c0bd7` | not run |
| #15 | `exec/04-29` | `c6d086d9` | not run |
| #21 | `exec/03.1-30` | `c5a077f1` | not run |
| #18 | `exec/03.1-29` | `fd6c75eb` | not run |
| #12 | `exec/03.1-35` | `78ad6123` | not run |
| #7 | `exec/03.1-55` | `f61eaed7` | not run |
| #11 | `exec/04-28` | `14a7abf0` | not run |
| #8 | `exec/03.1-36` | `2378f6a2` | not run |

**Unchanged on origin (no new trunk merge push recorded):** **#6** `exec/03.1-34`, **#19** `exec/03.1-39`, **#22** `exec/queue-hardening` @ `c62e93c1` (zero new failures vs its base per fix-up run; merge only after **#7** on trunk).

**BLOCKER — #17** `exec/03.1-31` @ `4dd3d98e`: **git conflict markers committed** in `src/lib/rag/index.ts`. Fix on branch before any merge; then full gate + union export review.

### Remaining queue + last gate state (merge train)

| PR | Branch | Status | Notes |
|----|--------|--------|-------|
| #6 | `exec/03.1-34` | unverified | Trunk merge not in pre-gate batch — runner had `HANDOFF.md` conflict |
| #12 | `exec/03.1-35` | unverified | Tip `78ad6123` (trunk merged; gate not run) |
| #8 | `exec/03.1-36` | unverified | Tip `2378f6a2` |
| #7 | `exec/03.1-55` | unverified | Tip `f61eaed7` (**blocks wave 6 + #22**) |
| #11 | `exec/04-28` | unverified | Tip `14a7abf0`; runner also saw rag-db `match_chunks_by_profile` fail pre-merge |
| #15 | `exec/04-29` | unverified | Tip `c6d086d9` |
| #13 | `exec/04-37` | pending | — |
| #18,#21,#17,#16,#20,#19 | wave‑6 | unverified / blocked | Tips: #18 `fd6c75eb`, #21 `c5a077f1`, #16 `d38c0bd7`, #20 `9a4095e1`; **#17 blocked**; **#19** unchanged |
| #22 | `exec/queue-hardening` | pending after #7 | `c62e93c1`, **0420–0423**, ingest recall ≥ 0.6195 |

### CI / gates

- **GitHub Actions billing blocked** — use `./scripts/ci/local-pr-smoke.sh` (mirrors `pr-smoke.yml`).
- Merge automation: `scripts/ci/run-merge-train.sh`, `gate-compare.sh`, `merge-train-verify.sh`, `merge-train-gate.sh`.
- **Baseline:** only `ts-typecheck-new` fails on trunk (43 Phase‑1 diagnostics); do not treat as a regression if unchanged.

### Open questions

- MED-4 / human UAT for **#8** (03.1-36 tier overrides)
- MED-6 refund deferral for **#6** (03.1-34)
- **03.1-32** scrape/crawl `jobId`
- **03.1-37** / #20 `doc_class` threshold
- **#22** schema-equality fold follow-up
- Wave 7: **03.1-38, 03.1-40, 03.1-41**; then **04-33** (0413 reserved)