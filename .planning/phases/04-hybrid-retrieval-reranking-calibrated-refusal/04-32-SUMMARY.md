---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 32
subsystem: ingestion
tags: [postgres, pglite, chunking, rechunk, cli, tenant-isolation, resumable-job]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: 04-31 buildProfileChunks, rag_write_profile_chunks, chunking_build_runs / chunking_build_gaps (0408); 04-07 chunking_profiles; 03-17 artifacts.ts parse.md; 03-36 re-embed job shape and cost module
provides:
  - runRechunk, runRechunkBatch, dryRunRechunk (src/lib/rag/ingest/rechunk/run.ts)
  - estimateRechunkCost (src/lib/rag/ingest/rechunk/cost.ts)
  - npm run rag:rechunk (src/lib/rag/ingest/rechunk/cli.ts)
  - nine rag_rechunk_* server functions (0412)
affects: [04-33, 04-34, 04-42]

status: complete
actuals:
  tokens: 25000
  tasks: 2
  commits: 7
  plan_head_before: 157641dfe365ddc619ae4e3e8334ca691c6c0cfd
  plan_head_after: e769d8a7f985c43de079555ce0e4b055fbdbc621

key-files:
  created:
    - supabase/migrations/0412_rechunk_functions.sql
    - src/lib/rag/ingest/rechunk/run.ts
    - src/lib/rag/ingest/rechunk/cost.ts
    - src/lib/rag/ingest/rechunk/cli.ts
    - tests/rag-db/rechunk.test.mts
  modified:
    - supabase/migrations/0410_security_definer_rpc_grants.sql
    - package.json

key-decisions:
  - "Selection predicate is the single source of truth: current ready documents of the profile's doc type with no current chunk in the profile (rag_rechunk_documents). A first build, a resume and the repair of an active profile are the same query, so nothing complete is rewritten or re-embedded."
  - "A run never moves a profile except building to ready in rag_rechunk_finish_run, and only when no current ready document of the type in any tenant lacks children. Activation (the pointer flip) stays with plan 04-33."
  - "Each document is written through createIngestWriter under the scope of its own tenant (backfillScope by default, injectable as scopeFor), so rag_write_profile_chunks checks tenant_key per document; a refused scope or a writer refusal becomes a failed gap, not a run failure."
  - "Active embedding target failure fails the run (resumable); a failing backfilling or previous target only leaves its vectors out with an embedding_gap warning."
  - "Exit codes: 0 done, 1 failed or database refusal, 2 bad request, 3 finished but documents still lack children."

requirements-completed: [CHK-04]
---

# Phase 4 Plan 32: Resumable side-by-side rechunk Summary

An operator can build a chunking profile for every current ready document of its doc type from the stored parse.md, with no parser, sidecar or LlamaParse call, resumably, per tenant, and can repair an active profile in place; documents without stored parse output are listed and recorded as gaps instead of being mixed in.

## What was built

1. **0412 (server functions).** `rag_rechunk_documents` (keyset selection, id order), `rag_rechunk_start_run` (also reuses the open run with `p_resume_open`), `rag_rechunk_get_run`, `rag_rechunk_resume_run`, `rag_rechunk_advance` (cursor and `docs_done`), `rag_rechunk_record_gap`, `rag_rechunk_finish_run` (completed, incomplete or failed; building to ready only when no current ready document of the type is missing children), `rag_rechunk_gaps`, and the internal count `rag_rechunk_missing`. All SECURITY DEFINER with `SET search_path = pg_catalog, public`, executable by service_role only; refusals raise `rechunk_refused: <reason>` with no row content.
2. **Job (Task 1).** `runRechunk` pages documents after the cursor, reads `parse.md` through `loadArtifact`, builds with `buildProfileChunks`, embeds the children for the active, backfilling and previous embedding profiles through the registry (legacy-column profile through the ingest embedder), writes parents, children and vectors of one document in one call, then advances the cursor. A document with no parse output (written before Phase 3, or an invalid key) is recorded as `no_parse_output`; an empty parse, unknown type, no children, or a writer refusal as `failed` with a reason word. `runRechunkBatch` continues the open run and stops after `maxDocuments` or when `deadlineMs` is spent (always after at least one document), peeking so the last call reports `completed` or `incomplete` instead of needing an empty extra call. `dryRunRechunk` opens no run, reads only parse.md, and reports per tenant eligible and gap documents, parents, children, cl100k_base tokens and cost from the Phase 3 price table summed over the target embedding profiles.
3. **CLI (Task 2).** `npm run rag:rechunk -- --profile <id> [--dry-run] [--tenant <key>] [--resume <runId>] [--batch-size 20] [--doc-type <type>]`; refuses without `SUPABASE_SERVICE_ROLE_KEY`; prints the dry-run table, progress, final summary and the gap list (tenant, document id, reason; never text).

## Verification

- `node --import tsx --test tests/rag-db/rechunk.test.mts`: 23/23 (14 job cases, 8 CLI cases including a spawned `--dry-run`, grants and static-import checks). Failed on assertions before each implementation commit (RED commits a53db43 and 56fe94a).
- The plan's acceptance case `rechunk repairs an active profile in place`: `# pass 1`, `# fail 0` (TAP).
- `npx vitest run tests/rag/ingest tests/rag/search-rpc-grants.test.ts tests/rag/security-definer-search-path.test.ts`: 49 files, 1001 tests pass.
- `node scripts/ci/check-rag-boundary.mjs`: no violations. `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts`: 8/8 after the 0410 change (see deviation 2).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Server functions needed (migration 0412)**
- **Issue:** the build-run tables are server-only and the job's client is RPC-only, so the selection, run cursor, gaps and the building to ready flip need SQL functions; the plan's file list has none.
- **Fix:** 0412 (next free number after 0411), SECURITY DEFINER, fixed search_path, service_role only.
- **Commit:** 2dbaa3a

**2. [Rule 1 - Bug] The 0410 upgrade re-lock did not cover the new functions**
- **Found during:** final verification (`tests/rag-db/search-rpc-grants-pglite.test.mts` upgrade case, together with the other definer-ACL files).
- **Issue:** on an upgraded database whose functions kept open grants, 0409 and 0410 left the nine rag_rechunk functions open.
- **Fix:** listed them in 0410's service-role section (the same step 04-31 took for rag_write_profile_chunks); added a grants and search_path test.
- **Files modified:** supabase/migrations/0410_security_definer_rpc_grants.sql, tests/rag-db/rechunk.test.mts
- **Commit:** e769d8a

**3. [Rule 1 - Bug] Boundary rule doc-type-branching tripped by a doc-type comparison in the CLI**
- **Fix:** CLI arguments validated without comparing a docType identifier. **Commit:** 41f3722

### Plan-level adjustments

- **Parse cache not wired.** The plan reads the Phase 3.1 parse cache "when its module exists"; no such module exists in `src/lib/rag/ingest`, so only `loadArtifact(.., 'parse.md')` is used. A later plan can add the cache as a fallback in `loadParseText`.
- **`--doc-type` flag added** (optional) because a chunking profile id is only unique per doc type; an id that exists for two types is refused as `profile_ambiguous` without it.
- **Embedding helper duplicated, not shared.** `embedForTarget` in `embed-write.ts` is bound to the stage context; to avoid editing 04-31 code that other executors may touch, rechunk has its own small version with the same checks (provider fits the profile, shape check, no embedding outside `@/lib/rag`).
- **`deadlineMs` is a duration from the call start**, as in `ingest()`.
- **Exit code 3** (incomplete) is new relative to the re-embed CLI.

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new service-role RPC surface | supabase/migrations/0412_rechunk_functions.sql | nine rag_rechunk_* functions; service_role only, tested (anon and authenticated cannot execute, fixed search_path, in 0410 re-lock). Documents are written only through rag_write_profile_chunks under each document's own tenant; the operator functions take tenant only as a filter. |

T-04-58 (documents without parse output mixed into a profile) is mitigated and tested: gaps are recorded, the dry run lists them, and the profile stays building while any exist.

## Deferred items

- **Image-caption chunks** (`chunk_kind = 'image'`, `source_images`) are still not carried into profile children (04-31 deferred item). Neither this plan nor the writer has a path for them; 04-33 must decide before activating a profile for documents that have image chunks.
- **A non-active embedding target that fails** leaves its vectors out with an `embedding_gap:<id>` warning but records no backfill gap: profile children have status `variant`, which the re-embed job does not select. Filling such vectors needs a rechunk rerun after deleting the children, or a re-embed selection that covers variant profile children.
- **Admin route** for `runRechunkBatch` is not part of this plan; the function and its report are ready for one.
- **Plan 04-33** names migration 0409, which exists; 0412 is now used as well, so its next free number is 0413. **Plan 04-42** (folding into the setup files) must include 0408 and 0412 and the 0410 additions.
- **Parse cache fallback** (Phase 3.1) is not wired; documents without parse.md stay gaps until re-ingested.
- Pre-existing failures, identical with 0412 removed (14 of 58 tests in `schema-migrations`, `schema-equality`-style migration replays: `rag_relex_candidates` RPC failure), and those listed in the 04-31 summary.

## Self-Check: PASSED

Files created exist (0412, run.ts, cost.ts, cli.ts, rechunk.test.mts) and the 7 plan commits are on exec/04-32.
