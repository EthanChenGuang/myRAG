---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 35
subsystem: api
tags: [typescript, nextjs-16, async-params, stripe, tsc-ratchet, vitest]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: tsc ratchet baseline and vitest harness (plan 02-01)
provides:
  - Zero tsc errors in the thirteen listed library and API files (18 before)
  - Seven dynamic route handlers (14 exported handlers) type params as a Promise and await it; 7 route-type errors from next typegen cleared
  - user/preferences PATCH answers 401 when no user resolves instead of a 500 from a null dereference
  - tests/routes/async-params.test.ts (14 cases) and tests/lib/misc-type-fixes.test.ts (8 cases)
affects: [02-36, tsc-ratchet, route-type-checks]

actuals:
  tokens: 11000
  tasks: 3
  commits: 5
plan_head_before: e308307fe9a17df0009fbdc60faacadf928e2603
plan_head_after: a741102c220c04763ee552bd1b7ed56534469284

tech-stack:
  added: []
  patterns:
    - "Dynamic route handlers: `{ params }: { params: Promise<{...}> }` and `await params` before the try block when the catch block needs the value"
    - "Route tests use a chainable fake query that records eq() calls and asserts them as single-line strings (multi-line vitest diffs break the TAP RED evidence parser)"

key-files:
  created:
    - tests/lib/misc-type-fixes.test.ts
    - tests/routes/async-params.test.ts
  modified:
    - src/app/api/config/models/route.ts
    - src/app/api/config/openrouter-model-info/route.ts
    - src/app/api/extract-name/route.ts
    - src/app/api/user/preferences/route.ts
    - src/lib/stripe.ts
    - src/lib/nango/document-adapter.ts
    - src/lib/audio-utils.ts
    - src/lib/elevenlabs-utils.ts
    - src/lib/temporal-metadata-extractor.ts
    - src/lib/title-generator-multimodal.ts
    - src/lib/title-generator.ts
    - src/lib/utils/date-grouping.ts
    - src/lib/utils/sanitize-title.ts
    - src/app/api/config/system-prompts/[lang]/route.ts
    - src/app/api/folders/[id]/route.ts
    - src/app/api/invites/[token]/route.ts
    - src/app/api/mcp/servers/[id]/route.ts
    - src/app/api/mcp/servers/[id]/test/route.ts
    - src/app/api/organizations/[id]/members/[userId]/route.ts
    - src/app/api/organizations/[id]/share/route.ts

key-decisions:
  - "Stripe apiVersion string '2025-01-27.acacia' kept; typed with `as Stripe.LatestApiVersion` and a one-line reason, because the installed typings only know a newer version and changing it changes payment API behaviour"
  - "Nango adapter keeps source 'nango' (stored value) and casts the metadata to the processor's parameter type instead of widening document-processor.ts, a file outside this plan"
  - "config/models: the createAdminClient import was never used, so it was removed rather than replaced with getSupabaseAdmin"

patterns-established:
  - "Async params: destructure the awaited params once at the top of the handler"

requirements-completed: [PIPE-01]

coverage:
  - id: D1
    description: "The thirteen library and API files type-check"
    requirement: PIPE-01
    verification:
      - kind: automated
        ref: "npx tsc --noEmit | grep for the thirteen files -> 0 matches"
        status: pass
  - id: D2
    description: "Seven dynamic routes read awaited params; next typegen reports no route-type errors"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/routes/async-params.test.ts (14 passed)"
        status: pass
      - kind: automated
        ref: "npx next typegen && tsc | grep -c '^.next/types' -> 0"
        status: pass
  - id: D3
    description: "Runtime fixes: null-user guard in preferences; Stripe version unchanged"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/lib/misc-type-fixes.test.ts (8 passed)"
        status: pass
---

# Phase 2 Plan 35: Remaining library, API and route-type fixes Summary

**Thirteen library and API files now type-check, and seven dynamic route handlers await their Promise `params` as Next 16 delivers them, with the pinned Stripe API version untouched.**

## Accomplishments

- Task 1: typed the API routes and server libraries (config/models, openrouter-model-info, extract-name, user/preferences, Stripe, Nango adapter); 8 tsc errors to 0.
- Task 2: typed the client and utility libraries without behaviour change (audio, ElevenLabs, temporal metadata, title generators, date and title utils); 10 tsc errors to 0.
- Task 3: async `params` in 14 handlers across seven files; the 7 `.next/types` route-type errors are gone and each handler has a test passing `params: Promise.resolve(...)`.
- Verification: full vitest run 17 files / 164 tests passed; `node scripts/ci/tsc-ratchet.mjs` reports "ok: 206 error(s), 14 file(s) improved" (baseline not edited). The 206 remaining errors are in files owned by other plans (for example `src/app/api/config/system-prompts/validate/route.ts`).

## Intended behaviour changes

- `PATCH /api/user/preferences` now returns `401 {"error":"Unauthorized"}` when the session exists but `auth.getUser()` resolves no user. Before, it threw a TypeError that was caught and returned 500.
- Dynamic routes (`config/system-prompts/[lang]`, `folders/[id]`, `invites/[token]`, `mcp/servers/[id]`, `mcp/servers/[id]/test`, `organizations/[id]/members/[userId]`, `organizations/[id]/share`) now read their path parameters from the awaited `params`. Before, the sync read yielded `undefined` under Next 16 (folder, invite, MCP and organization lookups used an undefined id; the language route always answered 400).
- No change to the Stripe API version sent at runtime ('2025-01-27.acacia'), the stored Nango `source` value, or any utility-library output (byte copies, same fallbacks).

## Task Commits

1. Task 1 RED: `65ea0b8` test(02-35): failing null-user test plus characterization tests
2. Task 1 GREEN: `9e069da` feat(02-35): type API routes and server libraries, guard null user
3. Task 2: `b2c3581` fix(02-35): type client and utility libraries without behaviour change
4. Task 3 RED: `d0fd636` test(02-35): failing async-params tests (14)
5. Task 3 GREEN: `a741102` feat(02-35): read awaited params in the seven dynamic route handlers

## TDD Evidence

- **Task 1 RED:** `npx vitest run tests/lib/misc-type-fixes.test.ts --reporter=tap-flat`, exit 1. Target "user/preferences PATCH > answers 401 JSON when the session has no resolvable user" failed with `expected 500 to be 401`. `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK`. Semantic assessment: the test executed and failed on the planned status assertion (a null user throws a TypeError caught as 500). The other seven tests in the file are characterization tests that pass before and after (Stripe version pin, config/models, extract-name, Nango source); they guard behaviour rather than drive new code, so they are green at RED by design.
- **Task 3 RED:** `npx vitest run tests/routes/async-params.test.ts --reporter=tap-flat --silent`, exit 1, all 14 tests failed on assertions (`expected 400/404 to be 200`, `id=undefined` instead of the awaited id, `[[null]]` instead of `[["org-1"]]`). `RED_EVIDENCE_OK`. Semantic assessment: every handler received `params` as a Promise and read the id synchronously, producing `undefined`, which is the planned failure.
- **GREEN:** both suites pass; refactor not needed.
- Task 2 is a non-TDD task in the plan (behaviour-preserving typing); it is covered by tsc and the full suite.

## Deviations from Plan

### Auto-fixed / adjusted

**1. [Rule 1 - Plan mismatch] config/models had no admin client usage**
- **Found during:** Task 1
- **Issue:** The plan said GET should reach the admin client through `getSupabaseAdmin`. `createAdminClient` was imported but never used (neither were `cookies`), so there is no admin call to redirect.
- **Fix:** Removed the dead imports. A characterization test asserts GET and POST validation work with the Supabase server module mocked empty. No runtime change.
- **Commit:** 9e069da

**2. [Rule 3 - Blocking] vitest test names with brackets defeat the RED classifier**
- **Found during:** Task 3 RED
- **Issue:** Suite names containing `[id]` and multi-line diff messages made the TAP report unparseable for `check tdd-red-evidence`.
- **Fix:** Suite labels use `:id` style and assertions compare single-line strings. Tests only.
- **Commit:** d0fd636

**3. [Rule 2 - Correctness] catch blocks in mcp/servers routes referenced `params.id`**
- **Issue:** After the signature change `params.id` would read a Promise inside catch blocks.
- **Fix:** `const { id } = await params;` placed before the `try` and reused in the log messages.
- **Commit:** a741102

## Known Stubs

None.

## Threat Flags

None. T-02-85 (undefined id in dynamic handlers) mitigated by awaited params and one test per handler; T-02-86 (Stripe API version) mitigated by the unchanged string and the characterization test that pins it.

## Self-Check: PASSED

All five commits are ancestors of HEAD; the listed source and test files exist; STATE.md, ROADMAP.md, REQUIREMENTS.md and scripts/ci/tsc-baseline.json untouched.
