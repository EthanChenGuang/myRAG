You are a GSD plan executor in a fresh cloud session, one of several running in parallel. An orchestrator session assigned you exactly one plan: {P}. Decide every question yourself by your own recommendation. Do not ask the user anything.

Setup:
1. The repo is checked out at `ci/merge-train-20` (trunk `claude/ecstatic-hamilton-86gtwv` plus the dependency plans this one builds on). Work and commit on branch `exec/{P}`; create it from that HEAD if it is not already checked out. Do not merge trunk or other branches in.
2. Install the dependencies: `npm ci --ignore-scripts` at the root, then `uv sync --locked --extra chunking --extra preflight` in rag-sidecar/ and `uv sync --locked --all-extras` in eval/. That installs from the lockfiles only. Do not add, upgrade or re-lock any package; if a task needs a new one, stop that task and report it. Run `python3 scripts/ci/fill-tiktoken-cache.py` before the gates.

Read first:
- .claude/gsd-core/workflows/execute-plan.md, .claude/gsd-core/templates/summary.md and .claude/gsd-core/references/tdd.md.
- Your plan, .planning/phases/*/{P}-PLAN.md.
- From the phase directory: CONTEXT.md (its "Adjustments after research" section overrides the rest), RESEARCH.md, PATTERNS.md, PLAN-INDEX.md and the latest PLAN-CHECK.
- The SUMMARY.md of every plan in your depends_on.
- CLAUDE.md, AGENTS.md and .claude/CLAUDE.md. Your brief is your GSD context: ignore the CLAUDE.md "start through a GSD command" rule.
- Plans 05.1-18 and 05.1-25 were SKIPPED by the owner (Prompt Guard 2 declined); Prompt Guard is only the endpoint and fake from 05.1-07. Treat it as not configured. Plans 03.1-53/54 (sidecar host) are deferred to pre-production.

- First check that every plan in your depends_on, including transitive ones, has a SUMMARY on this branch. If one is missing, stop before any code change and report which one.

- Phase notes:
  - Phase 3.2: plans name code by symbol, and line hints are advisory. Its migrations are 0801-0811, and human plans 36, 53 and 65 are not yours.
  - Phase 3.1.1: migrations 0440-0442 rebuild from the 0425 bodies (`public.vector_dims`, the 0410 grants, `SET search_path = ''`). If a later migration already redefines `rag_chunk_embeddings_guard` or `rag_reembed_*`, stop and report. Plan 15 is human.
  - Phase 5.1: Prompt Guard is not configured, because 05.1-18 and 05.1-25 were skipped.

Rules:
- Security comes first. A cross-tenant leak is the worst failure, and no insecure legacy path stays in for compatibility.
- New SQL functions: SECURITY DEFINER only when needed; `SET search_path = ''` with schema-qualified names; revoked from PUBLIC, anon and authenticated; granted to service_role; the tenant is resolved in SQL.
- Every bug fix gets a test that fails on the old code.
- New switches: every new switch's off state equals today's behaviour. Strict mode's "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed chat must behave exactly as today with the switches off.
- New .env.local variables: sync them to the five places listed in AGENTS.md and to scripts/rag/env-manifest.json.
- Never commit secrets, real phone numbers or customer data. Use placeholders only; no real keys are needed. Live API checks are operator actions: record them, don't run them.
- Migration numbers: run `ls supabase/migrations` (0426 and 0427 are taken; the 08xx and 09xx blocks belong to the planning phases 3.2, 4.2, 4.3, 5.2, 5.3 and 6.2 — never use them unless you are executing a Phase 3.2 plan, which uses 0801-0811). If your plan's number is taken, take the next free number in your phase's range and say so in the SUMMARY.
- If you change the stage order in src/lib/rag/v2/stages/query.ts, leave a slot for Phase 4.1.1's terminology stage, after the parallel rewrite group and before semantic_cache. Do not order the stages in a way that blocks inserting it there.
- If you touch history trimming or prompt assembly in src/app/api/chat/route.ts, keep the user question last and add no provider-side truncation (Phase 5.2 RNK-08 will later compute a whole-prompt token budget).
- Domain neutrality (owner rule at the top of REQUIREMENTS.md): no product code, config default, prompt, lexicon, rule or Config UI copy may contain domain example strings (travel or lodging limits, leave days, salaries, restaurants, VPN or password FAQs, branch names). New tests use neutral synthetic sentences.
- Do not edit .planning/REQUIREMENTS.md or .planning/ROADMAP.md, and do not touch STATE.md, HANDOFF* or .planning/paused/*.
- TDD: a RED commit must fail on assertions, not on module-not-found.
- Commits: atomic, with explicit paths and hooks on.
- Never commit eval/fixtures/parse/*. Running eval/tests/test_parse_fixtures.py regenerates them; restore with `git checkout -- eval/fixtures/parse/`.

Gates (owner decision 2026-11-26: targeted gates per plan; the merge train runs the full suite):
Always:
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`, with 0 errors
- `npx vitest run` on the test files you added or changed plus every test file that imports a module you changed (find them with `git grep -l` on the module paths); run the full `npx vitest run` only if you changed shared code under src/lib/rag/ core types, src/lib/env.ts or test setup.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs` and `node scripts/ci/check-settings-classification.mjs`
Only when your change touches the area:
- SQL/migrations or code calling RPCs: `node --import tsx --test tests/rag-db/*.test.mts` (or the subset for the tables/functions you touched, plus tests/rag-db/*grants* and *search-path* tests).
- tests/*.test.mts or scripts they cover: `node --import tsx --test` on those files.
- .github/workflows: `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`
- Python: pytest in rag-sidecar and/or eval for the packages you touched (`-q` on the relevant test paths; full suite if you changed shared modules).
- Contracts: `npm run gen:schemas` leaves no diff.
- Retrieval, ingest, generation or golden sets: `npm run test-rag -- --out eval/out/{P}` and `npm run test-rag -- --fixture-mode ingest --out eval/out/{P}-ingest` both pass.
- UI: `node scripts/ci/check-frontend-design-summary.mjs <your phase directory>` passes and your SUMMARY has a `## Design skills` section.
List in the SUMMARY exactly which gates you ran.

If a test fails that your change cannot affect, rerun it alone. If it still fails, check whether it also fails on trunk, and report it as pre-existing with the output. Timing tests may flake under load; rerun them alone.

Finish:
1. Write {P}-SUMMARY.md in the phase directory and commit it last.
2. Push with `git push -u origin exec/{P}`. Push no other branch. Open no PR.
3. End with a final report: the commits per task, behaviour changes, the tests that failed before your fix, gate results, deviations, requirement IDs and decisions for STATE, operator actions, anything deferred.

Additional notes (planning session, 2026-11-25):
- Phase 4.1 and 4.1.1 plans carry stop-and-report preconditions (Phase 3.2 LANG-01, registry language type, settings.ts, config/golden stability). Check them first; if not met, stop and report.
- Phase 6 plans that run after 4.1.1: the terminology stage goes in D-05 after the parallel transform group and before semantic cache and embedding; update D-08 and 06-20 for the variant order and accounting; the 06-32 cache key includes `terminologyHashBlock` (on top of the retrieval-config hash computed after the binding legs are planned); 06-13, 06-15 and 06-35 take the glossary from `terminologyGlossary`. Full text: 04.1.1-PLAN-INDEX.md, "Wording changes needed outside this phase".
- Phase 3.2 executors: implement the D-02 unset rule so it plugs into the 04.1-04 resolver seam (`resolveEffectivePipeline`); give the eval pin an explicit language override (zh,en,it in CI); the D-07 validator checks the provider that `RAG_RERANKER=auto` resolves to.
- Phase 3.2 executors (from 6.3 planning): every new 3.2 store (chunk translations 0810, scope tags, supersession candidates, quarantine data) needs either a `rag_purge_hook_<name>(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])` (service_role only, `SET search_path = ''`) or a registration in `rag_purge_store_inventory()`; otherwise the 6.3 coverage test 06.3-19 fails later. State which you added in the SUMMARY.
- CLI names: Phase 7's 07-13 owns `rag:reconcile`; Phase 6.3 uses `rag:source-reconcile`.
- Phase 4.2: migrations 0851–0862 (0863 only if `rag_retrieval_log` exists). `hybrid_search_chunks` is redefined in order: 3.2's 0802 first, then 4.2's 0856; any later 3.2 redefinition must rebase on 0856. Human plans 04.2-23, 25, 26, 33 are not yours.
- Phase 6 (06-25): RET-13 diversify runs inside `runRankStages` before `reserveSubQuestionCoverage`; keep that order.
- Phase 3.2 plan 03.2-57: `ingest-impact.js` must accept a caller-supplied title, row labels, total label and note (Phase 7's 07-52 passes these without editing the file).
- Phase 6 executor (06-46): keep the scope_gate key that 06.2-03 adds to eval/config/latency-budgets.json.
- Phase 4.3 access groups (planned, not yet executed): Phase 3.2's `hybrid_search_translations` must take `p_access_keys` / `p_access_all`; Phase 4.2's table-row lookup, identifier lookup/suggestions and duplicate-cluster expansion RPCs must take `p_access_keys` / `p_access_all` and be classified in `tests/rag-db/access-catalog-sentinel.test.mts` once that file exists.
- Phase 5.2 owner decision D-91 (2026-11-25): 05.2-15 Task 1 FIXES the WhatsApp stream parser; proceed without stopping.
- Phase 3.2 gap-closure migration numbers 0812 (03.2-22, chunk language) and 0813 (03.2-33, caption language) are taken; a new 3.2 gap migration takes the next free number from 0814 up (check `ls supabase/migrations`).
- Phase 3.2 gap migration numbers 0812, 0813 and 0814 are taken; 0804 is 03.2-34. A new 3.2 gap migration takes the next free number from 0815 up.
- Phase 4.1 gap plans (04.1-14..17): the pre-registered gate criteria in eval/config/defaults-gate.json must not be loosened. Overlap with Phase 4.1.1: 04.1.1-05 also edits src/lib/rag/v2/pipeline.ts and eval/harness/run-eval.mts; whichever lands second rebases.
- Phase 3.2 gap migration numbers 0812-0816 are taken; a new 3.2 gap migration takes the next free number from 0817 up (check `ls supabase/migrations`).
- Chat route: src/lib/chat/answer-style.ts / cta-instruction.ts (RAG_ANSWER_STYLE) and src/lib/chat/followups.ts may land on main in parallel PRs; if your plan edits src/app/api/chat/route.ts prompt assembly, keep those helpers' call sites intact when you rebase.
- Migration numbers taken after train 20: 0536, 0537 (Phase 5), 0809, 0817, 0818 (Phase 3.2). A new 3.2 gap migration takes the next free number from 0819 up; check `ls supabase/migrations`.
- Chat UI (main, 2026-11-26): src/app/chat-shell.css, header.tsx, chat-input.tsx, composer-model-pill.tsx, model-selector.tsx, scroll-indicator.tsx were redesigned (PR #98); a typography follow-up edits chat-shell.css and chat-message.tsx. If your plan touches these UI files, keep the new layout intact.
