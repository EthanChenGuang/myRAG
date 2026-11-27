# 07-42 continue here (paused 2026-11-27, account credit)

Branch: exec/07-42 (base exec/07-40). Preconditions checked: all 385 transitive deps have SUMMARYs; 05/05.1/06 VERIFICATION are human_needed; migration 0741 was free and is pushed.

Done:
- Task 1: migration 0741 `rag_red_team_open_cases` plus PGlite test `tests/rag-db/red-team-cases.test.mts` (14/14 pass in both modes). The cases route `src/app/api/internal/rag/red-team/cases/route.ts` is written (WIP: not yet typechecked or tested).
- Task 2: `config/rag/red-team-techniques.json` (11 techniques), `eval/fixtures/red-team/attack-corpus.jsonl` (33 synthetic items, zh/en/it), `eval/src/rag_eval/red_team.py` (add/check/report), `eval/tests/test_red_team.py` (16 pass). `check` passes.
- Runner `eval/harness/run-red-team.mts` is written (WIP, untested). `createStubLanguageModel` is now exported from eval/harness/run-eval.mts.

Left:
1. Write `tests/eval/run-red-team.test.ts` (vitest): scoreAttack signals; sec04Cases count; tenant mismatch and marker refusal before any ask (test name must contain "marker"); 404 -> skipped_reason domain_expert_review_off with 0 opened; batching at 500; private corpus included without its text in report.md; one full in-process stub run (createInProcessTransport with reviewSwitch 'true') that checks that every case is replayed and review items equal the successes; HTTP transport with a fake fetch; main() with --base-url and no secret -> exit 4 with ENDPOINT_SKIP_NOTICE.
2. Add `"rag:red-team": "tsx eval/harness/run-red-team.mts"` to package.json.
3. Gates: typegen+tsc, vitest on the new and changed tests (the run-eval.mts importers too), check-rag-boundary (the route imports @/lib/rag/deps; confirm it is allowed), check-config, language-literals, settings-classification, rag-db grants/search-path tests, test-rag (known pre-existing false_refusal en 0.3143 failure).
4. SUMMARY decisions to record: skipped_reason uses the contract value domain_expert_review_off (the plan says review_disabled); the fingerprint includes run id and item id so a case is opened once per run and item; expiry is a literal 90 days (feedback-mining.json open_item_ttl_days); route auth is the eval secret via checkEvalAccess and the tenant comes from evalScope plus RAG_EVAL_ALLOWED_SCOPES; the runner imports nightly-sec.mts (run-nightly.mts runs main on import); trace ids are minted by the runner as rt-<run8>-<item>; --base-url mode needs the operator to load the corpus and pass --marker-document; the D-14 scoring is restated in TS (residual output findings not used); Tasks 2 and 3 tests landed together with their implementation (mutation-checked); domain-neutrality review of the corpus (invented instrument names, reading intervals only).
