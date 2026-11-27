# Orchestrator handoff (paused 2026-11-27 ~12:55 UTC)

## BLOCKING CONSTRAINTS
- [ ] Never force-push; never touch or commit secrets/customer data; never ask the owner to paste secrets in chat.
- [ ] Executors never touch prod Supabase ppvywaxrycaxrtrrditl or prod Vercel. Prod migrations only via the owner desk (apply_migration, owner present for DROP sections).
- [ ] Never retry a prod deploy without the owner's explicit go.
- [ ] Merge PRs only when every CI check is green (main requires pr-smoke). PRs only for trains and fixes.
- [ ] Do not archive a session whose suite is still running (slip on 06-45 earlier).
- [ ] Executors never edit another plan's migration file; new file + collision check across origin/main, origin/exec/*, origin/ci/*.
- [ ] Domain neutrality: no domain strings in product code/defaults/prompts/Config UI; corpus and golden sets stay out of the repo.
- [ ] Do NOT add the owner's email as admin.

## Current state
- Prod: main fbb6bc3c live (641 plans). Supabase: trains 30–35 applied.
- PR #131 (train 36) MERGED into main at 274d0456 (all 26 checks green). Next: owner desk applies sql/train36-live.sql; then ask the owner before deploying main.
- 15 executor sessions plus the owner desk were told to pause and push WIP (list in HANDOFF.json).
- Train 37 candidates: ledger/train37-candidates.md.

## How to resume
1. Owner desk: read ops/owner-actions (owner-queue.md, handoff file).
2. Executors: for each plan in HANDOFF.json, `git fetch origin exec/<plan>`. SUMMARY present → train candidate. .continue-here.md present → new opus session on exec/<plan> with prompt "run /gsd-resume-work and finish plan <plan> per briefs/executor-brief.md".
3. Ready detection: copy handoff/tools/why.py; run it from a main checkout after `git fetch origin` (`python3 why.py | grep READY`). Ignore auto=false and HOLD plans.
4. Launch pattern: create_session model opus, tags myrag-exec/phase-X, source_revision = dep exec branch (or a base/<plan> merge of deps; if a dep conflicts with the train, use the dep exec tip and let the train reconcile). Prompt = fetch briefs/executor-brief.md + autonomy + migration rule + OpenRouter 402 = stop.
5. Train builder: background agent using briefs/train-builder-brief.md; collect migrations into a trainNN-live.sql for the owner desk.

## Known issues
- test-rag false_refusal en 0.3143 > 0.25 fails on main (pre-existing; fixture-embedder vs legacy 0.65 floor). Fixes C/D are owner-queued.
- 04.4-14 fixture gate (b) duplicate_flood fails; 03.3-23 has 3 fixture gates failing (v2 ingest refusal); 05.2.1-14 has one failing vitest (legacy-post-filter-sentinel).
- OpenRouter dev/eval key may be capped at ~$10/day.
