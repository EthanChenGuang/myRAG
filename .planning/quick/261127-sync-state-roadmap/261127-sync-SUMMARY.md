---
quick_id: 261127-sync
slug: state-roadmap
branch: exec/quick-state-sync
base: origin/ci/merge-train-39 (c6f1b3f769a60334935040eeb2b44110a3a31626)
status: complete
date: 2026-11-27
---

# Quick 261127-sync: STATE.md and ROADMAP.md synced to SUMMARY locations

## What changed (only .planning/)
- `ROADMAP.md`: Progress table counts and status for all 25 phases; 269 plan checkboxes ticked (SUMMARY on main); a sync note under "## Progress".
- `STATE.md`: frontmatter progress (25 phases, 833 plans, 704 with a SUMMARY on main, 12 phases with every plan done), Current Position digest, new blocker block, five quick-task rows.
- Plans done only on a train or exec branch are marked "done, pending merge", never shipped.

## Method
Fetched all remotes. Plan list: PLAN.md files at `origin/ci/merge-train-39` (833). SUMMARY presence read from `origin/main` (00afa6d9), every `origin/ci/merge-train-*` (1..40), every `origin/exec/*` and `origin/verify/*`. Priority: main, then train only, then exec/verify only, else none. The 77 "none" plans were also searched on every other branch family (base, fix, feat, claude, ops, ...): no SUMMARY there. Train 40 is newer than the base train 39; its SUMMARYs count as "train only" (04.2-33, 04.3-52, 05.2.1-16, 05.3-48, 06.3-01..03). SUMMARY frontmatter `status` is missing in most files, so presence is the rule; non-complete statuses seen on main are listed in STATE.

## Counts (plans / main / train only / exec-verify only / none)
| Phase | Plans | Main | Train | Exec | None |
|---|---|---|---|---|---|
| 01 | 22 | 22 | 0 | 0 | 0 |
| 02 | 36 | 36 | 0 | 0 | 0 |
| 03 | 53 | 50+5 | 0 | 0 | 3 |
| 03.1 | 55 | 55+1 | 0 | 0 | 0 |
| 03.1.1 | 16 | 15 | 0 | 0 | 1 |
| 03.2 | 65 | 65 | 0 | 0 | 0 |
| 03.2.1 | 5 | 5 | 0 | 0 | 0 |
| 03.3 | 26 | 24 | 0 | 1 | 1 |
| 04 | 47 | 47 | 0 | 0 | 0 |
| 04.1 | 17 | 17 | 0 | 0 | 0 |
| 04.1.1 | 18 | 18 | 0 | 0 | 0 |
| 04.2 | 39 | 38 | 1 | 0 | 0 |
| 04.3 | 38 | 17 | 19 | 0 | 2 |
| 04.4 | 15 | 14 | 0 | 0 | 1 |
| 05 | 26 | 26 | 0 | 0 | 0 |
| 05.1 | 25 | 25 | 0 | 0 | 0 |
| 05.1.1 | 25 | 25 | 0 | 0 | 0 |
| 05.2 | 40 | 38 | 0 | 0 | 2 |
| 05.2.1 | 26 | 16 | 5 | 0 | 5 |
| 05.3 | 52 | 49 | 1 | 0 | 2 |
| 06 | 46 | 45 | 0 | 0 | 1 |
| 06.1 | 20 | 20 | 0 | 0 | 0 |
| 06.2 | 40 | 11 | 12 | 3 | 14 |
| 06.3 | 29 | 0 | 3 | 4 | 22 |
| 07 | 52 | 26 | 1 | 2 | 23 |

Total 833 plans: 704 main, 42 train only, 10 exec/verify only, 77 none. "+N" = SUMMARYs on main with no PLAN.md at train 39.

## Done, pending merge
| Plan | Where | Branch |
|---|---|---|
| 03.3-25 | exec/verify only | exec/03.3-25 |
| 04.2-33 | train only | ci/merge-train-40 |
| 04.3-08 | train only | ci/merge-train-38 |
| 04.3-09 | train only | ci/merge-train-38 |
| 04.3-10 | train only | ci/merge-train-38 |
| 04.3-11 | train only | ci/merge-train-38 |
| 04.3-14 | train only | ci/merge-train-38 |
| 04.3-15 | train only | ci/merge-train-38 |
| 04.3-23 | train only | ci/merge-train-38 |
| 04.3-32 | train only | ci/merge-train-38 |
| 04.3-41 | train only | ci/merge-train-38 |
| 04.3-42 | train only | ci/merge-train-38 |
| 04.3-43 | train only | ci/merge-train-38 |
| 04.3-44 | train only | ci/merge-train-38 |
| 04.3-45 | train only | ci/merge-train-38 |
| 04.3-46 | train only | ci/merge-train-38 |
| 04.3-47 | train only | ci/merge-train-38 |
| 04.3-48 | train only | ci/merge-train-38 |
| 04.3-49 | train only | ci/merge-train-38 |
| 04.3-51 | train only | ci/merge-train-38 |
| 04.3-52 | train only | ci/merge-train-40 |
| 05.2.1-12 | train only | ci/merge-train-38 |
| 05.2.1-16 | train only | ci/merge-train-40 |
| 05.2.1-17 | train only | ci/merge-train-39 |
| 05.2.1-21 | train only | ci/merge-train-38 |
| 05.2.1-22 | train only | ci/merge-train-38 |
| 05.3-48 | train only | ci/merge-train-40 |
| 06.2-06 | train only | ci/merge-train-38 |
| 06.2-10 | train only | ci/merge-train-38 |
| 06.2-11 | train only | ci/merge-train-38 |
| 06.2-12 | train only | ci/merge-train-38 |
| 06.2-14 | train only | ci/merge-train-38 |
| 06.2-15 | train only | ci/merge-train-39 |
| 06.2-16 | train only | ci/merge-train-38 |
| 06.2-17 | train only | ci/merge-train-39 |
| 06.2-18 | train only | ci/merge-train-39 |
| 06.2-20 | train only | ci/merge-train-39 |
| 06.2-21 | train only | ci/merge-train-39 |
| 06.2-27 | train only | ci/merge-train-39 |
| 06.2-24 | exec/verify only | exec/06.2-24 |
| 06.2-36 | exec/verify only | exec/06.2-36 |
| 06.2-39 | exec/verify only | exec/06.2-39 |
| 06.3-01 | train only | ci/merge-train-40 |
| 06.3-02 | train only | ci/merge-train-40 |
| 06.3-03 | train only | ci/merge-train-40 |
| 06.3-06 | exec/verify only | exec/06.3-06 |
| 06.3-07 | exec/verify only | exec/06.3-07 |
| 06.3-10 | exec/verify only | exec/06.3-10 |
| 06.3-27 | exec/verify only | exec/06.3-27 |
| 07-42 | train only | ci/merge-train-38 |
| 07-28 | exec/verify only | exec/07-28 |
| 07-34 | exec/verify only | exec/07-28 |

## Unknown (not found in the repo)
- Commit hashes of the five quick-task rows added to STATE (shown as "unknown"); the 261127-dta, rwa, cmt, irl and openrouter-fallback quick tasks exist only on exec/quick-* and are not in the table.
- Whether trains 35-39 are applied on the eval Supabase project (only "paused after train 34" is recorded); prod state after train 37.
- The new migration number for the review-writers migration (0986 collides with `0986_tenant_doc_types_access.sql` on exec/quick-doc-types-access); not chosen here.
- Per-plan live-check status of the 27 `autonomous: false` plans that have a SUMMARY on main (only those with a non-complete `status` are named).
- Whether 0984 and 1010 are applied on prod (handoff records through train 36/37).
- A HOLD marker: none exists in any PLAN.md; the only hold is the release-gate H-3 note in the owner handoff.

## Findings worth the orchestrator's attention
- 06.2-32-PLAN.md lists no `src/lib/rag/deps.ts` in `files_modified`, although the owner assigned the 06.2 switch reads to it. At train 39 deps.ts reads none of the 06.2 switches (06.2-18 SUMMARY says so).
- Phase counts in the old ROADMAP were far behind main (for example 3.2 read 0/65, main has 65 SUMMARYs).

## Gates run
- `git fetch` of all branches: ok.
- `gsd-tools validate health`: status degraded, 0 errors, 9 warnings (3 W009, 5 W019, 1 W024), identical before and after my edits (pre-existing).
- `node scripts/ci/check-frontend-design-summary.mjs .planning/quick/261127-sync-state-roadmap`: SKIP (no UI surface), exit 0; no false positive.

## Deviations
- Planner and executor subagents were not spawned: a single documentation task with the data already in hand; the PLAN.md was written directly and the work done inline on branch `exec/quick-state-sync`.
- The STATE quick-task rows were added by hand (commit "unknown") instead of `quick-tasks-append`, which stamps the current HEAD.
- Checkboxes in ROADMAP were only changed for lines that exist in the "Plans:" lists (Phases 1 to 3 and a few later ones); the table is the authoritative count.
