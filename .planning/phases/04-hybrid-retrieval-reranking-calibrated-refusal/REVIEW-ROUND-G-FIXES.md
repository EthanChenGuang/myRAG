# Round G fixes

Branch `exec/fix-review-g`, base `f6859ae`. Each fix has its failing test committed first.

## Fixed

| Finding | Test commit | Fix commit | What changed |
| --- | --- | --- | --- |
| BLOCKER-1 | e874d7c | 5a9bea3 | `ledger.ts` `callRpc` normalises PostgREST answers: array, single object, bare scalar (`rag_record_parse_attempt`), null, and an all-null composite (no `id`) read as no row. Covers `enqueueJob`, `advanceJob`, `failJob`, `retryJob`, `deleteJob`, `getJobForScope`, `getJobForDocument`, `getJobInternal`, `recordAttempt`. The fake edge (`eval/harness/fake-edge.mts`) and the PGlite adapter in `tests/rag-db/ledger-client.test.mts` now answer non-SETOF composite functions with one object (checked through `proretset` and `typtype`), so the suites model PostgREST. With the old ledger the PGlite round-trip tests fail (6/6). |
| HIGH-1 | 9d56d5e | b56ad73 | `parseCloudAllowed`: unset or empty keeps the documented default (allowed); `true`, `1`, `yes`, `on` allow; `false`, `0`, `no`, `off`, `disabled` refuse; any other value refuses and warns once. `scripts/check-config.mjs` warns for every refusing value. |
| MEDIUM-1 | 7320f31 | 182d038 | `isOrganizationMember` takes optional roles; `resolveAdminWorkspaceScope` takes `requiredOrganizationRoles`; the admin ingest routes (list, detail, retry, delete) and parse-budget pass `owner`/`admin`. A plain member gets the same 403 as a non-member. A `job_not_found` refusal from the SQL (new `IngestLedgerError.reason`, a fixed token only) answers 404 instead of 409. Two-org tests for list, detail, retry, delete, budget. Other callers (uploads, `doc-type-defaults`) keep the any-membership rule. |
| MEDIUM-2, LOW-2 (precision, duplicates) | 7320f31 | 182d038 | Cursor compares the DB timestamp string at microsecond precision (`timestampMicros`, BigInt, no JS Date round trip). The scan dedupes by id and advances by rows fetched. Test: three rows differing only in microseconds page as 1, 2, 3 with limit 1. |
| MEDIUM-7 | 7320f31 | 182d038 | `listJobs` and `listJobsPage` require a minted scope (runtime `assertTenantScope`, type-level required). `listJobsAllTenants` is internal to `ledger.ts` and not exported from `@/lib/rag` (test asserts it). No caller used the unscoped form. |
| LOW-3 | 7320f31 | 182d038 | `listJobsPage` returns `{ jobs, fetched, skipped }`; a row failing the strict schema is skipped, counted, and logged as `[Ingest] ledger list skipped rows ...` with the count only. The route no longer answers 503 for one bad row and pages by `fetched`. |
| LOW-5 | 3071504 | bf4458e | `tempPathFor` in `document-processor.ts`: random UUID name plus the name's plain extension inside the temp dir; `../`, `/` and `\` never reach the path. The temp file is also removed after a failed parse (it was left on disk). |
| LOW-4 (file name logging) | 3071504 | bf4458e | `processDocument` and the process-document route no longer log the file name (before the guard or after). |

## Remains

- LOW-2 scan cost: a cursored request still re-reads from offset 0 (up to 100 RPCs, 10,000 row cap). The real fix is a SQL keyset (`p_before_created_at`, `p_before_id`) and needs a new migration; not done here to avoid a migration number clash with the running plans. Worth folding into the next ingest migration.
- LOW-4, second half: `processImageDocument` (GPT-4o vision) is still not gated by `assertCloudAllowed('vlm')`; a follow-up plan decision, as the review says.
- `claimJob` is not in `ledger.ts` (claim runs through SQL and the runner); the review's mention of it needs no change here. If `runner.ts` or `callbacks/*` read single-row RPC answers themselves, 03.1-22 should apply the same object-or-array handling (not touched, per instructions).
- Deferred by instruction: MEDIUM-3, MEDIUM-5, MEDIUM-6, LOW-1 (plans 04-32, 04-33, 03.1-34); MEDIUM-4 (product decision).
- `tests/fixture-edge.test.mts` has 2 failures (`lexical_version:2` extra row in the setup-file source list). They are unrelated to this branch (the assertion list is stale).
- Stray files from the failing-test-first run: the LOW-5 test, run before the fix as TDD requires, wrote probe files outside the temp dir. A removal was refused by the safety check, so these are left for a person to delete: `/traversal-probe-two.pdf`, `/probe-2e82a4e0-620b-446b-8a74-fa1e90912c48-two.pdf`, `/tmp/traversal-probe-one.pdf`, `/tmp/traversal-probe-three.pdf`, `/tmp/probe-2e82a4e0-620b-446b-8a74-fa1e90912c48-one.pdf`, `/tmp/probe-2e82a4e0-620b-446b-8a74-fa1e90912c48-three.pdf`, and two files whose names start with `..\` in `/tmp/myrag/`. The test uses a fresh random name per run, so leftovers do not affect it.

## Verification

- `npx vitest run tests/rag/ingest tests/rag/legacy-cloud-guard.test.ts tests/api`: 59 files, 1187 tests pass.
- `node scripts/ci/check-rag-boundary.mjs`: ok, 970 files scanned.
- `npx tsc --noEmit -p tsconfig.json`: no errors.
- `node --test scripts/check-config.test.mjs`: 24 pass.
- `tests/rag-db/ledger-client.test.mts` (6), `tests/rag-two-tenant.test.mts` (6), `tests/rag-legacy-differential.test.mts` (5) pass with the changed fake edge.
