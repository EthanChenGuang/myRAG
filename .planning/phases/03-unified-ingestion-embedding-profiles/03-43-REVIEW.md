---
phase: 03-unified-ingestion-embedding-profiles
reviewed: 2026-11-24T10:34:30Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - scripts/config-server.js
  - scripts/config-ui/rag-panels/rag-fetch.js
  - scripts/config-ui/rag-panels/quarantine.js
  - scripts/config-ui/rag-panels/doc-types.js
  - scripts/config-ui/rag-panels/embedding-profiles.js
  - tests/ui/config-rag-panels.test.ts
findings:
  critical: 1
  warning: 0
  info: 1
  total: 2
status: issues_found
---

# Plan 03-43: Config UI RAG Panels — Code Review

**Reviewed:** 2026-11-24T10:34:30Z  
**Depth:** standard  
**Files reviewed:** 6  
**Status:** issues_found (one BLOCKER fixed during review)

## Summary

Config UI RAG panels follow sound patterns: DOM updates via `textContent` / `createElement`, client fetch uses `credentials: 'same-origin'` and strips `Authorization`, and `withAuthHeaders` forwards `Cookie` and `Authorization` without inventing credentials. Global `index.html` fetch shim adds `X-Config-UI: 1` for same-origin mutating requests (CSRF).

One **critical** path-guard gap let double-encoded `..` segments pass the segment check but escape `/api/rag/*` when `new URL()` resolved the upstream request—**fixed in this review** (`resolveRagProxyMainAppUrl` + test).

## Critical Issues

### CR-01: Double-encoded `..` bypassed RAG proxy scope (fixed)

**File:** `scripts/config-server.js:3360-3417`  
**Issue:** `buildRagProxyTargetPath` rejected literal and single-encoded `..`, but a path like `/api/rag/%252e%252e/admin/quarantine` decoded to `/api/rag/%2e%2e/admin/quarantine`. Node’s `URL` then resolved `%2e%2e` to `/api/admin/quarantine`, so the proxy could forward admin cookies to non-`/api/rag` main-app routes.  
**Fix applied:** After building `targetPath`, `resolveRagProxyMainAppUrl` validates `new URL(targetPath, base).pathname` with `isAllowedRagProxyPathname` before `fetch`. Regression test in `tests/ui/config-rag-panels.test.ts`.

## Info

### IN-01: CSRF header not in `rag-fetch.js` (acceptable)

**File:** `scripts/config-ui/rag-panels/rag-fetch.js:25-41`  
**Issue:** Panel helper does not set `x-config-ui`; mutating calls rely on the inline fetch wrapper in `scripts/config-ui/index.html` (lines 7–16).  
**Note:** Documented in 07-PATTERNS; tests that hit the proxy directly must set the header (as in `config-rag-panels.test.ts`).

## Passed checks

| Area | Result |
|------|--------|
| XSS (quarantine / profiles / doc-types) | `textContent` only; no `innerHTML` in `rag-panels/*` |
| Auth forwarding | `withAuthHeaders` copies Cookie + Authorization; `ragFetch` does not add tokens |
| Credential leakage | No `sessionStorage` / anon-key patterns in panel scripts; proxy logs path only |
| Single-encoded `..` | 400, stub not called (tested) |

**Post-fix:** `npx vitest run tests/ui/config-rag-panels.test.ts` — 15/15 passed.

---

_Reviewed: 2026-11-24T10:34:30Z_  
_Reviewer: Claude (gsd-code-reviewer)_  
_Depth: standard_