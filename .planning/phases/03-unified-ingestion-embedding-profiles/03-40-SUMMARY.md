---
phase: 03-unified-ingestion-embedding-profiles
plan: 40
subsystem: embeddings
tags: [embedding-profiles, activation-gate, rollback, admin-routes, cli, pglite, vitest, tdd]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "profile-ops and the active-profile cache (03-21), the gated rag_activate/rollback/set_status SQL functions (03-07, 03-09), the re-embed job, rag_reembed_count and createReembedWriter (03-36), the admin route pattern (03-37)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "checkAdmin, requireAdminOrDeny, adminDenied (src/lib/admin-route-auth.ts), requireAdminRequest, admin_users"
provides:
  - "npm run rag:embedding -- status | activate <id> | rollback | set-status <id> available|backfilling|retired (src/lib/rag/embeddings/cli.ts)"
  - "GET /api/rag/admin/embedding-profiles, POST /api/rag/admin/embedding-profiles/{id}/activate, POST /api/rag/admin/embedding-profiles/rollback, all behind the shared admin guard"
  - "getEmbeddingProfileCompleteness and the ProfileCompleteness type, exported from @/lib/rag (per-profile completeness over rag_reembed_count)"
affects: [03-43, 03-46, 03-47, 03-48]

actuals:
  tokens: 16197
  tasks: 2
  commits: 4
plan_head_before: 694b6962ca4a492006eb34ddd0c0bb7471b99109
plan_head_after: 561e37cd903ab19572aa9d1eafd9631a9b7cdfec

tech-stack:
  added: []
  patterns:
    - "Operator CLIs take no business logic of their own: they parse, call profile-ops, print the gate's refusal word and detail, and map the outcome to exit 0 (done), 1 (refused or registry unreachable), 2 (bad arguments)"
    - "Admin routes answer a gate refusal with 409 and only the reason word (plus a numeric missing_chunks for incomplete), an unknown profile with 404, and anything the gate did not name with a generic 503; the SQL message never leaves the process"
    - "Inert RED stubs for TDD: the CLI stub returns exit 1 with no output, the route stubs return 501, so every RED test fails on an assertion and never on a missing module"

key-files:
  created:
    - src/lib/rag/embeddings/cli.ts
    - src/app/api/rag/admin/embedding-profiles/route.ts
    - src/app/api/rag/admin/embedding-profiles/[id]/activate/route.ts
    - src/app/api/rag/admin/embedding-profiles/rollback/route.ts
    - src/app/api/rag/admin/embedding-profiles/_responses.ts
    - tests/rag-db/embedding-cli.test.mts
    - tests/rag/embedding-profile-routes.test.ts
  modified:
    - src/lib/rag/embeddings/profile-ops.ts
    - src/lib/rag/index.ts
    - package.json

key-decisions:
  - "The activation gate stays the only door: neither the CLI nor the routes check completeness, evidence or status themselves. They call activateEmbeddingProfile and rollbackEmbeddingProfile, which run the single SQL transaction, and surface its named refusal. set-status refuses 'active' at argument parsing (exit 2, points to activate) and the SQL refuses it again"
  - "The CLI actor is cli:<operating system account>, reduced to [A-Za-z0-9._-] and 64 characters (cli:operator when unknown); the routes' actor is only the userId of the ok checkAdmin result, never a header, the body or the cookie text. The activate and rollback bodies are strict and empty, so an actor key is a 400"
  - "Completeness reuses createReembedWriter().count (rag_reembed_count) as 03-36 intends, so no SQL function name appears outside the writer. A profile whose count cannot be read is reported unavailable, never complete. The route computes it only for ?completeness=true because the count scans the corpus"
  - "A flip with RAG_EMBEDDING_PROFILES off still works (operators prepare it), and the CLI says in status, activate and rollback that queries keep using the legacy profile until the switch is on"
  - "The route list returns has_evidence only, never an evidence body, a score calibration or a query instruction"

patterns-established:
  - "Route refusal mapping in a shared _responses.ts next to the routes (same shape as the quarantine routes' file)"

requirements-completed: [EMB-02, EMB-05]

coverage:
  - id: D1
    description: "rag:embedding status lists every profile with status, dims, storage, per-profile completeness (halfvec profiles from the re-embed count, the legacy column marked as counted by the gate) and whether evidence exists, plus the switch and the active profile"
    requirement: EMB-02
    verification:
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#status lists the five seeded profiles with status, dims, storage, completeness per profile and whether evidence exists"
        status: pass
    human_judgment: false
  - id: D2
    description: "activate and rollback call the gated SQL functions; every refusal (incomplete with its count, model_mismatch, eval_missing, eval_target_mismatch, eval_baseline_mismatch, eval_failed, pre_migration_missing, eval_run_mismatch, eval_stale, unknown_profile, already_active, rollback no_previous and incomplete) is printed by name with a non-zero exit and moves nothing"
    requirement: EMB-05
    verification:
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#every gate refusal is shown by name and exits non-zero, and nothing moves until the evidence is right"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#activate on an incomplete profile exits non-zero, prints the named refusal with the missing count and leaves the pointer alone"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#a rollback to a profile that lost vectors is refused by name"
        status: pass
    human_judgment: false
  - id: D3
    description: "One full cycle on PGlite through the fake edge: re-embed backfill, passing evidence, activate through the CLI, retrieval on the new profile (profile RPC, 2048-dimension queries), rollback, retrieval on the legacy profile again, each tenant seeing only its own document throughout; a second rollback is refused"
    requirement: EMB-02
    verification:
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#the full cycle: backfill, evidence, activate, retrieval on the new profile, rollback, retrieval on the legacy profile, with the same tenant isolation"
        status: pass
    human_judgment: false
  - id: D4
    description: "set-status moves a profile between available, backfilling and retired and never sets active; every flip refreshes the in-process active-profile cache; the CLI warns when RAG_EMBEDDING_PROFILES is off"
    requirement: EMB-05
    verification:
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#set-status moves a profile between available, backfilling and retired and never sets active"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#after a re-embed run and passing evidence activate exits 0, records the actor and refreshes the cached pointer"
        status: pass
      - kind: integration
        ref: "tests/rag-db/embedding-cli.test.mts#status and the flips say so when the deployment switch is off"
        status: pass
    human_judgment: false
  - id: D5
    description: "The three admin routes fail closed before any profile operation: 401 without a credential or with a forged, unsigned or session-less cookie, 403 for a non-admin session, bearer token or validly signed cookie of a non-admin, 503 when the auth or admin_users lookup throws; a signed cookie with its live admin session and an admin bearer token are admitted"
    requirement: EMB-02
    verification:
      - kind: unit
        ref: "tests/rag/embedding-profile-routes.test.ts#fails closed (describe.each over list, activate, rollback: 6 cases each)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Activate and rollback record the verified admin as the actor and nothing else (a header, a body key or the cookie text is ignored or refused), return 200 on success, 404 for an unknown profile, 409 with the gate's reason word for every other refusal and 503 without database text for anything the gate did not name; ids are validated (400)"
    requirement: EMB-05
    verification:
      - kind: unit
        ref: "tests/rag/embedding-profile-routes.test.ts#activates a profile / refuses an actor or any other key / gives 400 to a malformed profile id / gives 404 to an unknown profile and 409 / fails closed when the gate answers with anything it does not name / rolls back"
        status: pass
    human_judgment: false
  - id: D7
    description: "The list returns every profile without evidence bodies, with per-profile completeness only on request, and every successful flip through the routes refreshes the in-process pointer cache (a refusal does not)"
    requirement: EMB-02
    verification:
      - kind: unit
        ref: "tests/rag/embedding-profile-routes.test.ts#lists the profiles ... / adds the completeness per profile only when asked ... / refreshes the in-process active-profile cache after every successful flip, and not after a refusal"
        status: pass
    human_judgment: false
  - id: D8
    description: "The Config UI panel (03-43) driving these routes with the admin session, and a real Supabase project with real provider keys behind the flip"
    verification: []
    human_judgment: true
    rationale: "The panel does not exist yet and no live project is reachable; PGlite, the fake edge and fake providers prove the gate, the routes and the cycle only"

duration: 26min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 40: Embedding profile admin routes and CLI Summary

**`npm run rag:embedding` (status, activate, rollback, set-status) and three admin-only routes drive the gated embedding-profile pointer flip, print or return the gate's named refusal on every failure, and record only the verified admin as the actor; a PGlite cycle proves backfill, activate, retrieval on the new profile, rollback and retrieval on the legacy profile with tenant isolation intact**

## Performance

- **Duration:** about 26 min (start time was not recorded at launch; estimated from the first read, about 09:05Z)
- **Completed:** 2026-11-24T09:31Z
- **Tasks:** 2 (each a RED and GREEN pair)
- **Files modified:** 10 (7 created, 3 modified), 1203 insertions, 0 deletions

## Accomplishments

- **CLI.** `status` prints the switch, the effective active profile and one line per profile: `status=`, `dims=`, `storage=`, `completeness=` (percent and counts for the four vector-table profiles, from the re-embed count) and `evidence=yes|no`. `activate <id>` and `rollback` call the gate; a refusal prints `refused: activation_refused: incomplete` and the gate's detail line (with the missing count) and exits 1; success exits 0. `set-status` accepts available, backfilling and retired only and exits 2 on `active`. Bad arguments exit 2 with the usage before any request leaves the process. With the switch off the operator is told queries still use the legacy profile.
- **Routes.** `GET /api/rag/admin/embedding-profiles` (requireAdminOrDeny, optional `?completeness=true`), `POST .../{id}/activate` and `POST .../rollback` (checkAdmin first, `adminDenied(result.status)`, actor from `result.userId`). 200 on success, 400 for a bad id or body, 404 for an unknown profile, 409 with `{ success: false, error, reason, missing_chunks? }` for every other named refusal, 503 for anything the gate did not name, with no database text in the body or the logs.
- **Fail-closed proof.** The six-case deny matrix runs against all three routes; a mutation check (actor taken from an `x-actor-id` header) was caught by the actor test and reverted.
- **Full cycle.** The PGlite test runs the re-embed job, records passing evidence, activates through the CLI, retrieves for three tenants on the new profile (profile RPC, 2048-dimension query embeddings, no legacy search), rolls back, retrieves again on the legacy profile, and shows a second rollback refused.

## Task Commits

1. **Task 1: rag:embedding CLI** - RED `74129bb` (test, inert CLI stub, 9 tests failing on assertions), GREEN `fd630a0` (feat, 9 passing)
2. **Task 2: Admin routes** - RED `38f848f` (test, inert 501 route stubs, 30 tests failing on assertions), GREEN `561e37c` (feat, 30 passing)

**Plan metadata:** the docs commit that adds this file.

## Files Created/Modified

- `src/lib/rag/embeddings/cli.ts` - argument parser, `main`, the `cli:<account>` actor, status rendering
- `src/app/api/rag/admin/embedding-profiles/route.ts` - list
- `src/app/api/rag/admin/embedding-profiles/[id]/activate/route.ts` - activation
- `src/app/api/rag/admin/embedding-profiles/rollback/route.ts` - rollback
- `src/app/api/rag/admin/embedding-profiles/_responses.ts` - no-store JSON, 400, 503 and refusal mapping, the profile id pattern
- `src/lib/rag/embeddings/profile-ops.ts` - `getEmbeddingProfileCompleteness`
- `src/lib/rag/index.ts` - two export lines at the end of the file
- `package.json` - `rag:embedding` (the `rag:reembed` and `reprocess-docs` lines from 03-36 are untouched)
- `tests/rag-db/embedding-cli.test.mts`, `tests/rag/embedding-profile-routes.test.ts`

## Decisions Made

See `key-decisions` above. The ones other plans depend on: the gate is the only door, the actor is never caller-supplied, route refusals carry the reason word only, and completeness is opt-in on the list.

## Deviations from Plan

**1. [Plan text vs shipped guard] A signed `admin_session` cookie alone is not admitted**
- **Found during:** Task 2 (reading `requireAdminCookie` in `src/lib/admin-session.ts`)
- **Issue:** the plan's behaviour list says a valid signed cookie of an admin with no Supabase session and no Authorization header is admitted. The merged S7 guard requires the cookie and a matching live Supabase session (signing out ends the admin capability at once); without a session it answers 401 and falls through to the Bearer/session guard, which also answers 401. The 03-37 routes and tests follow the shipped guard.
- **Fix:** none to the guard (the plan forbids a second guard). The tests admit a signed cookie together with its live session and a bearer token of an admin, and assert 401 for a signed cookie without the session, 403 for a signed cookie of a non-admin, 503 for a throwing lookup. This is stricter than the plan text, never weaker. The Config UI always has both.
- **Files modified:** `tests/rag/embedding-profile-routes.test.ts`
- **Committed in:** `38f848f`

**2. [Rule 3 - Blocking] The legacy column's completeness is not counted outside the gate**
- **Found during:** Task 1 (`status`)
- **Issue:** the plan wants completeness for every profile. For the legacy column the count is `document_chunks.embedding IS NULL`, which no existing SQL function exposes (rag_reembed_count joins chunk_embeddings, so it would call the legacy profile empty). A new function would need a migration, and 0317, 0318 and 0319 belong to 03-39, 03-46 and 03-41a with 03-47 folding 0301-0318; the fake edge also cannot express `embedding IS NULL`, so a PostgREST read would be untestable here.
- **Fix:** status prints `completeness=legacy column, counted by the gate at activation`; the route returns `{ state: 'legacy_column' }`. The gate itself counts it inside the flip and rollback transaction and names `incomplete` with the count, which the CLI test shows (`a rollback to a profile that lost vectors is refused by name`). The four halfvec profiles have exact percentages.
- **Files modified:** `src/lib/rag/embeddings/cli.ts`, `src/lib/rag/embeddings/profile-ops.ts`
- **Committed in:** `fd630a0`

**3. [Additions beyond files_modified]**
- `src/app/api/rag/admin/embedding-profiles/_responses.ts` (shared refusal mapping, same pattern as the quarantine routes), `getEmbeddingProfileCompleteness` in `profile-ops.ts` and two export lines in `src/lib/rag/index.ts`. Committed in `fd630a0` and `561e37c`.

**4. [Process] Branch allow-list**
- The per-commit guard's positive allow-list expects an `agent-*` branch name; this worktree is on the orchestrator-named `exec/03-40`, which the brief says not to change. HEAD was asserted to be neither detached nor a protected or default branch before every commit.

---

**Total deviations:** 2 plan-vs-reality adjustments (1 stricter-than-plan, 1 blocking-by-ownership), 1 additions note, 1 process note
**Impact on plan:** no weaker security than planned; the only reduced scope is legacy-column completeness in the status view, covered by the gate itself.

## Issues Encountered

- The two-tenant fixture holds 74 current ready chunks, not 3, so the tests compute expected counts and percentages from the database instead of hard-coding them.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 158 files, 2382 tests passed (including tests/rag/langfuse-pins.test.ts, no ENOENT) |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node --import tsx --test tests/rag-db/embedding-cli.test.mts` | 9 passed, 0 failed |
| `node --import tsx --test tests/rag-db/reembed.test.mts tests/rag-db/activation-gate.test.mts` (with the CLI test) | 75 passed, 0 failed |
| `npx vitest run tests/rag/embedding-profile-routes.test.ts` | 30 passed |
| `npx vitest run tests/api/admin-auth.test.ts tests/api/config-admin-routes.test.ts` (plan verification) | passed (within an 8-file, 179-test run with the quarantine and embeddings suites) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables match |
| rag-sidecar pytest | not run: nothing under rag-sidecar/ was touched |

Acceptance greps: `"rag:embedding"` in package.json 0 -> 1; route files naming checkAdmin or requireAdminOrDeny 0 -> 3; `requireRagAdmin` in the route files 0; `mintAdminSessionValue` in the route test 0 -> 5; route test 30 passed (needs 11); CLI test 9 passed (needs 5).

## TDD Gate Compliance

Both tasks: a `test(03-40)` RED commit precedes its `feat(03-40)` GREEN commit. RED evidence: the CLI stub made all 9 tests fail on assertions (exit codes and missing output; the tests reached the CLI, so setup and the baseline retrieval worked); the 501 route stubs made all 30 route tests fail on `expected 501 to be 401/403/503/200/409` or a source-grep assertion. Semantic assessment: no RED failed on a missing module, syntax, setup or fixture fault.

## User Setup Required

None - no external service configuration required.

## Operator Actions

- Set `RAG_EMBEDDING_PROFILES=on` for a flip to change what queries use; `rag:embedding status` says when it is off.
- Until plan 03-46 adds the evidence recorder, `eval_evidence` for a target profile has to be written by SQL (as the tests do); the gate names which part is missing.
- A flip refreshes the cache of the process that made it. Other instances pick the new pointer within the 30 s cache time or through the stale-pointer retry.
- Not exercised here: a real Supabase project with real provider keys (coverage D8).

## Hand-offs

- **03-43:** the panel calls `GET .../embedding-profiles?completeness=true`, `POST .../{id}/activate` and `POST .../rollback` with the admin session; 409 bodies carry `reason` and, for incomplete, `missing_chunks`; the list items carry `has_evidence`, `activated_by`, `previous_active_id` and a per-profile `completeness`.
- **03-46:** extends `src/lib/rag/embeddings/cli.ts`; keep `parseEmbeddingArgs`, `main` and the exit codes (0 done, 1 refused or unreachable, 2 bad arguments).
- **03-47/03-48:** no migration or setup file was touched.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED

Created files exist on disk (cli.ts, the four route files including `_responses.ts`, both test files); commits `74129bb`, `fd630a0`, `38f848f`, `561e37c` are ancestors of HEAD; measured commit count 4 (`git rev-list --count 694b696..HEAD` before this file's commit).
