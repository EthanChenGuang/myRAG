---
quick_id: 261127-idn
slug: identifier-neutral-names
type: quick
base: origin/ci/merge-train-39
branch: exec/quick-idn-neutral-names
source: Phase 4.2 VERIFICATION W-5(j)
---

# Quick 261127-idn: shape-neutral names in the identifier modules

Goal: no domain-flavoured identifier, constant, shape name or comment in `src/lib/rag/ids/**` and
`src/lib/rag/retrieval/exact-id.ts`; pure rename, behaviour identical.

## Tasks

1. Inventory every domain-flavoured name and string in `src/lib/rag/ids/` (all files) and `exact-id.ts`; classify each as
   renamable (TS-only) or value-bound (persisted, traced, or in a contract/Pydantic model).
2. Rename the TS-only names to shape names (file `tax-ids.ts` -> `checksum-ids.ts`, types, constants, validators, the
   in-memory `ExactIdKind` values). No regex, order or matching change; contract scheme values keep their spelling.
3. Update tests that reference the old names.
4. Add `scripts/ci/check-identifier-domain-words.mjs` with its word list and allow-list in
   `scripts/ci/identifier-domain-words.json` (CI config, not product code), a node self-test, and a pr-smoke step.

## Gates

tsc, typecheck:new, check-rag-boundary, check-language-literals, check-settings-classification, check-config,
the new check, gen:schemas (no diff), vitest on ids/exact-id tests and the full vitest, tests/rag-db/exact-id-lookup,
check-workflows, eval pytest, `npm run test-rag -- --fixture-mode ingest`.
