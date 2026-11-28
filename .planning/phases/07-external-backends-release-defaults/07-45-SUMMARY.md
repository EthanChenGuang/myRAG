---
phase: 07-external-backends-release-defaults
plan: 45
subsystem: rag-config
tags: [config, env, rollouts, language-confidence, revision-4]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-04 RagConfig backend section and config locations; 07-18 D-14 manifest metadata rules; 07-20 generated RAG pipeline Config UI section; 07-27 init-env group banners and generated README tables"
provides:
  - "RAG_ROLLOUTS (bool, default false) and RAG_LANG_CONFIDENCE (enum mapped | calibrated, default mapped) in env.ts, init-env.js, the three config-server.js templates, the manifest (D-14 metadata, group data), settings classification (query side), the rag-affecting list, the eval pin and README_RAG_PIPELINE.md"
  - "RagConfig.rollouts { enabled } and RagConfig.lang { confidence }; RolloutsConfig, LangConfig, LANG_CONFIDENCE_MODES and LangConfidenceMode exported from src/lib/rag/config.ts"
affects: [07-46, 07-47]

actuals:
  tokens: 60000
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "A new managed switch reaches the Config UI through the generated RAG pipeline section only; scripts/config-ui/index.html is not edited"

key-files:
  created: []
  modified:
    - src/lib/env.ts
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/rag/env-manifest.json
    - eval/config/rag-eval-env.json
    - README_RAG_PIPELINE.md
    - src/lib/rag/deps.ts
    - config/rag/settings-classification.json
    - src/lib/rag/config-gate/rag-affecting.generated.json
    - src/lib/rag/config.ts
    - scripts/check-config.test.mjs
    - tests/eval-env-pin.test.ts
    - tests/rag/config.test.ts
    - tests/rag/v2/params-hash.test.ts

key-decisions:
  - "Both switches sit in manifest group data (the group of the embedding-profile and language switches), next to RAG_DOMAIN_EMBEDDING_TIMEOUT_MS and RAG_LANGUAGE_AWARE_INGEST in every location"
  - "RAG_ROLLOUTS parses with parseNamedFlag (true/false, case and spaces normalised; anything else gives false and one [RAG Config] warning naming the variable); RAG_LANG_CONFIDENCE with parseNamedChoice (fallback mapped)"
  - "Both values join the loadRagConfig memo key and stay out of the retrieval config hash (rollouts change it later through the embedding profile they select, 07-47)"
  - "Both are classified query side in config/rag/settings-classification.json, so they never change the ingestion fingerprint"

requirements-completed: [LANG-10, LANG-11, ADM-01]
---

# Phase 7 Plan 45: Revision-4 switches RAG_ROLLOUTS and RAG_LANG_CONFIDENCE

The two switches that the revision-4 features read (LANG-11 rollouts in 07-47, OBS-03 confidence calibration for LANG-10 monitoring in 07-46) exist in every config location with defaults that keep today's behaviour, and the app parses them into RagConfig. With both at their defaults nothing reads a rollout table and the query language confidence stays the FBK-01 three-value mapping.

## Tasks

| Task | Commits |
| --- | --- |
| 1. The two names in every config location, the manifest and the eval pin | `1db1a649` test (RED), `bd03e745` feat |
| 2. Parsed config fields | `220e7365` test (RED), `08c7a484` feat |

## Precondition

- 05, 05.1 and 06 VERIFICATION.md all read `status: human_needed`.
- All 458 transitive depends_on plans have a SUMMARY on this branch (base `eca55095`).

## Behaviour changes

None with the defaults. `RAG_ROLLOUTS=false` and `RAG_LANG_CONFIDENCE=mapped` are parsed but no code path reads them yet (07-46, 07-47 add the readers). The pgvector request hash is unchanged (pinned hash test).

## Tests that failed before the change

- `scripts/check-config.test.mjs`: "revision 4: both switches are managed with D-14 metadata ..." and "revision 4: dropping the options of RAG_LANG_CONFIDENCE reports exactly that entry" (assertions: entry missing).
- `tests/eval-env-pin.test.ts`: "pins the revision-4 switches at today's behaviour" (expected undefined to be 'false').
- `tests/rag/config.test.ts` "revision 4 defaults" (8 cases) and `tests/rag/v2/params-hash.test.ts` "the revision-4 switches are not inputs of the hash".

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors; `npm run typecheck:new`: ok
- `node --test scripts/check-config.test.mjs`: 93 passed
- `npx vitest run tests/eval-env-pin.test.ts tests/rag/env-template-groups.test.ts tests/rag/rag-pipeline-doc.test.ts`: 269 passed
- `npx vitest run tests/rag/config.test.ts tests/rag/v2/params-hash.test.ts`: 315 passed
- Full `npx vitest run` (env.ts and RagConfig changed): 871 files passed, 1 failed, 3 skipped; 16668 tests passed, 1 failed. The failure, `tests/rag/characterize-chat.test.ts` "builds the same system prompt or refusal for every fixture question and model kind" (the zh-compound refusal is now in the question's language, but the snapshot still has the English text), also fails alone and on the base `eca55095`. It was already failing and this plan cannot affect it (no generation or refusal code touched).
- `node scripts/check-config.mjs`, `node scripts/ci/check-rag-boundary.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: ok
- `node scripts/rag/gen-pipeline-doc.mjs --check`: ok (222 managed variables)
- Not run (area not touched): rag-db, Python, gen:schemas, test-rag, UI design check. No test split used.

## Deviations

- `src/lib/rag/deps.ts` (forwards both names into RagEnvInput, as in 07-04), `config/rag/settings-classification.json` (the classification check requires every RAG_* name) and `src/lib/rag/config-gate/rag-affecting.generated.json` (regenerated with `check-config.mjs --write-rag-affecting`) are outside files_modified; without them check-config and check-settings-classification fail.
- The hash-unchanged test lives in `tests/rag/v2/params-hash.test.ts` next to the pinned request hash rather than in config.test.ts.
- The fixture test for dropped options asserts that every violation names RAG_LANG_CONFIDENCE (the manifest metadata line plus the generated config-ui location, which cannot render an enum without options), not a single line.

## Operator actions

None.

## Deferred

- Pre-existing: the `tests/rag/characterize-chat.test.ts` snapshot drift (zh refusal text) on base `eca55095`; out of scope here.
