---
quick_id: 261127-dsw
slug: deps-switches
base: origin/ci/merge-train-39 (c6f1b3f76)
branch: exec/quick-deps-switches
status: complete
files_modified:
  - src/lib/rag/deps.ts
  - tests/rag/query/deps-env-input.test.ts
  - .planning/quick/261127-dsw-deps-switches/261127-dsw-PLAN.md
  - .planning/quick/261127-dsw-deps-switches/261127-dsw-SUMMARY.md
---

# Quick 261127-dsw: Phase 6.2 D-28 switches read by the default RAG deps

## The defect
`readRagEnvInput()` in `src/lib/rag/deps.ts` builds the `RagEnvInput` that every
production reader passes to `loadRagConfig` (`getRagDeps().ragEnv()`). Eight of the twelve
Phase 6.2 D-28 switches were not in it. Setting any of them in the deployment environment did
nothing: `parseQueryAdditions` got `undefined` and quietly kept the code default. Two more were
read from `process.env` without the `env.ts` fallback that every other query-layer read has.

## Before and after, on merge train 39
| Switch | env.ts default | Before | After |
| --- | --- | --- | --- |
| RAG_QUERY_DECOMPOSE_COMPLETENESS | true | read, **no env.ts fallback** | `process.env ?? env` |
| RAG_QUERY_SUBQ_FILTERS (06.2-16) | false | read, **no env.ts fallback** | `process.env ?? env` |
| RAG_DECOMPOSED_ANSWER | true | **not read** (always true under the layer) | read |
| RAG_TRANSLATION_GLOSSARY (06.2-17) | false | read with fallback | unchanged |
| RAG_LANGID_SIDECAR | false | **not read** (always off) | read |
| RAG_SPECULATIVE_RETRIEVAL (06.2-24) | false | **not read** on train 39 (fixed on origin/exec/06.2-24 only) | read, same line as 06.2-24 |
| RAG_QUERY_HISTORY_FALLBACK (06.2-20) | true | read with fallback | unchanged |
| RAG_SCOPE_GATE | false | **not read** (scope gate and centroid hook always off) | read |
| RAG_WHATSAPP_HISTORY | false | **not read** through ragEnv (`src/lib/whatsapp/history.ts` reads `env` itself, so WhatsApp worked) | read |
| RAG_MODEL_ROUTING | off | **not read** (routing always off) | read |
| RAG_ROUTING_FAST_MODEL | anthropic/claude-haiku-5.5 | **not read** (code default only) | read |
| RAG_ROUTING_QUALITY_MODEL | anthropic/claude-sonnet-5.5 | **not read** (code default only) | read |

Every new read uses the 06.2-17 / 06.2-20 form `process.env.X ?? env.X`, so the default source is
`src/lib/env.ts`. No default changed: each `env.ts` default equals the `parseQueryAdditions` /
`DEFAULT_ROUTING_*` default, so an unset switch loads the same config as before.

## Tasks and commits
1. `404cebce3` RED: `tests/rag/query/deps-env-input.test.ts`, table-driven over all twelve
   switches. On the old code 18 tests failed on assertions (8 "set -> reaches the config", 10
   "unset -> env.ts default"); the parity tests passed.
2. `e366bbbd0` GREEN: the reads in `deps.ts`. 27/27 pass.
3. Manifest / check-config: nothing to fix. On train 39 `node scripts/check-config.mjs` already
   reports `ok: 274 variable(s) match the manifest` (0 violations). All twelve D-28 switches
   (the 06.2-03 ones included: RAG_MODEL_ROUTING, RAG_SCOPE_GATE, RAG_SPECULATIVE_RETRIEVAL,
   RAG_WHATSAPP_HISTORY) are in `scripts/rag/env-manifest.json`, `config/rag/settings-classification.json`,
   `src/lib/env.ts`, `scripts/init-env.js` (the .env.local template), `scripts/config-server.js` and
   `scripts/config-ui/index.html`. The 12 violations were fixed earlier in the train (latest
   manifest fix: 693644e27, train 38).

## Parity off
- Unset switches: `loadRagConfig(getRagDeps().ragEnv())` is deep-equal (config and warnings) to
  the config loaded from the same input with the twelve keys removed, i.e. the old input, with
  the layer on and off.
- Layer off with all twelve set to non-defaults: every `queryAdditions.effective` value is false
  and `modelRouting.mode` is `off`.
- `tests/rag/query/parity-off.test.ts` (layer off equals Phase 4 retrieval) passes unchanged.
- The only other place the new keys reach is `memoKey` in `config.ts` (the memo cache key), which
  changes no output.

## Merge notes for the train
- origin/exec/06.2-24: `git merge-tree` against this branch is clean. Its speculative line is
  byte-identical and at the same position (after RAG_QUERY_HISTORY_FALLBACK).
- origin/exec/06.2-36 (unmerged) adds `RAG_SCOPE_GATE: process.env.RAG_SCOPE_GATE,` and
  `RAG_WHATSAPP_HISTORY: process.env.RAG_WHATSAPP_HISTORY,` after RAG_TRANSLATION_GLOSSARY, without
  the env.ts fallback. This branch has the two lines at the same position with the fallback, so
  the merge conflicts on exactly those two lines. Resolve by taking this branch's lines; behaviour
  is the same.
- The other new reads sit at the end of the object, away from both branches' hunks.

## 06.2-32 plan update needed
06.2-32 (wave 13, D-28 config sync and boundary rules) does not list `src/lib/rag/deps.ts` in
`files_modified`. Recommendation: mark the "D-28 switches reach the RAG config through the
default deps" item as done by quick 261127-dsw and add a truth that
`tests/rag/query/deps-env-input.test.ts` stays green. If the plan is edited anyway, also add
`src/lib/rag/deps.ts` to `files_modified` so that any switch added later is wired there.
Not edited here: plan files belong to the planner.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no Phase 1 type errors, 0 legacy diagnostics ignored
- `node scripts/check-config.mjs`: ok, 274 variables, 0 violations
- `node scripts/ci/check-rag-boundary.mjs`: ok, 2651 files
- `node scripts/ci/check-settings-classification.mjs`: ok, 226 variables
- `node scripts/ci/check-language-literals.mjs`: ok
- `npx vitest run tests/rag/query tests/rag/v2`: 93 files, 1322 tests passed (includes parity-off and the new file)
- `npx vitest run` on the other 85 test files that import `@/lib/rag/deps`: 1640 tests passed
- `node --import tsx --test tests/rag-e2e/scopes-dates-v2.test.mts` (imports deps): 12 passed
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-dsw-ingest`: gate PASS (enforce, strict; 8 skipped)

## Deviations
None. No default, manifest, migration or Config UI change.
