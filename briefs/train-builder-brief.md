# Merge-train builder brief (fast path, owner-approved speed-up 2026-11-26)

Goal: build `ci/merge-train-{N}` from origin/main plus the listed branches, and push it so GitHub CI can run. GitHub CI is the authoritative full gate: 16 parallel jobs, about 8 minutes. Do NOT rerun the full suite locally.

1. `git checkout -b ci/merge-train-{N} origin/main`. Merge each branch with `--no-ff`, in the order given. Resolve conflicts by keeping both sides' intent; never drop a migration or a test.
2. Migration checks:
   - Numbers are unique across supabase/migrations.
   - Files sort in dependency order (a fix must sort after the file it overrides).
   - Every new file is idempotent.
   List the new migrations.
3. Local gates (fast, only what CI cannot tell you in time):
   - `npx next typegen && npx tsc --noEmit -p tsconfig.json`, 0 errors
   - `node scripts/check-config.mjs` and `node scripts/ci/check-rag-boundary.mjs`
   - `node --import tsx --test tests/rag-db/*.test.mts` (migrations apply cleanly in both modes; grants and search_path)
   - vitest only on test files touched by conflict resolutions
4. Push as soon as step 3 passes (push early, push often). Report the new migrations and their apply order.
5. Append the train-{N} section to `.planning/LIVE-MIGRATION-LOG-2026-11-25.md`: branches, migrations, apply order, and the combined live SQL (DO-block deltas for 0410 if needed). Push.
6. If GitHub CI then fails, the orchestrator sends you the failing job. Fix it on the train branch with a test, and push again.

Never force-push. Never skip, disable or quarantine a test.
