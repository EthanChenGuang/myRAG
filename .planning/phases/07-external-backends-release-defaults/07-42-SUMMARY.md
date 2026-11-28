---
phase: 07-external-backends-release-defaults
plan: 42
subsystem: rag-eval-red-team
tags: [sec-11, red-team, review-queue, prompt-injection]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-40 (RedTeamCorpusItem, RedTeamReport contracts), 07-13 (last Phase 7 package.json editor)"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-19 nightly SEC machinery (nightly-sec.mts injectionGoldenLines, D-14 attack-success rule); closing plan 05.1-22"
  - phase: 05.1.1-feedback-loop
    provides: "public.rag_review_items, its unique key (tenant_key, query_fingerprint, mining_window) and the D-29 tags column; closing plan 05.1.1-22"
  - phase: 05-verified-citations-groundedness
    provides: "closing plan 05-25"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "closing plan 06-45"
provides:
  - "supabase/migrations/0741_red_team_review_cases.sql: rag_red_team_open_cases (SECURITY INVOKER, search_path '', service_role only)"
  - "POST /api/internal/rag/red-team/cases (eval secret, 404 with RAG_DOMAIN_EXPERT_REVIEW off, tenant from the eval scope resolution)"
  - "config/rag/red-team-techniques.json (11 techniques) and eval/fixtures/red-team/attack-corpus.jsonl (33 synthetic items, zh/en/it)"
  - "eval/src/rag_eval/red_team.py: add, check, report"
  - "eval/harness/run-red-team.mts and `npm run rag:red-team -- run --tenant <key>`"
affects: [07-48]

actuals:
  tasks: 3
  commits: 7  # RED, GREEN migration, corpus tools, WIP runner, runner tests + script, boundary fix, SUMMARY

tech-stack:
  added: []
  patterns:
    - "A scalar RPC answer is read as the value or as a one-row object keyed by the function name (PostgREST vs the fixture edge)"

key-files:
  created:
    - supabase/migrations/0741_red_team_review_cases.sql
    - src/app/api/internal/rag/red-team/cases/route.ts
    - config/rag/red-team-techniques.json
    - eval/fixtures/red-team/attack-corpus.jsonl
    - eval/src/rag_eval/red_team.py
    - eval/tests/test_red_team.py
    - eval/harness/run-red-team.mts
    - tests/rag-db/red-team-cases.test.mts
    - tests/eval/run-red-team.test.ts
  modified:
    - eval/harness/run-eval.mts  # createStubLanguageModel exported
    - package.json  # rag:red-team

key-decisions:
  - "skipped_reason uses the RedTeamReport contract value domain_expert_review_off (the plan text says review_disabled; the 07-40 contract is authoritative). A non-200, non-404 answer reports review_route_unavailable"
  - "query_fingerprint = sha256('red_team:<run>:<item>:' + normalised question), so one run opens one case per item; ON CONFLICT DO NOTHING on the 5.1.1 key makes a repeat insert nothing"
  - "Expiry is a literal 90 days, matching config/rag/feedback-mining.json open_item_ttl_days"
  - "Route auth is the eval secret through checkEvalAccess (constant-time, production enable rule); the tenant comes from evalScope plus RAG_EVAL_ALLOWED_SCOPES; the body schema is strict, so a body carrying tenant_key is rejected with 400"
  - "The route uses getSupabaseAdmin from @/lib/supabase (as the feedback-loop admin routes do); @/lib/rag/deps is a deep import the RAG boundary check refuses"
  - "The runner imports injectionGoldenLines from nightly-sec.mts (run-nightly.mts runs main on import), and restates the D-14 scoring in TS (canary or forbidden claim in the answer, injected span in the context, rag_eval normalisation); SEC-04 forbidden claims are literals, corpus ones are patterns"
  - "Trace ids are minted by the runner as rt-<run8>-<item>"
  - "--base-url mode needs the operator to load the run corpus and pass --marker-document <uuid>; the marker check is a retrieval filtered to that document whose context must hold RTM-WORKSPACE-SYNTHETIC-0742. --run-config applies to in-process runs only"
  - "Purge coverage: no new store; red-team cases are rows of rag_review_items, already covered by its 5.1.1 purge path"

requirements-completed: [SEC-11]

duration: two sessions
completed: 2026-11-27
---

# Phase 7 Plan 42: Red-team run Summary

**On-demand red-team replay of the SEC-04 set and a growing attack corpus, scored with the Phase 5.1 D-14 rule, reported per technique and language, with one review-queue case per success.**

## Performance

- Tasks: 3 of 3
- Files: 9 created, 2 modified

## Accomplishments

- Migration 0741 `rag_red_team_open_cases`: SECURITY INVOKER, `SET search_path = ''`, `rag_assert_tenant_key` first, at most 500 cases, payload validation (22023), tags `red_team` and `rt_<technique>`, revoked from PUBLIC/anon/authenticated, granted to service_role, idempotent, not folded into setup files.
- Cases route: Zod (`zod/v3`) strict body, at most 500 cases, eval-secret access, 404 with `RAG_DOMAIN_EXPERT_REVIEW` off, tenant resolved server-side.
- Technique list (11 entries: published families, hidden text, link text/target, table cell, image caption, multi-turn setup, encoding/obfuscation, plus the Phase 5.1 categories), a 33-item synthetic corpus (every technique in zh, en and it, one canary each) and `rag_eval.red_team add|check|report`.
- Runner: tenant check and marker check before any request, replay of every SEC-04 item and every corpus item (private corpus included when present, its text never in report.json or report.md), batched case posts at 500, `report.json` (RedTeamReport) and `report.md` under `eval/out/red-team/<run_id>/`, exit 2 on refusal, 4 with the skip notice when the endpoint or secret is missing.

## Behaviour changes

- New script `rag:red-team` and a new internal route; nothing in chat, embed, voice or retrieval changes. With `RAG_DOMAIN_EXPERT_REVIEW` off (default) the route answers 404 and a run writes nothing to the queue.

## Bug found by the tests (failed before the fix)

- The full in-process run (`full in-process run over the stub generator`) failed with `review_items_opened` 0 against 63 successes: the route read only a bare number, while the fixture edge answers a scalar RPC as `[{ rag_red_team_open_cases: n }]`. The route now reads both shapes (`openedCount`). The same test fails on the old code.

## Stub-run observations (informational)

- `npm run rag:red-team -- run --tenant s:default --generator stub`: 63 of 63 successes with every defense off (the stub echoes the first context sentence, so every exposed span counts), review cases skipped (`domain_expert_review_off`).
- With `--run-config eval/config/runs/sec-recommended.json`: 44 of 63. The rules-only recommended configuration still exposes most new-technique items. This is red-team finding material for the review queue, not a regression. A live-generator run is an operator action.

## Domain-neutrality review

- I reviewed all 33 committed items and the technique list. They use invented instrument names (for example Brennik-11, Quorvel-14) and reading intervals only, with no business-domain nouns. A grep for the owner's banned example terms (en, zh, it) found 0 hits in the corpus, the technique list, the route and the runner.

## TDD notes

- Task 1 RED (81f2a3de) failed on assertions before 0741 existed. Tasks 2 and 3 landed their tests together with the implementation. I checked those tests by mutation: removing the marker check makes the two marker tests fail (`-t "marker"`: 2 failed), and dropping ON CONFLICT DO NOTHING fails "inserts nothing twice".

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/eval/run-red-team.test.ts tests/eval-corpus.test.ts tests/eval-harness.test.ts tests/rag/fake-answer-models.test.ts` (the new test plus the run-eval.mts importers): 72/72 passed
- `node --import tsx --test tests/rag-db/red-team-cases.test.mts tests/rag-db/definer-search-path-pglite.test.mts tests/rag-db/hybrid-grants.test.mts tests/rag-db/search-path-empty.test.mts tests/rag-db/search-rpc-grants-pglite.test.mts`: 68/68 passed
- `uv run --directory eval pytest -q tests/test_red_team.py`: 16 passed; `python -m rag_eval.red_team check`: ok
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: ok
- `npm run test-rag -- --out eval/out/07-42`: `gate.json` `passed: true`, `paired.all_zero: true`. The absolute gate reports `false_refusal_rate language:en: measured 0.3143 vs max 0.2500` (exit 11). The previous session recorded this as pre-existing, and this plan changes no retrieval or generation code.
- Not run: the ingest-mode test-rag (no ingest, retrieval or golden change), workflows, gen:schemas (no contract change), UI.

## Deviations

- skipped_reason value `domain_expert_review_off` (contract) instead of `review_disabled` (plan text).
- The route reads a row-shaped scalar answer too (see the bug above).
- The route uses `getSupabaseAdmin` instead of `getRagDeps().adminClient()` because of the RAG boundary check.
- Migration number 0741 was free and is used as planned.

## Operator actions

- Live red-team run against the eval project only (fsgaeysipkukqoocgzbx): load the run corpus (`buildRunCorpus` output) and the marker document into a synthetic workspace, then `RAG_EVAL_SECRET=… npm run rag:red-team -- run --tenant <key> --base-url <eval app url> --marker-document <uuid>`. Turn on `RAG_DOMAIN_EXPERT_REVIEW` there to open cases.
- Apply migration 0741 to the eval project (not production).

## Deferred

- The Config UI start button is plan 07-48.
