---
phase: 03-unified-ingestion-embedding-profiles
plan: 21
subsystem: embeddings
tags: [embeddings, active-profile, instrumentation, startup-check, registry, vitest]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: plan 03-08 registry (getEmbeddingProvider, canonicalModelId, supportedDims); plan 03-09 SQL gate functions (rag_activate_embedding_profile, rag_rollback_embedding_profile) and 03-09/0307 rag_list_embedding_profiles and rag_set_embedding_profile_status; plan 03-03 RAG_EMBEDDING_PROFILES switch and loadIngestConfig
provides:
  - getActiveProfile with the legacy constant while the switch is off and a 30 s cached registry read while on
  - refreshActiveProfile, getBackfillingProfiles (for dual-write) and ProfileUnavailableError (no silent legacy fallback)
  - profile-ops: getEmbeddingProfileStatus, activateEmbeddingProfile, rollbackEmbeddingProfile, setEmbeddingProfileStatus returning the gate refusal unchanged
  - src/instrumentation.ts register() with a time-boxed, never-throwing startup consistency check and a stored verdict (getStartupVerdict)
affects: [03-22, 03-26, 03-28, 03-36, 03-43]

actuals:
  tokens: 11525
  tasks: 2
  commits: 5
plan_head_before: cd7917bc9a09b5f0cb4923af9697ca5dc3c455ef
plan_head_after: d4b9625a2a101a395338ac5464c8a9b3c4197f55

tech-stack:
  added: []
  patterns:
    - "Module-level pointer cache with a generation counter: a read that started before an invalidation never repopulates the cache, concurrent callers share one in-flight read, a failed read is never cached"
    - "Startup check memoised per process (one run, one log line per instance), raced against a 3 s timer, late results discarded"
    - "Gate refusals are recognised by the SQL message prefix (activation_refused, rollback_refused, profile_status_refused) and returned as { ok: false, reason, detail }; any other RPC failure throws ProfileUnavailableError"

key-files:
  created:
    - src/lib/rag/embeddings/active-profile.ts
    - src/lib/rag/embeddings/profile-ops.ts
    - src/instrumentation.ts
    - tests/rag/embeddings/active-profile.test.ts
    - tests/rag/instrumentation.test.ts
  modified:
    - src/lib/rag/index.ts

key-decisions:
  - "The admin client and the clock come from RagDeps as the plan says, but the RAG_EMBEDDING_PROFILES switch is read through getIngestDeps().ingestEnv() + loadIngestConfig, because RagDeps.ragEnv carries no such key and widening RagEnvInput would have touched config.ts"
  - "getActiveProfile with the switch on and an unreadable registry throws ProfileUnavailableError (reasons no_admin_client, read_failed, read_timeout, no_active_profile, multiple_active_profiles, malformed_active_profile, rpc_failed); it never returns the legacy profile"
  - "Registry read has its own 5 s timeout so a hung database cannot hang a retrieval request; the 30 s cache age is measured from the start of the read"
  - "Operations work whatever the switch says (an operator prepares a flip while off); getEmbeddingProfileStatus reports switch, the effective active profile (legacy while off), the registry rows read fresh, and the startup verdict"
  - "Startup verdict statuses: unknown (not checked, timeout or registry unavailable), skipped (switch off), ok, mismatch. The mismatch reasons are checked in the order provider_unconfigured (unknown provider or key absent), model_mismatch (canonical model ids differ), dims_unsupported"
  - "Key presence is checked per provider: openai needs OPENAI_API_KEY, voyage VOYAGE_API_KEY, qwen3 DEEPINFRA_API_KEY (the primary host; the OpenRouter key alone cannot embed). Only presence is read; no key value reaches a log line or a verdict"
  - "register() and verifyActiveEmbeddingProfileAtStartup never reject; an import or check failure is swallowed, a non-timeout registry failure logs one console.warn `[Embedding Profile] STARTUP CHECK UNAVAILABLE {reason}`"

patterns-established:
  - "Exact operator-searchable log strings: `[Embedding Profile] MISMATCH {profile,model,dims,reason}` (console.error, once per instance) and `[Embedding Profile] STARTUP CHECK TIMEOUT {timeoutMs}` (console.warn, once)"

requirements-completed: [EMB-02, EMB-03]

coverage:
  - id: D1
    description: "Active profile pointer: legacy constant with no database read while off; registry read through rag_list_embedding_profiles on the admin client with a 30 s cache and forced refresh while on; backfilling profiles exposed for dual-write"
    requirement: EMB-03
    verification:
      - kind: unit
        ref: "tests/rag/embeddings/active-profile.test.ts#getActiveProfile with the switch off / with the switch on"
        status: pass
    human_judgment: false
  - id: D2
    description: "A registry that cannot be read gives a typed ProfileUnavailableError and is never replaced by the legacy profile or cached"
    requirement: EMB-03
    verification:
      - kind: unit
        ref: "tests/rag/embeddings/active-profile.test.ts#a registry read that cannot give a pointer"
        status: pass
    human_judgment: false
  - id: D3
    description: "Profile operations status, activate, rollback and set-status over the 03-09 SQL functions, returning the gate's distinct refusal reason unchanged and refreshing the pointer on success"
    requirement: EMB-02
    verification:
      - kind: unit
        ref: "tests/rag/embeddings/active-profile.test.ts#profile operations"
        status: pass
    human_judgment: false
  - id: D4
    description: "Startup check in register(): exact MISMATCH error line once per instance with profile, model, dims and reason and no key; STARTUP CHECK TIMEOUT warning within 3 s on a hanging read; verdict stored; never rejects; skipped when the switch is off or the runtime is not nodejs"
    requirement: EMB-03
    verification:
      - kind: unit
        ref: "tests/rag/instrumentation.test.ts#register (startup embedding profile check)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Next.js actually calls src/instrumentation.ts register() once when a real server instance starts and the MISMATCH line shows in the runtime logs"
    requirement: EMB-03
    verification: []
    human_judgment: true
    rationale: "The tests call register() directly; no running Next server was started in this worktree, so the framework hook itself is unobserved"

duration: 9min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 21: Active embedding profile pointer and startup check Summary

**A deployment-level active embedding profile pointer (legacy constant when RAG_EMBEDDING_PROFILES is off, 30 s cached registry read when on), gate-returning profile operations, and a time-boxed never-throwing startup check in src/instrumentation.ts that logs one exact `[Embedding Profile] MISMATCH` line per instance**

## Performance

- **Duration:** about 9 min
- **Started:** 2026-11-24T02:24Z (approximate, start time was not captured by script)
- **Completed:** 2026-11-24T02:33Z
- **Tasks:** 2
- **Files modified:** 6 (5 created, 1 modified)

## Accomplishments

- `getActiveProfile()` returns the frozen legacy constant (id openai-3-small-1536, 1536 dims, legacy_column, today's four thresholds) with no database call while the switch is off. With it on it reads `rag_list_embedding_profiles` on the admin client, caches for 30 s on `deps.now()`, shares one read between concurrent callers, drops the cache on `refreshActiveProfile()` and after every gate operation, and throws `ProfileUnavailableError` when the registry cannot be read (never a silent legacy fallback).
- `getBackfillingProfiles()` serves the dual-write list from the same cached read; `[]` with no read while off.
- profile-ops wraps `rag_activate_embedding_profile`, `rag_rollback_embedding_profile` and `rag_set_embedding_profile_status`. A refusal such as `activation_refused: incomplete (3 current ready chunks ...)` comes back as `{ ok: false, reason: 'activation_refused: incomplete', detail: <full message> }`; permission or transport errors throw instead of passing as refusals.
- `src/instrumentation.ts` `register()` runs only on `NEXT_RUNTIME === 'nodejs'`, dynamically imports `@/lib/rag` and awaits `verifyActiveEmbeddingProfileAtStartup()`. The check is raced against 3 s, memoised per process, and records `getStartupVerdict()`. Mismatch: one `console.error` with a single string `[Embedding Profile] MISMATCH {"profile","model","dims","reason"}`; timeout: one `console.warn` `[Embedding Profile] STARTUP CHECK TIMEOUT {"timeoutMs":3000}` and verdict unknown. Tests assert no key string appears in any logged argument.

## Task Commits

1. **Task 1: Active profile pointer and profile operations**
   - RED `491369f` (test): 23 tests, 21 failed on assertions, 2 passed (the two switch-off cases, which the neutral stub satisfies)
   - GREEN `ae23c70` (feat): 23 passed; exports added to `@/lib/rag`
2. **Task 2: Startup check in src/instrumentation.ts**
   - RED `bac3f48` (test): 9 tests, 8 failed on assertions, 1 passed (the edge no-op case)
   - GREEN `db3dabd` (feat): 9 passed
   - REFACTOR `d4b9625` (refactor): documented positive `=== 'nodejs'` branch, no behaviour change

**Plan metadata:** the SUMMARY commit follows this file (docs).

## RED evidence

The plan is `type: execute` with task-level `tdd="true"`, so the `tdd-red-evidence` classifier was not run. RED was confirmed by hand: the stub modules export the real types and neutral values, so every failing test fails on an `AssertionError` for the planned behaviour (for example `expected 'off' to be 'on'`, `expected "error" to be called 1 times, but got 0 times`, `promise resolved ... instead of rejecting`), never on a module-not-found or syntax error.

## Files Created/Modified

- `src/lib/rag/embeddings/active-profile.ts` - pointer cache, switch check, ProfileUnavailableError, LEGACY_PROFILE, startup verdict and check
- `src/lib/rag/embeddings/profile-ops.ts` - status, activate, rollback, set-status over the SQL functions
- `src/instrumentation.ts` - `register()` startup hook
- `src/lib/rag/index.ts` - one separate export block inserted after the `embedText, embedBatch` line (not appended at the end of the file, so it does not sit next to 03-13b's appended ingest exports); nothing reordered or reformatted
- `tests/rag/embeddings/active-profile.test.ts` - 23 tests with a fake RpcClient and a fake clock
- `tests/rag/instrumentation.test.ts` - 9 tests with console spies, fake timers for the hang case and provider overrides

## Decisions Made

See `key-decisions` above. The two that matter most for later plans: the switch is read through the ingest deps seam (tests of 03-22/03-26 override it with `setIngestDepsForTests({ ingestEnv })`), and an unreadable registry is an error (`ProfileUnavailableError`), which plan 03-26 must turn into retrieval status `error`.

## Deviations from Plan

### Interpretation and ordering notes (no rule-based auto-fix was needed)

**1. [Ordering] Startup-check logic landed in the Task 1 GREEN commit**
- **Found during:** Task 1 (the pointer and the verdict live in one module, `active-profile.ts`, which the plan lists in both tasks)
- **Impact:** `verifyActiveEmbeddingProfileAtStartup`, `getStartupVerdict` and the two log strings were committed in `ae23c70` before their tests; Task 2's RED was the no-op `register` stub, and those paths are covered by `tests/rag/instrumentation.test.ts` from `bac3f48` on. The code was not changed to fit the tests afterwards except for a test-typing fix.

**2. [Rule 2 - Missing critical] Non-timeout registry failure at startup logs a warning**
- **Found during:** Task 2
- **Issue:** the plan only specifies the MISMATCH and TIMEOUT lines; a registry that is unreachable or has no active row (migration not applied) would leave the operator with no startup signal.
- **Fix:** one `console.warn` `[Embedding Profile] STARTUP CHECK UNAVAILABLE {"reason":...}` carrying the reason code only (no error text), verdict unknown with reason `profile_unavailable`. Asserted in the never-rejects test.

**3. [Interpretation] Edge runtime leaves the verdict `unknown` (reason `not_checked`), not `skipped`**
- The plan's behaviour line says the verdict is skipped for "switch off or NEXT_RUNTIME edge". On edge `register()` does not import `@/lib/rag` at all (it must not pull Supabase and Node modules into the edge bundle), so it cannot record anything; the test asserts nothing is read or logged and the verdict is `unknown / not_checked`. With the switch off the verdict is `skipped`.

**4. [Interpretation] Switch read through IngestDeps**
- See key-decisions. The admin client and `now` still come from RagDeps.

**Total deviations:** 0 rule-triggered auto-fixes beyond note 2 (Rule 2); the rest are ordering and interpretation notes.
**Impact on plan:** none on the delivered behaviour; every must_haves truth holds.

## Issues Encountered

None. `tests/rag/langfuse-pins.test.ts` ran and passed in this worktree (no ENOENT).

## Known Stubs

None. The RED stubs were replaced by the real implementations.

## Gate results (worktree /home/user/wt/03-21, branch exec/03-21)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 122 files, 1573 tests passed, 0 failed |
| `node --import tsx --test tests/*.test.mts` | 143 passed, 0 failed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 675 files scanned |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables match the manifest |
| `npm run typecheck:new` | no Phase 1 type errors |
| rag-sidecar pytest | not run (rag-sidecar untouched) |

Plan acceptance criteria: `rag_list_embedding_profiles` in active-profile.ts = 2 (>=1); `export async function register` in src/instrumentation.ts = 1 (==1); `[Embedding Profile] MISMATCH` = 1 (>=1); `STARTUP CHECK TIMEOUT` = 1 (>=1); active-profile tests 23 passed (>=6); instrumentation tests 9 passed (>=7).

## Threat Flags

None. No new network endpoint or auth path; the registry is read with the service role through functions already granted to `service_role` only. Threat register T-03-59 (30 s cache, refresh after gate operations; the RPC-side active check is plan 03-26), T-03-60 (presence-only key checks, test asserts no key string in log output) and T-03-61 (3 s race, never throws) are mitigated as planned.

## User Setup Required

None - no external service configuration required and no new environment variable (the config sync rule has nothing to mirror).

## Next Phase Readiness

- Plan 03-26 can call `getActiveProfile()` per request, catch `ProfileUnavailableError` and map `getStartupVerdict().status === 'mismatch'` to status `error` / reason `embedding_profile_mismatch`, and retry once after `refreshActiveProfile()` when the database reports the profile is no longer active.
- Plans for dual-write (D-39) can use `getBackfillingProfiles()`; the CLI and admin routes (03-28 / 03-36) can use the profile-ops functions; 03-43 can show `getEmbeddingProfileStatus().startup`.
- Before the switch is turned on in a deployment, migrations 0307 and 0309 must be applied; otherwise startup logs `STARTUP CHECK UNAVAILABLE` and every `getActiveProfile()` throws.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*

## Self-Check: PASSED

- Files exist: active-profile.ts, profile-ops.ts, src/instrumentation.ts, both test files, 03-21-SUMMARY.md
- Commits present on exec/03-21: 491369f, ae23c70, bac3f48, db3dabd, d4b9625
- Acceptance greps and all gates above re-run after the last code commit
