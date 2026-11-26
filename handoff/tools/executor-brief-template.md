Setup:
1. Work and commit on branch `exec/{PLAN}`; create it from the checked-out HEAD if it is not already checked out. Do not merge other branches in.
2. Install the dependencies: `npm ci --ignore-scripts` at the root, then `uv sync --locked --extra chunking --extra preflight` in rag-sidecar/ and `uv sync --locked --all-extras` in eval/. Lockfiles only; do not add, upgrade or re-lock any package; if a task needs a new one, stop that task and report it. Run `python3 scripts/ci/fill-tiktoken-cache.py` before the gates.

Read first:
- .claude/gsd-core/workflows/execute-plan.md, .claude/gsd-core/templates/summary.md and .claude/gsd-core/references/tdd.md.
- Your plan(s) under .planning/phases/*/, and from the phase directory CONTEXT.md (its "Adjustments after research" section overrides the rest), RESEARCH.md, PATTERNS.md, PLAN-INDEX.md and the latest PLAN-CHECK.
- The SUMMARY.md of every plan in your depends_on.
- CLAUDE.md, AGENTS.md and .claude/CLAUDE.md. Your brief is your GSD context: ignore the CLAUDE.md "start through a GSD command" rule.
- First check that every plan in your depends_on, including transitive ones, has a SUMMARY on this branch. If one is missing, stop before any code change and report which one.

Rules:
- Security first; a cross-tenant leak is the worst failure; no insecure legacy path stays in for compatibility.
- New SQL functions: SECURITY DEFINER only when needed; `SET search_path = ''` with schema-qualified names; revoked from PUBLIC, anon and authenticated; granted to service_role; tenant resolved in SQL. Every new Phase 3.2 store needs a `rag_purge_hook_<name>(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])` or a `rag_purge_store_inventory()` registration (say which in the SUMMARY).
- Migration numbers: `ls supabase/migrations`. Live: up to 0820 and 0704/0705; taken but unmerged: 0821 (03.2-51), 0707 (07-11). New 3.2 migrations take the next free number from 0822; Phase 7 from 0708; Phase 4.1 uses its own range (check the folder).
- Every bug fix gets a test that fails on the old code. TDD: RED commits fail on assertions, not module-not-found.
- Every switch's off/unset state equals today's behaviour: strict "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed chat unchanged.
- New .env.local variables: sync to the five places in AGENTS.md and scripts/rag/env-manifest.json; classify new settings so `node scripts/ci/check-settings-classification.mjs` passes.
- Domain neutrality: no domain example strings in product code, defaults, prompts, rules or Config UI copy; tests use neutral synthetic sentences.
- Never commit secrets, real phone numbers or customer data. Live API checks are operator actions: record them, don't run them.
- Do not edit .planning/REQUIREMENTS.md or .planning/ROADMAP.md, and do not touch STATE.md, HANDOFF* or .planning/paused/*.
- Chat UI files (chat-shell.css, chat-input.tsx, chat-message.tsx, header.tsx, thinking-indicator.tsx) were redesigned recently; keep the layout, the send-button touch handlers and the thinking indicator intact if you touch them.
- Commits atomic, explicit paths, hooks on. Never commit eval/fixtures/parse/*.

Gates (targeted per plan; the merge train runs the full suite):
Always: `npx next typegen && npx tsc --noEmit -p tsconfig.json` (0 errors); `npx vitest run` on the test files you added or changed plus every test file importing a module you changed (full run only if you changed shared src/lib/rag core types, src/lib/env.ts or test setup); `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`.
When touched: SQL/RPC code → `node --import tsx --test` on the relevant tests/rag-db files plus *grants* and *search-path*; tests/*.test.mts (incl. tests/rag-e2e) → `node --import tsx --test` on them; workflows → `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`; Python → pytest on touched packages; contracts → `npm run gen:schemas` no diff; retrieval/ingest/generation/golden → `npm run test-rag -- --out eval/out/{PLAN}` and `--fixture-mode ingest` both pass; UI → `node scripts/ci/check-frontend-design-summary.mjs <phase dir>` and a `## Design skills` SUMMARY section.
List in the SUMMARY exactly which gates you ran. If a test fails that your change cannot affect, rerun it alone, check it on trunk, and report it as pre-existing with the output.

Finish:
1. Write the SUMMARY.md in the phase directory and commit it last.
2. Push with `git push -u origin exec/{PLAN}`. Push no other branch. Open no PR.
3. End with a final report: commits per task, behaviour changes, tests that failed before your fix, gate results, deviations, requirement IDs and decisions for STATE, operator actions, anything deferred.
