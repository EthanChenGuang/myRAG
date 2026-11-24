# HANDOFF — Trunk merge train pause (Claude Code takeover)

**Branch:** `claude/ecstatic-hamilton-86gtwv` (push only; no PR)  
**Trunk HEAD:** `56b0349d6307b757e4df1eab897878f11e4b8d81` (2026-11-24)  
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

### Remaining queue + last gate state

| PR | Branch | Status | Notes |
|----|--------|--------|-------|
| #6 | `exec/03.1-34` | skipped | Merge conflict `HANDOFF.md` |
| #12 | `exec/03.1-35` | skipped | Merge conflict `HANDOFF.md` |
| #8 | `exec/03.1-36` | skipped | Merge conflict `HANDOFF.md` |
| #7 | `exec/03.1-55` | skipped | Merge conflict `HANDOFF.md` |
| #11 | `exec/04-28` | skipped | New fail: `tests/rag-db/*` `match_chunks_by_profile` iterative-scan subtests |
| #15 | `exec/04-29` | **not gated** | Runner killed during gate |
| #13 | `exec/04-37` | pending | — |
| #18,#21,#17,#16,#20,#19 | wave‑6 on #7 | pending | Union `src/lib/rag/index.ts` exports; #19 **0357** DEFINER |
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