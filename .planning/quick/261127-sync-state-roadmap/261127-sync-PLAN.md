---
phase: quick
plan: 261127-sync
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/STATE.md
  - .planning/ROADMAP.md
  - .planning/quick/261127-sync-state-roadmap/261127-sync-PLAN.md
  - .planning/quick/261127-sync-state-roadmap/261127-sync-SUMMARY.md
autonomous: true
---

# Quick 261127-sync: sync STATE.md and ROADMAP.md to SUMMARY locations

Only `.planning/` changes. No product code.

## Task 1: Count SUMMARY locations
`git fetch origin '+refs/heads/*:refs/remotes/origin/*'`, then for every PLAN.md at `origin/ci/merge-train-39` classify the plan by where its `*-SUMMARY.md` exists: `origin/main`; only a `ci/merge-train-*` branch; only an `exec/*` or `verify/*` branch; none. verify: other branch families hold no SUMMARY of the "none" plans.

## Task 2: Update ROADMAP.md and STATE.md
- ROADMAP Progress table counts and status, plan checkboxes for plans with a SUMMARY on main, "done, pending merge" for the others.
- STATE.md frontmatter progress, Current Position, Blockers (owner items, eval DB at train 34, access-group security fixes 0984/1010/0986 and the review-writers renumbering, 06.2 switches in deps.ts), Quick Tasks rows.
- Anything not found in the repo reads "unknown".

## Task 3: Gates
`gsd-tools validate health` equals its pre-change result (no new errors or warnings); `node scripts/ci/check-frontend-design-summary.mjs` on the quick directory passes.
