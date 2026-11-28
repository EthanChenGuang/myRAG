---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 33
subsystem: rag-chunking
tags: [chunking-profiles, activation, rollback, pgvector, supabase, cli, parity]
requires:
  - phase: 04
    provides: chunking_profiles, rag_write_profile_chunks, rechunk job, hybrid_search_chunks, active.ts cache, generated Zod contracts
provides:
  - gated create, record-decision, activate and rollback SQL functions and the coverage count (migration 0413)
  - maxInputTokensFor in the embedding registry and the TypeScript chunking validator (parity with Pydantic)
  - profile-ops, exports on @/lib/rag and npm run rag:chunking
  - fixes for round F/G deferred items MEDIUM-3 (parent currency) and MEDIUM-5 (image and invoice-header chunks)
affects: [04-34, 04-36, 04-39, 04-42]
actuals:
  tokens: 36000
  tasks: 3
  commits: 6
plan_head_before: 045ae01e9143a12e637e25914c89b49eacca80fe
plan_head_after: 3caf029c11d1b54034f81ea8554da810e291efdd
commits: 6
tech-stack:
  added: []
  patterns:
    - "SECURITY INVOKER SQL functions with SET search_path = '' and schema-qualified names, service_role only"
    - "named gate refusals as chunking_activation_refused:<reason>"
key-files:
  created:
    - supabase/migrations/0413_chunking_activation.sql
    - src/lib/rag/chunking/validate.ts
    - src/lib/rag/chunking/profile-ops.ts
    - src/lib/rag/chunking/cli.ts
    - tests/helpers/chunking-profile-fixture.mts
    - tests/rag-db/chunking-activation.test.mts
    - tests/rag-db/profile-currency.test.mts
    - tests/rag-db/chunking-cli.test.mts
    - tests/rag/chunking/profile-validate.test.ts
  modified:
    - supabase/migrations/0410_security_definer_rpc_grants.sql
    - src/lib/rag/embeddings/registry.ts
    - src/lib/rag/index.ts
    - package.json
    - tests/rag/embeddings/registry.test.ts
key-decisions:
  - "Migration number 0413 (the plan's 0409 is taken; 0413 was reserved for this plan and was free)."
  - "Activation functions are SECURITY INVOKER with an empty search_path; only the parent-currency trigger on documents is SECURITY DEFINER (it must update document_parents for callers that cannot)."
  - "rag_activate_chunking_profile takes an optional p_doc_type because a profile id is only unique per doc type; legacy always needs it."
  - "Activating the already active profile is a no-op success (changed=false), so activating legacy always succeeds."
  - "document_parents.is_current follows the document (parent stays non-current while its document is), and rag_fetch_parents joins the current ready document."
  - "Legacy image and invoice_header chunks stay searchable under any effective profile (predicate added to hybrid_search_chunks) instead of copying them into every profile."
requirements-completed: [CHK-04, CHK-03]
duration: ~3h
completed: 2026-11-25
status: complete
---

# Phase 4 Plan 33: Chunking profile activation, rollback and rag:chunking Summary

A chunking profile built side by side can now be activated only when it is complete and its recorded eval passed, rolled back by a pointer flip, validated in TypeScript exactly like Pydantic, and driven from `npm run rag:chunking`; retrieval follows the pointer with tenants isolated in every state.

## What was built

1. **Migration 0413** (plan said 0409, taken). `rag_create_chunking_profile`, `rag_record_chunking_decision`, `rag_activate_chunking_profile(p_profile_id, p_actor, p_doc_type)`, `rag_rollback_chunking_profile`, `rag_chunking_coverage()` and `rag_chunking_profile_state()`. Gates in order: unknown_profile, ambiguous_profile, not_ready, incomplete, open_gaps, no_evidence, eval_failed, stale_evidence; rollback refuses `no_previous` only when legacy is active. Two null build run ids match. All six: invoker, `search_path = ''`, EXECUTE revoked from PUBLIC, anon, authenticated, granted to service_role.
2. **Registry and validator.** `maxInputTokensFor` (8191, 32000, 32768; throws for an unknown id and for names on Object.prototype); `validateChunkingProfile` passes every row of `chunking-profile-cases.json`, the default child limit follows the active embedding profile's provider.
3. **profile-ops, CLI, exports.** Admin-client-only ops with `ChunkingActivationRefused`, `admin_unavailable`, decision validation by `ChunkingDecisionSchema` before any call, cache refresh after each flip. CLI `status | create | record-decision | activate | rollback` (exit 0 done, 1 database/missing key, 2 bad input, 3 gate refusal).
4. **Deferred ledger items fixed here** (each with a failing-first test in `tests/rag-db/profile-currency.test.mts`):
   - MED-3: `document_parents.is_current` was always true. Now a BEFORE trigger keeps a parent non-current while its document is, an AFTER trigger on `documents` carries every is_current flip, existing rows are backfilled, and `rag_fetch_parents` joins the current ready document of the tenant (hides superseded, unpublished, quarantined, soft-deleted).
   - MED-5 and the round F 04-31 item: profile children are cut from parse text only, so under an active profile the document's legacy `image` and `invoice_header` rows were hidden (and `source_images` stopped). `hybrid_search_chunks` now keeps legacy rows of those two kinds searchable whatever profile is effective; no profile copy needed, no duplicates (profile children never carry those kinds). Existing data is covered without a rebuild.

## TDD

Three RED/GREEN pairs. RED evidence: `RED_EVIDENCE_OK` from the gsd classifier for `a superseded version loses its parents...` (profile-currency, single-tenant filter) and `activate refuses in order...` (chunking-activation); on old code the currency tests failed with `true !== false`, the quarantined-parent fetch returned a row, and the image chunk disappeared. RED commits: 3c033f84, baf2784e, 9ab60443. GREEN: da4d880c, fef909c3, 3caf029c. Tasks 2 and 3 RED commits carry empty stubs so tests fail on assertions rather than module-not-found.

## Verification

- `node --import tsx --test` on chunking-activation, profile-currency, chunking-cli (30 + 12 tests, both setup modes): pass. Named acceptance test `legacy-mode upload under an active profile`: `# pass 1`, `# fail 0` (`eval/out/p4-33-legacy-upload.tap`, git-ignored).
- `npx vitest run tests/rag/embeddings tests/rag/chunking tests/rag/search-rpc-grants.test.ts tests/rag/security-definer-search-path.test.ts`: 152 pass.
- Shared-code reruns after 0413: parents-fetch, parents-schema, hybrid-search, hybrid-tenant, hybrid-filters, profile-search, profile-chunk-writer, rechunk, search-rpc-grants-pglite, definer-search-path-pglite, schema-migrations: pass.
- `npx tsc --noEmit -p tsconfig.json`: exit 0. `check-rag-boundary.mjs` ok and its node test 38/38. `check-config.mjs` ok. `check-workflows.py` OK.
- `npm run test-rag -- --out eval/out/p4-33` and `--fixture-mode ingest`: gate PASS, `passed: true`, `paired.all_zero: true` (legacy parity unchanged).
- Not run, per the orchestrator's load instruction: full `vitest run`, full `tests/*.test.mts` and full `tests/rag-db/*.test.mts`; Python suites (no Python touched); `gen:schemas` (no contracts touched). CI is the gate.

## Deviations from Plan

**1. [Rule 3 - Blocker] Migration number.** 0409 is taken; used 0413. Acceptance greps targeted `0409_chunking_activation.sql`; run against 0413 with the same expectations: `chunking_activation_refused` 12, `FROM PUBLIC, anon, authenticated` 9, `rag_chunking_coverage` 4.

**2. [Rule 2 - Missing critical] Ledger items MED-3 and MED-5** fixed in 0413 as above; `0410_security_definer_rpc_grants.sql` gains `rag_sync_parent_currency()` in its service-role re-lock (same step 04-32 took), otherwise the upgrade inventory test fails.

**3. [Rule 2] `p_doc_type` on activate, `changed` in its result, no-op on the already active profile.** A profile id is unique only per doc type (04-32 already added `--doc-type`); without it activation by id alone is ambiguous. `ambiguous_profile` is an extra named refusal.

**4. [Rule 2] `rag_chunking_profile_state()`.** The plan's `status` must print open gaps and whether a passing decision is recorded; no existing function supplies them. Counts and words only, same grants. The open-gaps gate and this view count only gaps whose document is still current and ready, so a superseded or deleted document cannot block activation forever.

**5. Baseline moved: maxInputTokens.** Providers already declared `maxInputTokens` (8191, 32000, 32768, plans 03-xx), so no provider edit was needed; `registry.ts` gets `maxInputTokensFor` plus a static fallback table of `{ maxInputTokens: N }` lines (mirrors `KNOWN_DIMS`; test asserts it agrees with each provider). The `maxInputTokens:\s*[0-9]+` grep reaches 3 in registry.ts as planned.

**6. Parent currency semantics.** The BEFORE trigger sets `NEW.is_current AND document.is_current` (never forces true), because `parents-schema.test.mts` stores an explicit non-current old parent on a current document.

**7. validateChunkingProfile is asynchronous** (reads the active embedding profile, topK, budget); an input that fails the generated schema returns `invalid_shape` (TS-only code; Pydantic raises a validation error). Context keys are camelCase.

**8. Extra test files** (`tests/helpers/chunking-profile-fixture.mts`, `profile-currency.test.mts`) beyond the plan's four.

**Total deviations:** 8 (4 auto-added, 4 adjustments). **Impact:** none on the plan's truths; schema surface is 6 SQL functions instead of 5 and two triggers.

## Known limits

- A document with only image chunks (no parse output) can never get profile children, so `incomplete`/`no_parse_output` gaps keep such a doc type from activating until those documents are re-ingested; that is the conservative direction.
- `activated_by` is an admin user uuid or the word `cli` for command-line actions.
- Concurrent branch edits to `src/lib/rag/index.ts` and `package.json` (other executors) may need a trivial merge.

## Requirements and decisions for STATE

Requirements: CHK-04, CHK-03. Decisions: 0413 as the activation migration; invoker functions with empty search_path; `p_doc_type` on activate; parent currency follows the document; legacy image/invoice_header chunks always searchable.

## Operator actions

Apply migration 0413 (and the edited 0410 re-lock) to live databases. Plan 04-42 must fold 0413 into the setup files. Plans 04-34 and 04-36 call `activateChunkingProfile`, `rollbackChunkingProfile`, `getChunkingCoverage` and `getChunkingProfileState` from `@/lib/rag`.

## Self-Check: PASSED

Created files exist (migration, validate.ts, profile-ops.ts, cli.ts, four test files, helper) and the six plan commits are on exec/04-33.
