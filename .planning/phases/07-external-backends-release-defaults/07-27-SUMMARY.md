---
phase: 07-external-backends-release-defaults
plan: 27
subsystem: docs
tags: [docs, agents-md, env-template, env-manifest, generated-tables, adm-03, adm-04]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-13 sync CLI and scheduler recipe; 07-16 backend canary; 07-18 manifest metadata; 07-20 Config UI RAG pipeline section; 07-21 vendor data-flow doc; 07-25 regression workflow"
  - phase: 05.1.1-feedback-loop-and-real-domain-test-set-thumbs-failed-query-m
    provides: "05.1.1-22 review queue, promotion, failure and weekly report lines in AGENTS.md"
  - phase: 05-verified-citations-groundedness
    provides: "05-25 last Phase 5 AGENTS.md editor"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-45 last Phase 6 AGENTS.md editor"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-22 Phase 5.1 close"
provides:
  - "README_RAG_PIPELINE.md: Sidecar, Providers and switches, Vector sync (scheduler, keys and rotation), Backends, Evaluation workflow, Data flow"
  - "scripts/rag/gen-pipeline-doc.mjs: renderSwitchTables(manifest), extractGenerated, replaceGenerated, --check"
  - "scripts/init-env.js: the 220 managed variables under ten `# RAG: <group>` banners with their manifest label directly above each"
  - "AGENTS.md: §2 vector backends row, §6 retrieval backend line and a RAG pipeline subsection, §16 four commands, §17 the new README"
affects: [07-33, 07-43]

actuals:
  tokens: 70000
  tasks: 3
  commits: 7  # 3 RED, 3 GREEN, SUMMARY

tech-stack:
  added: []
  patterns:
    - "Generated Markdown regions between fixed markers; the generator rewrites only the region and --check exits 1 on drift"
    - "Group order and English group titles come from scripts/config-ui/rag-panels/rag-pipeline.js (createRequire), so the README, the env template and the Config UI share one source"

key-files:
  created:
    - README_RAG_PIPELINE.md
    - scripts/rag/gen-pipeline-doc.mjs
    - tests/rag/rag-pipeline-doc.test.ts
    - tests/rag/env-template-groups.test.ts
  modified:
    - scripts/init-env.js
    - AGENTS.md
    - tests/rag/agents-guide.test.ts

key-decisions:
  - "Precondition met: 05-, 05.1- and 06-VERIFICATION.md are status human_needed; all 448 transitive depends_on plans have a SUMMARY on this branch."
  - "The manifest has group ids but no group labels. The labels are the English Config UI group titles (RAG_PIPELINE_LABELS.en['group.<id>.title']) and the order is RAG_PIPELINE_GROUP_ORDER, imported by the generator; the env-template test reuses the same functions, so README, template and UI cannot disagree."
  - "The generated region holds a provider table (provider id, display name, its managed url and secret variables) and one table per group; rows sorted by name; secrets show (secret), empty defaults (empty)."
  - "init-env.js was regrouped by a one-off transform (not committed): each managed line moves with the comment lines directly above it, then gets its manifest label as the line directly above; notes left in an emptied section follow the managed line before them. Within a group the template order is kept. The 15 sections left without any variable lost only their banner; every assignment line and every other comment line is preserved (checked by diffing the sorted assignment and comment lines). Legacy variables and their sections are untouched. The RAG block sits where the first managed variable's section was."
  - "Managed variables that are not RAG_-prefixed (WEAVIATE_*, QDRANT_*, LANGFUSE_*, COHERE_*, ANTHROPIC_*, VOICE_MAX_ACTIVE_ROOMS, REDIS_URL, NEXT_PUBLIC_RAG_INGEST_REALTIME, ...) move under their manifest group banner too, as the must-have says every managed variable."
  - "AGENTS.md: the tenant fragment `external vector stores always filter by tenant` sits in the new RAG pipeline subsection (§6, before Image RAG); the review queue, promotion and failure report are linked to the existing Phase 5.1.1 lines, not restated."
  - "The README URL test allows example.com, localhost, manifest default hosts (cloud.langfuse.com) and a short documentation-host list; the key test flags sk-, eyJ and 32+ hex or base64 runs."

patterns-established:
  - "A manifest label or group change shows up in three places at once: run `node scripts/rag/gen-pipeline-doc.mjs` and move the init-env.js line under its banner, or tests/rag/rag-pipeline-doc.test.ts and tests/rag/env-template-groups.test.ts fail"

requirements-completed: [ADM-03, ADM-04]
---

# Phase 7 Plan 27: RAG pipeline documentation Summary

**README_RAG_PIPELINE.md with switch tables generated from the env manifest, the env template grouped under `# RAG: <group>` banners, and the AGENTS.md RAG pipeline section.**

## Commits

| Task | RED | GREEN |
| --- | --- | --- |
| 1 Generated tables and README | 3bbe6b98 | 8e795be7 |
| 2 Env template banners | e6704123 | 6ddaf246 |
| 3 AGENTS.md | 0d115990 | 36428c16 |

## Behaviour changes

None at runtime. `scripts/init-env.js` writes the same variables with the same values (the derived eval pin is unchanged: `eval-env.mts --check` passes); only their order and comments in a new `.env.local` differ. Existing `.env.local` files are not touched.

## Tests that failed before the change

- tests/rag/rag-pipeline-doc.test.ts: 22 of 27 (missing markers, sections and fragments) on the stub README.
- tests/rag/env-template-groups.test.ts: 221 of 223 (variables under the old section banners).
- tests/rag/agents-guide.test.ts: 8 new fragments and the link test.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all pass.
- `node scripts/rag/gen-pipeline-doc.mjs --check` and `node scripts/rag/gen-vendor-doc.mjs --check`: up to date.
- `npx tsx eval/harness/eval-env.mts --check`: pin matches.
- vitest on every test file that reads AGENTS.md, init-env.js, the README, the generator or rag-pipeline.js, plus tests/eval-env-pin.test.ts: 12 files, all passed (8 skipped are pre-existing skips in those files).
- `node --test scripts/check-config.test.mjs`: 91 passed; `node --import tsx --test tests/rag-db/phase42-schema.test.mts`: 30 passed.
- Not run (not touched): rag-db SQL suites, pytest, gen:schemas, test-rag, workflows check. No test split, eval run or gate was used, so the test-split ledger stays at 26 and no pre-registration was needed.

## Deviations

- Group labels taken from the Config UI titles instead of the manifest (the manifest carries no group labels); see key decisions.
- The generated region also renders a provider table, so "every provider" in the must-haves is generated, not hand-written.

## Operator actions

None new. The README documents existing operator steps (schedule file, Vercel Cron or Schedules, key rotation, live regression).

## Deferred

- The config-server.js templates that list RAG switches are not regrouped (out of this plan's files).
- The README's scheduler and fallback wording should be re-read once 07-33 records the live regression and live latency (voice backend advice).

## Self-Check: PASSED
