---
phase: 03-unified-ingestion-embedding-profiles
plan: 48-setup-idempotent
subsystem: database
tags: [supabase, idempotency, sql, pglite]

requires:
  - phase: 03-47
    provides: Folded setup includes Phase 3 migrations; live Task 1 found 42710 on track_document_storage
provides:
  - Folded single-tenant and multi-tenant setup SQL safe to re-apply on the same baseline (catalog unchanged)
  - PGlite regression tests for re-run idempotency
  - Operator docs for fresh install vs migration upgrade vs patch path
affects: [live-supabase-apply, setup-database.sh]

actuals:
  tokens: 48000
  tasks: 2
  commits: 3
  plan_head_before: d1c58219ff4ca1c8acccd26b205f97e3db8c1e71
  plan_head_after: a23fae1

tech-stack:
  added: []
  patterns:
    - "DROP TRIGGER IF EXISTS / DROP POLICY IF EXISTS before CREATE in folded setup files"

key-files:
  created: []
  modified:
    - tests/rag-db/schema-equality.test.mts
    - supabase/multi-tenant-setup.sql
    - supabase/single-tenant-setup.sql
    - supabase/README.md
    - scripts/setup-database.sh

key-decisions:
  - "Folded setup files are idempotent for repair (triggers + RLS); routine upgrades stay on supabase/migrations/ and patches/"
  - "Unquoted connector_config policies required explicit DROP lines (multi-line CREATE POLICY)"

requirements-completed: []

status: complete
---

# Phase 03 Plan 48-setup-idempotent: Folded setup idempotency

**One-liner:** Live `ERROR 42710` on `track_document_storage` fixed by idempotent trigger and RLS policy drops in folded setup SQL, with PGlite tests and operator docs.

## Accomplishments

- Added `reapplyFoldedSetup` regression in `tests/rag-db/schema-equality.test.mts`: second apply of folded setup leaves the public catalog unchanged (both deployment modes).
- `supabase/*-setup.sql`: `DROP TRIGGER IF EXISTS` before non-phase-3 triggers (including `track_document_storage`), `DROP POLICY IF EXISTS` before every `CREATE POLICY` (quoted and unquoted connector policies).
- Documented fresh install, same-baseline repair re-apply, and patch/migration upgrade paths in `supabase/README.md` and `scripts/setup-database.sh`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Critical] RLS policies beyond the reported trigger also blocked re-apply**
- **Found during:** TDD re-run test after trigger-only fix
- **Issue:** `CREATE POLICY` without preceding `DROP POLICY IF EXISTS` failed with `42710` (50+ policies in multi-tenant file)
- **Fix:** Automated `DROP POLICY IF EXISTS` insertion; hand-fixed unquoted `connector_config_*` policies
- **Files modified:** `supabase/multi-tenant-setup.sql`, `supabase/single-tenant-setup.sql`
- **Commit:** d1c5821 (bulk), 43b18d4 (connector policies)

## Verification

| Gate | Result |
|------|--------|
| `node --import tsx --test --test-name-pattern "safe to re-run" tests/rag-db/schema-equality.test.mts` | pass (2/2) |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | pass |
| `node scripts/ci/check-rag-boundary.mjs` | pass |
| `node scripts/check-config.mjs` | pass |
| `python3 scripts/ci/check-workflows.py` | pass |
| Full `schema-equality.test.mts` | partial — corpus/relex tests fail with `rpc_failed:rag_relex_candidates` in this worktree (pre-existing harness path; orchestrator re-runs) |

## Commits

| Task | Commit | Message |
|------|--------|---------|
| TDD + SQL (prior handoff) | d1c5821 | wip: test + trigger/policy drops |
| SQL completion | 43b18d4 | fix: connector_config RLS drops |
| Docs | a23fae1 | docs: README + setup-database.sh |

## Self-Check: PASSED

- [x] `tests/rag-db/schema-equality.test.mts` contains re-run tests
- [x] Commits 43b18d4, a23fae1 on branch `exec/03-48-setup-idempotent`