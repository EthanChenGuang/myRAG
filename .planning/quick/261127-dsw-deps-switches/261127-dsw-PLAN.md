---
quick_id: 261127-dsw
slug: deps-switches
base: origin/ci/merge-train-39
branch: exec/quick-deps-switches
files_modified:
  - src/lib/rag/deps.ts
  - tests/rag/query/deps-env-input.test.ts
---

# Quick 261127-dsw: Phase 6.2 D-28 switches read by the default RAG deps

## Problem
`readRagEnvInput()` in `src/lib/rag/deps.ts` builds the `RagEnvInput` every pipeline reader
passes to `loadRagConfig`. Several Phase 6.2 D-28 switches were never added to it, so setting
them in the deployment environment changes nothing: `loadRagConfig` sees `undefined` and keeps
the code default.

## Tasks
1. RED: `tests/rag/query/deps-env-input.test.ts`, table-driven over all twelve D-28 switches:
   set in `process.env` -> present in `getRagDeps().ragEnv()` and in the loaded config; unset ->
   the `env.ts` default. Parity-off: with the switches unset, the config equals the config
   built without them (layer on and off); with the layer off every switch stays inert.
2. GREEN: add the missing reads with the 06.2-17/06.2-20 form
   `process.env.X ?? env.X`; add the `env.ts` fallback to the two reads that lack it. The
   speculative line is byte-identical to origin/exec/06.2-24 and at the same position.
3. Check env-manifest / check-config for the 06.2 violations; fix only if a manifest entry is
   the cause.
4. Gates, SUMMARY.
