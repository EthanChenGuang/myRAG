---
phase: 03-unified-ingestion-embedding-profiles
plan: 30
subsystem: api
tags: [versions, lineage, quarantine, tenant-isolation, documents, images, scrapers, pglite]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "version columns, tenant_key and legacy triggers (03-01), dedup and version swap (03-16), quarantine and the D-08 filter (03-20)"
provides:
  - "GET /api/documents: one entry per lineage, status from the column, chunk counts from current ready chunks, quarantined rows only for their owner and without content"
  - "DELETE /api/documents/{id} removes the caller's whole lineage; PATCH updates the current version; both filter tenant_key"
  - "GET /api/images and GET /api/scrapers/status read current ready documents and chunks only"
  - "Single-tenant GET /api/scrapers/status requires a session"
  - "tests/helpers/pglite-admin.ts: a supabase-js style builder over PGlite for route tests that write"
affects: [03-37, 03-43, 03-47]

key-files:
  created:
    - tests/rag/documents-versions.test.ts
    - tests/helpers/pglite-admin.ts
  modified:
    - src/app/api/documents/route.ts
    - src/app/api/documents/[id]/route.ts
    - src/app/api/images/route.ts
    - src/app/api/scrapers/status/route.ts
    - tests/rag/documents-route.test.ts
    - tests/rag/images-route.test.ts

key-decisions:
  - "The documents list status comes from documents.status. Only one downward rule is kept from today's behaviour: a ready row with no current ready chunk shows processing. A chunk count never makes a row ready"
  - "Per lineage the list entry is the current version; a quarantined version the caller may see wins when it is newer; a lineage with no current version (processing, failed or quarantined first upload) is listed by its newest visible version"
  - "A quarantined entry is whitelisted: id, filename, created_at, source, version, status quarantined, chunk_count 0, metadata {} and quarantine.rule_ids. No content, snippet, preview or other metadata"
  - "Who is the owner of a quarantined document: multi-tenant, the uploading user (user_id equals the session user), in a personal or an organization workspace; single-tenant, a deployment admin (admin_users) or the uploader, since unified single-tenant ingestion records no user"
  - "The tenant_key predicate is added to the documents/[id] read, delete and update next to the C2 fix's ownership predicate, not in place of it: in single-tenant mode tenant_key is the constant s:default, so replacing the predicate would let a non-admin owner reach every document"

requirements-completed: [DATA-07]

actuals:
  tokens: 40000
  tasks: 2
  commits: 5

plan_head_before: 65c5b7fec2be3a12c7e444f38c1bc4f50f947053
plan_head_after: 1761901bfa74d6f6ed6af69c210790dcae564e62

coverage:
  - id: D1
    description: "The documents list shows one current entry per lineage with version and status, no deleted and no superseded rows"
    requirement: DATA-07
    verification:
      - kind: integration
        ref: "tests/rag/documents-versions.test.ts#GET /api/documents, multi-tenant"
        status: pass
    human_judgment: false
  - id: D2
    description: "Quarantine bypass closed in the three readers: list status and counts, images, scraper status; quarantined rows reach only their owner and carry no content"
    requirement: DATA-07
    verification:
      - kind: integration
        ref: "tests/rag/documents-versions.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Lineage DELETE and PATCH stay inside the caller's tenant; another tenant's id is a 404 identical to an unknown id and changes nothing"
    requirement: DATA-07
    verification:
      - kind: integration
        ref: "tests/rag/documents-versions.test.ts#DELETE and PATCH /api/documents/{id}"
        status: pass
    human_judgment: false
  - id: D3b
    description: "Legacy-only data (pre-migration rows and a post-migration legacy-writer row) gets the recorded responses from all four routes"
    requirement: DATA-07
    verification:
      - kind: integration
        ref: "tests/rag/documents-versions.test.ts#legacy-only data"
        status: pass
    human_judgment: false
  - id: D4
    description: "The configuration dashboard presents status quarantined and the rule ids sensibly"
    verification: []
    human_judgment: true
    rationale: "document-dashboard.tsx types status as processing, ready or failed; the panel is plan 03-43's"

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 30: Version-aware document readers Summary

**The document list, delete and status readers now work per lineage and current version, close the quarantine bypass in the list, images and scraper status readers, and keep every delete and update inside the caller's tenant**

## Accomplishments
- `GET /api/documents` reads current rows plus the non-current rows a first upload can be in, groups them by lineage and returns one entry per lineage. Status is the column; chunk counts use `is_current` and `status = 'ready'` chunks.
- Owners see quarantined documents as `status: 'quarantined'` with `quarantine.rule_ids` and nothing else; nobody else does.
- `DELETE` removes every version of the lineage and their chunks, filtered by `lineage_id` and `tenant_key`; `PATCH` puts `external_url` on the lineage's current version.
- `/api/images` and `/api/scrapers/status` add `is_current` and `status = 'ready'` to every document and chunk read, after their existing authorization.
- Single-tenant `/api/scrapers/status` now needs a session (`requireSessionUser`: 401, 503), at the coordinator's request after plan 03-23.

## Task Commits
1. RED `a73d422`: 25 route tests over PGlite (15 failed on assertions)
2. Task 1 GREEN `5fca7db`: documents list, DELETE, PATCH, documents-route test mock
3. Task 2 GREEN `e11db92`: images and scraper status filters, images-route test mock
4. RED `55f537f` then GREEN `1761901`: single-tenant scraper status session

## Deviations from Plan

**1. [Rule 2 - Security] tenant_key added beside the ownership predicate, not replacing it.** See key-decisions. Single-tenant tenant_key is constant, so replacement would weaken the C2 fix.

**2. [Rule 3 - Blocking] Test infrastructure.** The fake edge serves GET and RPC only (no DELETE, PATCH, `neq`, `order` or HEAD counts) and is shared with parallel plans, so `tests/helpers/pglite-admin.ts` (a builder over the same PGlite database, real migrations and triggers) runs the routes instead. Not in the plan's file list.

**3. [Rule 3 - Blocking] Existing test mocks adapted, no case dropped.** `documents-route.test.ts` models the generated columns (`tenant_key`, `lineage_id`, `is_current`) and `in`; `images-route.test.ts` models the migration defaults `is_current` true and `status` ready. Fixtures and assertions are unchanged.

**4. [Plan interpretation] List shape.** The plan said `.eq('is_current', true)` on the list. A first upload that is processing, failed or quarantined is not current, so the list also reads those non-current rows and groups by lineage; otherwise a processing document would vanish from the list. Responses gain a `version` field (legacy rows: 1); otherwise legacy responses are identical.

**5. [Coordinator request] Single-tenant scraper status session**, with failing-first test.

**Not done, deliberately:** the DELETE lookup in `/api/images` and `authorize()` are untouched, as the plan says.

## TDD Gate Compliance
RED `a73d422`: 15 of 25 failed on assertions (for example `expected 200 to be 401`-style status and list-content assertions, `expected 3 to be 2` chunk count, quarantined scrape reported as scraped). The 10 that passed were legacy-recorded responses and the C2 and C3 guards. RED `55f537f`: the single-tenant session test failed with `expected 200 to be 401`. `gsd_run check tdd-red-evidence` not run (manual assessment, as in 03-17 and 03-20).

## Gate Results
| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 134 files, 1850 tests passed (one run earlier showed 1 failure in the full suite that did not reproduce in the next full run; I did not identify it) |
| `node --import tsx --test tests/*.test.mts` | 145 passed |
| `node --import tsx --test tests/rag-db/schema-migrations.test.mts` | 28 passed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 718 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, untouched |

Acceptance: `is_current` in documents/route.ts 6 (>=1); `lineage_id` in documents/[id]/route.ts 8 (>=1); `tenant_key` 6 (>=2); `is_current` in images and scrapers 2 + 2 (>=2); `resolveTenantScope` in images/route.ts 2 (>=2); documents-versions 27 passed (>=9); images-route 18 passed (>=15).

## Threat Surface
T-03-86 mitigated (session, resolveTenantScope, tenant_key and ownership predicates, two-tenant tests). T-03-143 mitigated (images authorization untouched, filters added after it). T-03-87 refined: owners see their quarantined documents with rule ids only, no snippets.

## Known Stubs
None.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED
Created files exist; commits `a73d422`, `5fca7db`, `e11db92`, `55f537f`, `1761901` are ancestors of HEAD; measured count 5.
