---
phase: 03-unified-ingestion-embedding-profiles
plan: 37
subsystem: security
tags: [quarantine, admin, audit, rls, tenant-scope, rag-originals, pglite, tdd]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "publish swap and the quarantined rule (03-07, 03-10, 0310 and 0313), quarantine writer, D-08 filter and the five-profile fixtures (03-20), invoice quarantine (03-29), version-aware readers (03-30), removeArtifacts and the private rag-originals bucket (03-17)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "checkAdmin, requireAdminOrDeny and adminDenied (src/lib/admin-route-auth.ts), requireAdminRequest, admin_users"
provides:
  - "Migration 0316_quarantine_admin: rag_admin_audit (append-only, server role only), rag_admin_tenant_keys, rag_list_quarantine, rag_release_quarantine, rag_delete_quarantined"
  - "Migration 0316_quarantine_access (single-tenant and multi-tenant): SELECT policies on documents and document_chunks show only current, ready rows; get_document_chunks revoked from anon and authenticated and filtered"
  - "listQuarantine, releaseQuarantined, deleteQuarantined exported from @/lib/rag"
  - "GET /api/rag/admin/quarantine, POST /api/rag/admin/quarantine/{id}/release, DELETE /api/rag/admin/quarantine/{id}, all behind checkAdmin"
affects: [03-43, 03-47]

actuals:
  tokens: 26000
  tasks: 3
  commits: 6

plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: f48e540bcc3e1cafa438b425bcaaee1da31d3038

tech-stack:
  added: []
  patterns:
    - "SECURITY DEFINER admin functions take the verified actor as p_actor, re-check admin_users in SQL and derive the administered tenant keys themselves; another tenant's id answers not_found like an unknown id"
    - "RLS proofs use a fixture with Supabase default grants and real SET ROLE anon, authenticated and service_role queries"

key-files:
  created:
    - supabase/migrations/0316_quarantine_admin.sql
    - supabase/migrations/0316_quarantine_access.single-tenant.sql
    - supabase/migrations/0316_quarantine_access.multi-tenant.sql
    - src/lib/rag/ingest/quarantine-admin.ts
    - src/app/api/rag/admin/quarantine/route.ts
    - src/app/api/rag/admin/quarantine/[id]/route.ts
    - src/app/api/rag/admin/quarantine/[id]/release/route.ts
    - src/app/api/rag/admin/quarantine/_responses.ts
    - tests/rag-db/quarantine-release.test.mts
    - tests/rag-db/quarantine-rls.test.mts
    - tests/rag/quarantine-admin-routes.test.ts
  modified:
    - src/lib/rag/index.ts

key-decisions:
  - "An admin acts only inside the tenants they administer: single-tenant s:default; multi-tenant the admin's personal tenant u:<id> plus every organization where the admin is owner or admin. The SQL functions derive this from p_actor and admin_users themselves, so a bypassed route guard still cannot cross tenants. This replaces the plan's deployment-wide list (truth 3) at the brief's instruction"
  - "Release sets the version to processing inside one transaction and calls rag_publish_document_version, so it is the same D-11 swap as ingestion; the audit row is written only after a successful publish, and a refused or failed release changes nothing"
  - "The rule ids a release was released for are recorded three times: metadata.quarantine.released_rule_ids, the audit row, and the release result. The original rule_ids and snippets stay on the record. processing_state.quarantine.released becomes true"
  - "An invoice quarantined by extraction is released like any other; its extraction record becomes released_unextracted because extraction never stored a field, and findInvoices does not return it"
  - "Delete removes the database rows and writes the audit row first, then the stored objects through removeArtifacts (only keys under the version's own prefix). A storage failure never leaves a document without its original; the delete answers 200 with artifacts_failed instead of 204 and logs ids"
  - "Table SELECT policies show a row only when is_current AND status = 'ready'; a chunk additionally needs its document to be visible. This also hides superseded and unfinished rows from PostgREST readers, which no in-app reader uses (all server reads use the service role)"
  - "The RLS closure is a separate migration stem, 0316_quarantine_access, that sorts before 0316_quarantine_admin, so the last migration still changes functions as the schema-equality teeth test requires"
  - "Setup files are not touched: plan 03-47 folds migrations 0301-0318 into them. 03-47 must fold both 0316 stems, including the replaced policies and get_document_chunks"

patterns-established:
  - "Admin routes take the actor only from the checkAdmin result and refuse an actor or any other key in the body"

requirements-completed: [SEC-01]

coverage:
  - id: D1
    description: "rag_release_quarantine publishes a quarantined version through the swap in one transaction (first version becomes current; a v2 replaces a current v1), records released_by, released_at and the rule ids, and writes one audit row without document text; zh, en and it injection fixtures are absent from all five retrieval profiles while quarantined and present after release"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag-db/quarantine-release.test.mts#each zh, en and it injection fixture ... / #release makes the version current ... / #releasing a quarantined v2 ..."
        status: pass
    human_judgment: false
  - id: D2
    description: "Delete removes only the quarantined version (chunks, profile vectors, stored objects in rag-originals), leaves a current v1 retrievable, writes an audit row with lineage and tenant, and a storage failure is counted without undoing the delete"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag-db/quarantine-release.test.mts#deleting a quarantined v2 ... / #a failing storage removal ..."
        status: pass
    human_judgment: false
  - id: D3
    description: "In multi-tenant mode an admin lists, releases and deletes only inside the tenants they administer (personal tenant, organizations where they are owner or admin); another tenant's document answers not_found like an unknown id and nothing changes, including its stored objects; a user outside admin_users is refused by the database"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag-db/quarantine-release.test.mts#two tenants: an admin acts only within the tenants they administer"
        status: pass
    human_judgment: false
  - id: D4
    description: "The three routes fail closed with the adminDenied bodies (no credential 401, throwing auth or failed lookup 503, non-admin including the owner and an organization member 403, forged, tampered or unsigned cookie 401, signed cookie of a non-admin 403) before any quarantine function runs; the actor is the verified admin; the body, params and query are validated with zod/v3"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag/quarantine-admin-routes.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "Anon and authenticated cannot read quarantined, superseded or unfinished rows of documents and document_chunks, directly or through the invoker search functions, in single-tenant and multi-tenant mode; ready, current rows (and a legacy row) stay readable as before; get_document_chunks is not executable by anon or authenticated; the audit table and the new functions are not reachable by them"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag-db/quarantine-rls.test.mts and tests/rag-db/quarantine-release.test.mts#anon and authenticated can neither read or write the audit table ..."
        status: pass
    human_judgment: false
  - id: D6
    description: "An invoice quarantined by extraction is listed as such and releasable"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "tests/rag-db/quarantine-release.test.mts#an invoice quarantined by extraction ..."
        status: pass
    human_judgment: false
  - id: D7
    description: "Choosing owner or admin organization roles as 'administers' (instead of any member) fits how the operator runs tenants"
    verification: []
    human_judgment: true
    rationale: "The brief says 'tenants they administer' without defining it; src/lib/rag/ingest/quarantine-admin.ts and rag_admin_tenant_keys in 0316_quarantine_admin.sql hold the one definition if the operator wants it wider or narrower"

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 37: Quarantine release, delete, audit and the table-read bypass Summary

**Admins release or delete quarantined documents through fail-closed routes that stay inside the tenants they administer, every action is audited without document text, and PostgREST can no longer read quarantined rows from documents or document_chunks**

## Accomplishments
- `rag_release_quarantine` runs the publish swap in one transaction; `rag_delete_quarantined` removes one version and returns its object keys, which `deleteQuarantined` removes from the private `rag-originals` bucket with `removeArtifacts`; `rag_list_quarantine` pages the list newest first with rule ids, at most three snippets and the quarantine time.
- Every function re-checks `admin_users` and limits the actor to administered tenants in SQL; the routes pass only the id from the `checkAdmin` result.
- `0316_quarantine_access` replaces the single-tenant `USING (true)` and the multi-tenant owner/member SELECT policies with the same rules plus `is_current AND status = 'ready'`, and a chunk needs its document to be visible. `get_document_chunks` is revoked and filtered.

## Task Commits
1. Task 1 RED `040e8da` (12 tests, all failing on assertions against an inert stub), GREEN `e366124` (migration 0316_quarantine_admin and quarantine-admin.ts)
2. Task 2 RED `e2a4c6d` (28 route tests against 501 stubs), GREEN `d205191` (the three routes and `_responses.ts`)
3. Task 3 (brief item 3, not in the original plan) RED `1a10dfd` (14 tests, 8 failing on leaked rows or an executable function), GREEN `f48e540` (0316_quarantine_access, both modes)

## Tests and what failed first
| Test file | Result | Failed before the change |
|---|---|---|
| tests/rag-db/quarantine-release.test.mts | 12 pass | all 12 (stub reports unavailable; functions and table missing) |
| tests/rag/quarantine-admin-routes.test.ts | 28 pass | all 28 (stub routes answer 501) |
| tests/rag-db/quarantine-rls.test.mts | 14 pass | 8: single-tenant anon and authenticated read quarantined, superseded and unfinished rows; owner and organization member read their quarantined rows; the old permissive policy stays a leak until the migration; get_document_chunks executable by anon; search functions return a chunk whose status copy drifted. The controls (another tenant, anon in multi-tenant, service_role, one SELECT policy per table) passed before and after |

## Gate Results
| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no errors |
| `npx vitest run` | 148 files; 2099 passed; 1 failed on the first run: `tests/rag/injection-scan.test.ts` "scans a 1 MB benign text in under one second" (1062 ms, the known timing flake under load); passes alone (45 of 45) |
| `node --import tsx --test tests/*.test.mts` | 145 passed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 310 tests, 307 passed, 0 failed (3 skipped by their own guards); schema-equality and schema-migrations included |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 760 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, untouched |

Acceptance: `rag_admin_audit` in 0316_quarantine_admin.sql 20 (>=2); quarantine-release 12 passed (>=6); route files with checkAdmin 3 (==3); `requireRagAdmin` in the route files 0; `mintAdminSessionValue` in the route test 3 (>=1); quarantine-admin-routes 28 passed (>=14); `tests/api/admin-auth.test.ts` and `tests/api/config-admin-routes.test.ts` 56 passed.

## Deviations from Plan

**1. [Rule 2 - Security, at the brief's instruction] Admin scope is the administered tenants, not every tenant.** Plan truth 3 and T-03-136 made the list deployment-wide. The brief requires that in multi-tenant mode an admin acts only inside the tenants they administer, with a two-tenant test. "Administer" is defined as the admin's personal tenant plus organizations where they are owner or admin (`rag_admin_tenant_keys`). A deployment admin who is not an owner or admin of a tenant can no longer list, release or delete that tenant's quarantined documents; a tenant user's own personal quarantine is therefore only reachable by that user if they are in admin_users. Decision D7 in the coverage block.

**2. [Plan text out of date] A signed admin_session cookie alone is not admitted.** The merged guard (`requireAdminCookie`) requires a live Supabase session for the same user as well. The route tests follow the guard: cookie plus matching session is admitted, cookie alone is 401. The plan's "no Supabase session" wording was not implemented.

**3. [Rule 3] The quarantine RPCs go through the ingest deps admin client (`getIngestDeps().db()`), not the RAG deps admin client.** The ingest writer and the object store already use it, and the tests install it with `setIngestDepsForTests`.

**4. [Brief item 3, new files] Two extra migration files and a test file.** `0316_quarantine_access.{single,multi}-tenant.sql` and `tests/rag-db/quarantine-rls.test.mts`. The setup files and `tests/rag-db/schema-migrations.test.mts` are untouched; its anon/authenticated exposure check already covers every new `rag_` function and passes. The stem sorts before `0316_quarantine_admin` so the schema-equality "dump has teeth" test, which expects the last migration to change a function, still holds without editing it.

**5. [Interpretation] Brief item 4, "follows the plan's rules about the rule ids it was released for".** Implemented as: release records the rule ids it was released for (metadata, audit row, result) and keeps the original rule ids and snippets. No rule-id allow-list or exemption for later ingests was added; a re-ingest is scanned again like any upload. If the orchestrator meant something else, this is the place to change.

**6. [Deviation from the plan's 204] Delete answers 200 `{success:true, artifacts_failed:n}` when stored objects could not be removed**, 204 otherwise.

**7. RED commits carry inert stubs** (`quarantine-admin.ts` reporting unavailable, three routes answering 501) so the failures are assertion failures and not a missing module.

## Auth gates
None.

## Known Stubs
None.

## Threat Flags
| Flag | File | Description |
|---|---|---|
| threat_flag: storage-orphan | src/lib/rag/ingest/quarantine-admin.ts | If the object removal fails after the database delete, the version's objects stay in the private bucket until an operator clears the logged `<tenant>/<lineage>/<version>/` prefix; the response reports artifacts_failed |

## Operator actions
1. Apply, in order, after 0314 and the other Phase 3 migrations: `0316_quarantine_access.<mode>.sql` then `0316_quarantine_admin.sql` (`bash scripts/setup-database.sh --list-migrations <mode>` prints the order). Re-run the migrations after any re-run of a setup file: the setup files still carry the old open SELECT policies until plan 03-47 folds these in.
2. Anyone who read documents or chunks directly with the anon key or a user token (PostgREST) now sees only current, ready rows; server code is unchanged.
3. Quarantined documents are now released or deleted through the routes (or plan 03-43's panel); there is no panel yet.

## Remaining quarantine-bypass readers
- Service-role readers by design: `fetch-rows.ts` by-id assembly (ids come from filtered RPCs); the admin quarantine list (snippets, admins only); the owner view in `GET /api/documents` (whitelisted fields, no content).
- Service-role SQL functions with no application caller and no D-08 filter: `get_documents_by_type_slug`, `get_documents_by_type_slug_workspace`, `get_workspace_context` (multi-tenant).
- `DELETE /api/documents/{id}` (03-30) still does not remove the lineage's stored objects from `rag-originals`; only the admin delete does.
- The legacy writer (`RAG_INGEST_PIPELINE=legacy`) never scans, so it never quarantines (T-03-58, accepted).
- Setup files still contain the open policies until 03-47.

## Hand-offs
- 03-47: fold both 0316 stems into the setup files (replaced policies, `get_document_chunks` body and grants, audit table, functions), keep schema-equality green.
- 03-43: the Config UI panel calls the three routes with the admin session; the list items carry `detected_by` and the delete may answer 200 with `artifacts_failed`.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED
Created files exist; commits `040e8da`, `e366124`, `e2a4c6d`, `d205191`, `1a10dfd`, `f48e540` are ancestors of HEAD; measured count 6.
