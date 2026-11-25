---
status: awaiting_human_verify
trigger: "PGlite tests fail with `[RAG Relex] rpc_failed:rag_relex_candidates` (RelexInputError) thrown from runFixtureRelex in eval/harness/pglite-supabase.mts; affects schema-equality (10/19), schema-migrations, documents-versions (27). Reproduces on 3b7617b."
created: 2026-11-24T00:00:00Z
updated: 2026-11-24T14:40:00Z
---

## Current Focus

bug_class: Bohrbug (deterministic, 100% repro on every createFixtureDatabase({ migrations: false }) call)
hypothesis: createFixtureDatabase runs relex by default even when options.migrations === false; rag_relex_candidates exists only after migration 0402, so the call fails with SQLSTATE 42883, which the harness relabels P0001 and RelexInputError drops entirely
test: tests/rag-db/fixture-relex.test.mts (RED 6/8 then 4/8 on the fingerprint assertion; GREEN 8/8)
expecting: confirmed
next_action: orchestrator review/merge of exec/fix-relex-rpc; newly visible failures listed under Resolution.newly_visible need their own plans

reasoning_checkpoint:
  hypothesis: "Tests that build a fixture with migrations:false fail because createFixtureDatabase unconditionally (default relex=true) calls rag_relex_candidates, which is created only by migration 0402 and therefore does not exist yet (42883 undefined_function)."
  confirming_evidence:
    - "Direct call on createEmptyFixtureDatabase({migrations:false}) -> 42883 'function rag_relex_candidates(...) does not exist'; with migrations:true -> OK"
    - "All 10 failing schema-equality tests go through build() -> createFixtureDatabase({migrations:false}); the 9 passing ones never do"
    - "e0ee0bb (04-16) added the default-on relex without looking at options.migrations"
    - "schema-migrations '0304 backfills' asserts lexical_text IS NULL after migrations, i.e. expects no relex on a migrations:false fixture"
  falsification_test: "If gating relex on migrations does not make the 3 files' relex failures disappear, or if any caller needs relex on a migrations:false DB (it cannot: the function does not exist there), the hypothesis is wrong. Revert check: restoring the old default must bring rpc_failed back."
  fix_rationale: "Relex is a post-migration step. Default relex to (migrations !== false) so a migrations:false fixture is the pristine pre-migration DB its callers expect; callers that migrate later can call the exported runFixtureRelex(db). Separately keep the SQLSTATE visible (harness passes PGlite's code; RelexInputError carries the RPC code) so this class of failure is diagnosable."
  blind_spots: "Newly visible failures behind the relex error in the three files (they never ran their assertions since 04-16); whether any non-test caller (eval runner) passes migrations:false and expects lexical data."
  candidate_causes:
    - "code: harness default relex=true ignores migrations:false (CONFIRMED)"
    - "config/grants: EXECUTE revoked from fixture role by 0402/0409-0411 (ELIMINATED: fixture runs as superuser and the function does not exist before migrations)"
    - "code: TS caller signature vs SQL signature mismatch (ELIMINATED: identical named args succeed once 0402 is applied)"
    - "data/ordering: migration ordering (ELIMINATED as a migration bug: the order is fine; the harness calls relex before the caller applies migrations)"
  and_gate: "yes — two conditions together: (1) relex default-on independent of migrations, AND (2) callers using migrations:false then migrating themselves. A third factor (error relabelled P0001 and dropped) did not cause the failure but kept it undiagnosed since 04-16."

## Symptoms

expected: fixture DB builds (createFixtureDatabase -> runFixtureRelex) succeed; tests run their assertions
actual: RelexInputError `[RAG Relex] rpc_failed:rag_relex_candidates` from runFixtureRelex
errors: "[RAG Relex] rpc_failed:rag_relex_candidates"
reproduction: run tests/rag-db/schema-equality.test.mts, tests/rag-db/schema-migrations.test.mts, tests/rag/documents-versions.test.ts
started: present on pre-merge baseline 3b7617b

## Eliminated

- hypothesis: relex RPC EXECUTE revoked from the fixture client's role (0402 REVOKE / 0409-0411)
  evidence: fixture queries run as the PGlite superuser (no SET ROLE in pgliteRpcClient); the error is 42883 undefined_function, not 42501; also failed before 0409-0411 existed
  timestamp: 2026-11-24T00:15:00Z

- hypothesis: argument/signature mismatch between run.ts and the SQL function
  evidence: the identical named-argument call succeeds on a migrated fixture (migrations=true -> OK)
  timestamp: 2026-11-24T00:15:00Z

- hypothesis: migration ordering bug
  evidence: applyMigrations order is fine (0402 after 0401); the harness calls relex before the caller runs applyMigrations at all
  timestamp: 2026-11-24T00:15:00Z

## Evidence

- timestamp: 2026-11-24T00:00:00Z
  checked: .planning/debug/knowledge-base.md
  found: no knowledge base file exists in this worktree
  implication: no known-pattern candidate

- timestamp: 2026-11-24T00:05:00Z
  checked: baseline run `node --import tsx --test tests/rag-db/schema-equality.test.mts` on 157641d
  found: 19 tests, 9 pass, 10 fail. Every failing test calls build(), which calls createFixtureDatabase({ migrations: false }). Passing tests call createEmptyFixtureDatabase directly (no relex) or are static.
  implication: failure correlates with createFixtureDatabase + migrations:false, not with the frozen setup specifically (apply:'twice'/'all-but-last'/'none' on the current setup fail too)

- timestamp: 2026-11-24T00:08:00Z
  checked: direct call of rag_relex_candidates on createEmptyFixtureDatabase({ migrations: false|true })
  found: migrations=false -> SQLSTATE 42883 "function rag_relex_candidates(p_after => unknown, ...) does not exist"; migrations=true -> OK
  implication: the RPC is created only by migration 0402; the setup files (folded through Phase 3) do not contain it. Not a grant/role problem, not a signature mismatch.

- timestamp: 2026-11-24T00:10:00Z
  checked: eval/harness/pglite-supabase.mts pgliteRpcClient + src/lib/rag/ingest/relex/run.ts callRpc
  found: harness maps every PGlite error to code 'P0001' (drops SQLSTATE 42883); callRpc throws RelexInputError(`rpc_failed:${rpc}`) and drops both code and message
  implication: the real cause (undefined_function) was invisible in test output, which is why it persisted

- timestamp: 2026-11-24T00:12:00Z
  checked: git log -S runFixtureRelex
  found: e0ee0bb feat(04-16) added `if (options.relex !== false) await runFixtureRelex(db)` in createFixtureDatabase, default on, independent of options.migrations
  implication: from 04-16 on, every createFixtureDatabase({ migrations: false }) caller fails before its own applyMigrations step

- timestamp: 2026-11-24T00:14:00Z
  checked: callers with migrations:false — schema-equality build(), schema-migrations withFixture(mode,{migrations:false}) (frozen setup), documents-versions createDb()
  found: all three apply migrations themselves after the fixture is built. schema-migrations '0304 backfills existing chunks' asserts dc.lexical_text IS NULL after migrations, i.e. it expects relex NOT to have run on the pre-migration fixture
  implication: intended contract is "migrations:false gives a pristine pre-migration DB"; relex is a post-migration step and must default off when migrations are skipped

- timestamp: 2026-11-24T00:20:00Z
  checked: new test tests/rag-db/fixture-relex.test.mts on unfixed code
  found: RED — 8 tests, 2 pass, 6 fail. migrations:false builds (folded and frozen setup, both modes) reject with rpc_failed:rag_relex_candidates; RelexInputError.rpcCode is undefined (expected '42883'). Default-build relex neighbour passes.
  implication: test reproduces the root cause and the visibility gap

- timestamp: 2026-11-24T14:00:00Z
  checked: after-fix runs of the three affected files
  found: zero rpc_failed occurrences in any log. schema-equality 11/19 (was 9/19), schema-migrations 26/28 (was 14/28), documents-versions 25/27 (was 0/27). The 'frozen setup plus migrations equals current setup plus migrations' upgrade-equality test passes in both modes.
  implication: relex root cause fixed; the remaining failures are assertions that never ran since 04-16 (or, for schema-migrations, a failure already present on baseline)

- timestamp: 2026-11-24T14:05:00Z
  checked: newly visible failure — schema-equality 'the frozen file was loaded as the setup' asserted sqlSha256 keys
  found: e0ee0bb also recorded sqlSha256['lexical_version:2'] unconditionally, i.e. claimed a relex that did not run on migrations:false fixtures
  implication: same 04-16 assumption; fixed in scope by recording the key only when relex runs (TDD: RED 4/8, GREEN 8/8)

- timestamp: 2026-11-24T14:30:00Z
  checked: git history of the newly visible schema/data failures
  found: 2313a77 (03-47 fold of Phase 3 into setup files, 11:06) predates e0ee0bb (12:14); setup defaults documents.source to config_upload, so documents-versions legacy seeds never carry 'upload' and 0302 records no legacy_source
  implication: the remaining failures are pre-existing drift masked by the relex error, not caused or fixed by this change

## Resolution

root_cause: "eval/harness/pglite-supabase.mts createFixtureDatabase (since e0ee0bb, plan 04-16) runs relex by default regardless of options.migrations. rag_relex_candidates/rag_relex_batch are created only by migration 0402 and are not in either setup file, so every createFixtureDatabase({ migrations: false }) caller (schema-equality build(), schema-migrations withFixture(migrations:false), documents-versions createDb) failed with SQLSTATE 42883 undefined_function before it could apply its own migrations; AND the harness RPC shim relabelled every Postgres error P0001 while RelexInputError dropped the code entirely, so the failure read as an opaque rpc_failed and stayed undiagnosed. Same commit also stamped sqlSha256['lexical_version:N'] even when no relex ran."
fix: "relex now defaults to (migrations !== false) and the lexical_version fingerprint is recorded only when relex runs; a migrations:false caller that wants relex applies migrations then calls runFixtureRelex(db) (or passes relex:true explicitly). pgliteRpcClient passes PGlite's SQLSTATE through (P0001 only when none). RelexInputError gains rpcCode (the RPC error's code) and appends it to the message; CLI output (error.code) unchanged."
oracle_type: specified (pre-migration fixture contract: no 0402 function, no relex, no fingerprint; default fixture: every chunk at LEXICAL_VERSION; failure carries SQLSTATE 42883)
verification:
  target_test: { result: pass, test: "tests/rag-db/fixture-relex.test.mts 8/8 (RED 6/8 before fix, RED 4/8 on fingerprint assertion before the key move)" }
  mutation_check: { result: pass, reason_if_skipped: "Stryker not installed; manual mutants at each fix site", mutant_killed: "M1 revert default to true (stash revert) killed; M2 default ?? false killed (2 fails); M3 harness code always P0001 killed (2 fails); M4 drop rpcCode in callRpc killed (2 fails)" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, note: "additive gating; the only removal is moving the fingerprint line inside the relex branch, justified by RCA (fingerprint must describe a relex that ran)" }
  adjacent_tests: { result: pass, suites_run: ["tests/rag-db/relex.test.mts 9/9", "tests/rag-db/lexical-index.test.mts 18/18", "tests/rag-db/harness-roles.test.mts 8/8", "tests/two-tenant-fixture.test.mts 8/8", "tests/fixture-edge.test.mts 42/44 (identical 42/44 on baseline: default fixture lexical_version key, pre-existing)", "vitest tests/rag/search-rpc-grants.test.ts + tests/rag/security-definer-search-path.test.ts 39/39", "node scripts/ci/check-rag-boundary.mjs ok", "npx tsc --noEmit -p tsconfig.json 0 errors", "tsc -p tsconfig.typecheck-new.json: 23 errors, none in touched files"] }
  revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true, note: "git stash of the two fix files: schema-migrations 14/28 and documents-versions 0/27 with rpc_failed; reapplied: 0 rpc_failed" }
  guardrail_verdict: accepted
newly_visible:
  - "schema-equality 'applying the migrations twice equals applying them once' (both modes): ACL entry order of rag_ingest_realtime_topic_allowed(text) flips (authenticated/service_role) on the second apply; catalogDump compares raw ACL text"
  - "schema-equality 'the dump has teeth' (both modes): last migration 0411 is a no-op on the folded setup (setup already has the fixed search_path), so leaving it out shows no difference"
  - "schema-equality 'setup equals the migrated schema' and 'setup is unchanged by re-applying migrations' (both modes): folded setup files lack the post-0319 objects (0320-0356 and 0401-0411: chunking_profiles/build_runs/gaps, lexical columns, relex/ingestion/parse-cache functions and grants...)"
  - "schema-migrations 'trigger functions are not callable by anon or authenticated' (both modes): rag_ingest_realtime_topic_allowed is EXECUTE-able by authenticated after migrations (also failing on baseline; not relex-related)"
  - "documents-versions legacy-only data GET and DELETE/PATCH: expected metadata.legacy_source 'upload' missing; the folded setup already defaults documents.source to config_upload, so the expectation only holds on the frozen setup"
  - "fixture-edge.test.mts:147/165 (outside scope, unchanged by this fix): default fixture sqlSha256 keys include lexical_version:2, which relex.test.mts:237 requires"
files_changed: [eval/harness/pglite-supabase.mts, src/lib/rag/ingest/relex/run.ts, tests/rag-db/fixture-relex.test.mts]
