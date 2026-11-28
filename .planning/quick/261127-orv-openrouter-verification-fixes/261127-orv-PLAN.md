---
quick_id: 261127-orv
slug: openrouter-verification-fixes
branch: exec/quick-openrouter-fallback
source: origin/verify/03.2.1 (03.2.1-VERIFICATION.md, 03.2.1-SECURITY.md)
---

# Quick 261127-orv: fix the 03.2.1 verification findings on the OpenRouter route

Scope is exactly these four items. TDD: failing tests first, then the fix.

## Task 1 — OR-4: D-26 tolerance in verify-route, refuse a missing `provider`
- files: src/lib/rag/embeddings/verify-route.ts, src/lib/rag/embeddings/bge-m3.ts, src/lib/rag/embeddings/cli.ts, tests/rag/embeddings/bge-m3-via.test.ts
- action: `ROUTE_MIN_COSINE = 0.9999`, new `ROUTE_MAX_COMPONENT_DELTA = 1e-3` checked on every component (L2-normalized), report `maxComponentDelta` and `maxComponentDeltaRequired`; an OpenRouter answer without a `provider` field is an `EmbeddingProfileMismatch`.
- verify: `npx vitest run tests/rag/embeddings/bge-m3-via.test.ts`

## Task 2 — OR-2: name OpenRouter as a recipient of text
- files: scripts/config-ui/rag-panels/embedding-profiles.js, scripts/config-ui/index.html, tests/ui/config-bge-m3-route-disclosure.test.ts; vendor inventory entry (config/rag/vendor-data-flow.json lives on main only, see SUMMARY)
- verify: `npx vitest run tests/ui/config-bge-m3-route-disclosure.test.ts tests/ui/config-phase32-switches.test.ts`

## Task 3 — OR-1: sidecar + VIA=openrouter makes zero OpenRouter calls; VIA unset unchanged
- files: tests/rag/embeddings/bge-m3-via.test.ts (test only; the behaviour is already correct)

## Task 4 — catalog: bge-m3 `servingModes: ['hosted','sidecar']`, `sidecarPath: '/v1/embed'`
- files: src/lib/rag/embeddings/catalog.ts, tests/rag/embeddings/catalog.test.ts
