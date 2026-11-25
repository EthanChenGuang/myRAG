---
phase: 03-unified-ingestion-embedding-profiles
plan: 43
subsystem: ui
tags: [config-ui, rag, admin, proxy, vitest]

requires:
  - phase: 03-37
    provides: RAG admin quarantine routes
  - phase: 03-39
    provides: doc-type defaults admin routes
  - phase: 03-40
    provides: embedding profile admin routes

provides:
  - /api/rag/* proxy on config-server via withAuthHeaders
  - rag-fetch.js and RAG administration Config UI panels
  - Upload picker and document-list doc-type change wired in Config UI

affects: [03-verification, config-ui]

actuals:
  tokens: 52000
  tasks: 3
  commits: 3
plan_head_before: 0756a62e881f9792aeee92531c2718a258439d68
plan_head_after: "6960a2c6ba2927731a7ea32cd82997edc13aa475"

tech-stack:
  added: []
  patterns:
    - "Config UI RAG panels call same-origin /api/rag/*; config-server forwards Cookie and Authorization unchanged"

key-files:
  created:
    - scripts/config-ui/rag-panels/rag-fetch.js
    - scripts/config-ui/rag-panels/doc-types.js
    - scripts/config-ui/rag-panels/quarantine.js
    - scripts/config-ui/rag-panels/embedding-profiles.js
    - tests/ui/config-rag-panels.test.ts
  modified:
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - scripts/config-ui/document-processing/document-manager.js

key-decisions:
  - "Single auth path: admin_session cookie only; no Supabase sign-in in Config UI panels"
  - "Quarantine panel uses textContent-only rendering for snippets"

patterns-established:
  - "ragFetch returns structured { ok, status, message, body } for 401/403/503"

requirements-completed: [DATA-03, DATA-10, SEC-01, EMB-02]

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 43: Config UI RAG administration Summary

**Config UI RAG admin panels and /api/rag proxy forward the existing admin_session cookie with stub-tested header fidelity and vitest-covered helpers.**

## Accomplishments

- Added Express `app.all('/api/rag/*path')` proxy with path normalization guard and auth header forwarding only via `withAuthHeaders`.
- Shipped `rag-fetch.js` plus Document types, Quarantine, and Embedding profiles panels (zh/en/it label parity with `doc-type-labels.ts`).
- Wired upload queue doc-type selects and document-list type change via admin routes; added RAG administration tab in `index.html`.

## Deviations from Plan

None — plan executed as written. Human-check steps (live Config UI against running app) were not run in this automated execution.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | n/a — incremental Config UI admin panels on existing DaisyUI patterns | n/a |
| Impeccable | n/a — no new visual direction | n/a |
| web-design-guidelines | `command.md` pass on `rag-panels/*.js`, RAG administration tab in `index.html`, `/api/rag` proxy block in `config-server.js` | pass (all findings resolved) |

Under **web-design-guidelines**:

- `scripts/config-ui/index.html:8418` — async status missing `aria-live` — fixed (`role="status" aria-live="polite"`)
- `scripts/config-ui/index.html:8430` — async status missing `aria-live` — fixed
- `scripts/config-ui/index.html:8439` — async status missing `aria-live` — fixed
- `scripts/config-ui/index.html:8410` — heading Title Case — fixed (`RAG Administration`)
- `scripts/config-ui/rag-panels/doc-types.js:142-179` — selects not linked to labels / missing `name` — fixed (`htmlFor`, `id`, `name`)
- `scripts/config-ui/rag-panels/rag-fetch.js` — none
- `scripts/config-ui/rag-panels/embedding-profiles.js` — none (status regions in HTML)
- `scripts/config-ui/rag-panels/quarantine.js` — none
- `scripts/config-server.js:3360-3438` — none (server proxy)

## Verification

- `npx vitest run tests/ui/config-rag-panels.test.ts` — 14 passed
- `node --check` on changed scripts — passed
- `node scripts/check-config.mjs` — passed

## Self-Check: PASSED

- tests/ui/config-rag-panels.test.ts — FOUND
- scripts/config-ui/rag-panels/*.js — FOUND
- scripts/config-server.js /api/rag/ proxy — FOUND