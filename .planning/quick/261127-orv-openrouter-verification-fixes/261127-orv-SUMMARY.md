---
quick_id: 261127-orv
slug: openrouter-verification-fixes
status: complete
branch: exec/quick-openrouter-fallback
date: 2026-11-27
source: origin/verify/03.2.1 (03.2.1-VERIFICATION.md, 03.2.1-SECURITY.md)
findings: [OR-4, OR-2, OR-1, catalog-serving-modes]
---

# Quick 261127-orv: 03.2.1 verification findings on the OpenRouter route

Only the four listed items were changed. OR-3 (optional echo of the reference-file parse error) was left alone.

## Commits
| Commit | Task |
|---|---|
| `3e9ab55ca` | RED: failing tests for OR-4, OR-2 and the catalog; OR-1 tests (they pass on the old code, see below) |
| `b69621d85` | OR-4: D-26 tolerance in verify-route; an OpenRouter answer without `provider` is refused; AGENTS.md line updated |
| `a93fa4ca5` | Catalog: bge-m3 `servingModes: ['hosted', 'sidecar']`, `sidecarPath: '/v1/embed'` |
| `25b3644b4` | OR-2: Config UI help (en, zh, it, plus the HTML fallback) says text goes to OpenRouter |
| `575cf7aeb` | OR-2: vendor inventory entry, as a patch against main (see Deviations) |
| `0449e5993` | Old D-25 catalog test in `tests/rag/bge-m3-provider.test.ts` now expects the sidecar mode |

## Behaviour changes
- `verify-route bge-m3` now gives `match` only when the cosine is at least 0.9999 and every component of the L2-normalized vectors is within 1e-3 (`ROUTE_MIN_COSINE`, new `ROUTE_MAX_COMPONENT_DELTA`). Before, the bar was cosine 0.999 with no component check. The report adds `comparison.maxComponentDelta` and `maxComponentDeltaRequired`, and the CLI prints both. A missing or zero vector gives NaN, which never counts as a match.
- With `RAG_BGE_M3_VIA=openrouter`, an embedding response that has no `provider` field is refused as an `EmbeddingProfileMismatch` (`openrouter.ai:none`). Before, it was accepted. This applies to serving and to verify-route, which uses the same provider. DeepInfra answers are unchanged.
- Catalog: bge-m3 lists both serving modes. Nothing outside the catalog reads these fields, so runtime behaviour does not change.
- Config UI: `via.help` and `serving.help` now say that document and query text goes to OpenRouter (openrouter.ai) when the route is OpenRouter.
- Defaults are unchanged. With `RAG_BGE_M3_VIA` unset, hosted calls go to DeepInfra with no provider pin (covered by a test).

## Tests that failed before the fix (assertion failures, no import errors)
- `bge-m3-via.test.ts`: refuses an OpenRouter answer that does not name its upstream; uses the D-26 tolerance; reports a mismatch when the cosine is below 0.9999 but above 0.999; reports a mismatch when one component is more than 1e-3 off; matches when both routes return the same vectors (the new `maxComponentDelta` assertion).
- `catalog.test.ts`: lists both serving modes for bge-m3; pairs servingModes with hostedEndpoint and sidecarPath.
- `config-bge-m3-route-disclosure.test.ts`: via.help names OpenRouter in en, zh and it; serving.help names OpenRouter.
- OR-1 (`sidecar serving with RAG_BGE_M3_VIA=openrouter makes zero OpenRouter and DeepInfra calls`, `a failing sidecar … still makes zero OpenRouter calls`, `with RAG_BGE_M3_VIA unset the hosted call goes to DeepInfra as before`): these passed on the old code. The finding was a missing test, not a bug: the sidecar branch returns before `via` is read. The fake server now also serves `/sidecar/v1/embed`, so every path is counted.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: ok
- `node scripts/check-config.mjs`, `node scripts/ci/check-rag-boundary.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: ok
- `npx vitest run tests/rag/bge-m3-provider.test.ts tests/rag/embeddings/ tests/rag/lang-validate-entrypoints.test.ts tests/ui/`: 97 files, 2013 tests passed
- `node --import tsx --test` on the CLI importers in tests/rag-db (embedding-cli, activation-evidence, binding-compare-evidence, embedding-binding-cli, finetune-cli, finetune-revoke-prune): 38 passed
- In a scratch worktree of origin/main with the vendor patch applied: `node scripts/rag/gen-vendor-doc.mjs --check`, `node scripts/check-config.mjs` and `node --test scripts/tests/gen-vendor-doc.node-test.mjs` (14 passed)
- Sidecar pytest: not run, because no sidecar file changed.

## Deviations
- **Vendor inventory (OR-2):** `config/rag/vendor-data-flow.json`, its generator and `docs/vendor-data-flow.md` come from 07-21 and exist only on origin/main, not on this branch. The brief forbids merging trunk in, and adding the file here would create an add/add conflict plus a stale generated doc. So the entry ships as `vendor-data-flow-openrouter-embeddings.patch` in this directory. It was generated and checked against origin/main (6458a7a98 lineage). It adds vendor `openrouter_embeddings` (host openrouter.ai, content query and chunk_text, switch `RAG_BGE_M3_VIA`, opt_in true, multi_tenant allowed, retention and training to_verify) and the regenerated doc rows. **The merge train applies it** with `git apply .planning/quick/261127-orv-openrouter-verification-fixes/vendor-data-flow-openrouter-embeddings.patch` after main is merged, then runs `node scripts/rag/gen-vendor-doc.mjs --check`.
- AGENTS.md (BGE-M3 section): the tolerance and the "text goes to OpenRouter" statement were updated so the guide matches the code.
- STATE.md was not touched (brief rule).

## Open
- OR-4's second half ("require a recorded match before serving through OpenRouter, or accept the risk") was out of scope. Serving through OpenRouter is still gated only by the documented `verify-route` step, so the owner needs to decide it.
- Operator: the live `verify-route bge-m3` run (needs keys) is still an operator action.
