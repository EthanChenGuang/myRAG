---
phase: 07-external-backends-release-defaults
plan: 18
subsystem: config
tags: [config-ui, env-manifest, check-config, metadata, secrets]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "vector-backend names in the manifest and five locations (07-04)"
  - phase: 01-evaluation-harness-baseline
    provides: "check-config and the env manifest (01-11)"
  - phase: 04.1-hybrid-retrieval-and-rerank-on-by-default-proven-by-eval
    provides: "eval/decisions/04.1-retrieval-defaults.json with status and implicit_in_templates (04.1-09)"
  - phase: 05-verified-citations-groundedness
    provides: "Phase 5 switches (closing plan 05-25)"
  - phase: 05.1-prompt-injection-defense
    provides: "Phase 5.1 switches (closing plan 05.1-22)"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "Phase 6 switches (closing plan 06-45)"
provides:
  - "scripts/rag/env-manifest.json: group, label, type, options, requires, default, provider and help on all 196 managed entries"
  - "scripts/check-config.mjs checkEntryMetadata: the D-14 metadata rules, sorted violations under location manifest"
  - "scripts/check-config.mjs generated-section rule: with index.html loading rag-panels/rag-pipeline.js, a managed entry with complete metadata counts as present in config-ui"
affects: [07-20, 07-45, 07-19]

actuals:
  tokens: 25400
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "check-config reuses the config server's secret rule through createRequire(import.meta.url) and isSecretConfigEntry(name, '')"
    - "Manifest default equals the scripts/init-env.js template line NAME=value; a secret default is always empty"

key-files:
  created: []
  modified:
    - scripts/rag/env-manifest.json
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs

key-decisions:
  - "Precondition: 05-, 05.1- and 06-VERIFICATION.md do not exist on any origin branch. Every automated plan of Phases 5, 5.1 and 6 has a SUMMARY on this branch (only the human plan 06-46 has none) and the depends_on closing plans 05-25, 05.1-22 and 06-45 are present, which is what the precondition protects (every 5, 5.1 and 6 switch is in the manifest). Proceeded instead of stopping."
  - "04.1 D-25 empty-default rule applies only while the 04.1 decision has status flip. The committed record is not_flipped and init-env.js ships RAG_PIPELINE=legacy, so RAG_PIPELINE keeps default legacy and the default-equals-template rule holds; a flip makes check-config demand an empty default for every implicit_in_templates name."
  - "Help lines come from the hand-written inputs between the Evaluation & Sidecar card and the Info Box of the RAG Modes tab (now ten cards, 149 managed inputs, not seven cards and 88). A trailing <code> that only repeats the entry's own name is dropped (the generated row already shows the name); where that leaves nothing, no help field. Hidden status paragraphs are not help. 83 entries carry help; entries in #rag-ingestion-settings, #rag-phase032-settings and the two inputs beside the mode selector (RAG_ANSWER_STYLE, RAG_HISTORY_NOT_EVIDENCE, which stay) get none."
  - "Labels: the hand-written label with a trailing (NAME) removed; long sentence labels and context-free ones (Base URL, Pipeline, Framework) were shortened to short phrases; the 47 entries without a RAG Modes input got hand-written labels."
  - "Provider ids for url and secret entries: vendor ids from D-20 where one applies (anthropic, cohere, deepinfra, lakera, langfuse, voyage, weaviate, qdrant, sidecar; REDIS_URL is sidecar). App-internal signing secrets (RAG_EVAL_SECRET, RAG_VOICE_TOKEN_SECRET, RAG_EMBED_FEEDBACK_SECRET, RAG_VECTOR_SYNC_SECRET) use app, the monitor webhook pair uses webhook, the fine-tune slot endpoint uses ft_endpoint; the UI shows unknown ids in mono with no probe (07-UI-SPEC 6.2.4)."
  - "requires holds only dependencies the init-env.js comments or AGENTS.md state as a single required value (NAME=value) or a non-empty name (NAME); OR conditions (citation per sentence), 'not off' conditions (retrieval log, config gate, injection check) and secrets are not listed, because the generated row would disable a control the user still needs."
  - "Type rules: secret when isSecretConfigEntry(name, '') holds, url for other *_URL names, enum when the init-env.js comment lists a | b options (or the hand-written select does), bool only for true/false, number for numeric defaults, otherwise string. RAG_EMBED_TENANT and RAG_MAX_OUTPUT_TOKENS are string (free-form or integer values)."
  - "A managed entry whose name appears in init-env.js without a NAME= line is reported; a name absent from init-env.js is left to the existing presence check, so a fixture violation is reported once."
  - "Commit order deviation: manifest metadata was committed before the check-config rules so no commit leaves check-config failing on the real tree."

patterns-established:
  - "New managed switch: add the D-14 metadata (group, label, type, options for enums, requires, default equal to the init-env.js template, provider for url and secret, optional single-line help) in the same change, or check-config fails"

requirements-completed: [ADM-01]

coverage:
  - id: D1
    description: "check-config refuses a managed entry with missing or invalid metadata, a bool default other than true/false, a filled secret default, a default that differs from init-env.js, and a type that disagrees with secret detection"
    requirement: ADM-01
    verification:
      - kind: unit
        ref: "node --test scripts/check-config.test.mjs (15 cases named metadata)"
        status: pass
  - id: D2
    description: "Every managed manifest entry carries complete metadata; on/off switches are enums; the evaluation-endpoint and Lakera security notes are kept in help"
    requirement: ADM-01
    verification:
      - kind: unit
        ref: "node scripts/check-config.mjs; scripts/check-config.test.mjs#metadata: every managed entry of the real manifest is complete and on/off switches are enums"
        status: pass
---

# Phase 7 Plan 18: Manifest metadata for the generated Config UI section

Every managed variable now describes itself for the generated "RAG pipeline" section (plan 07-20), and check-config refuses a managed switch without that metadata.

## Performance

- Tasks: 2, commits: 4 (RED tests, manifest metadata, check-config rules, this summary)
- Files modified: 3

## Accomplishments

- 196 managed entries carry metadata: groups data 55, retrieval 26, security 21, generation 20, query 19, observability 17, ranking 13, backends 10, sidecar 8, evaluation 7; types bool 71, enum 46, number 25, string 23, secret 20, url 11.
- On/off switches (RAG_INGEST_ASYNC, RAG_EMBEDDING_PROFILES, RAG_PARSE_ESCALATION, RAG_FINETUNE, RAG_DOMAIN_EMBEDDINGS, RAG_DOC_ACCESS_GROUPS, RAG_DOC_TRANSLATION, RAG_LANGUAGE_AWARE_INGEST, RAG_SUPERSESSION_DETECT, RAG_SECTION_RULES, RAG_INGEST_MAINTENANCE) are enums with options in init-env.js comment order.
- `help` keeps the hand-written lines word for word, including "The endpoint returns document content. Keep it off in production unless an evaluation run needs it." and "⚠️ Sends chunk text to Lakera, a third party. Listed in the vendor inventory (ADM-04)."
- `checkEntryMetadata` in scripts/check-config.mjs, and the generated-section presence rule keyed on `rag-panels/rag-pipeline.js` (inactive until plan 07-20 adds the loader; the literal check stays until then).

## Task Commits

1. Task 1 RED: `85c09673` test(07-18): add failing check-config metadata rule cases (D-14)
2. Task 2: `0cc7d852` feat(07-18): add Config UI metadata to every managed manifest entry (D-14)
3. Task 1 GREEN: `ec99d426` feat(07-18): enforce manifest metadata and the generated Config UI section in check-config (D-14)

## Tests that failed before the change

13 of the 15 new metadata cases failed on assertions at `85c09673` (the other two, a complete entry and a legacy entry, pass by design; the 64 older cases passed); all 79 pass now. Mutation on a copy of the real tree (RAG_INGEST_ASYNC typed bool with default off, QDRANT_API_KEY typed string, RAG_SIDECAR_URL without provider) gives exactly three violations and exit 1.

## Behaviour changes

- `node scripts/check-config.mjs` reports new `[manifest]` violations for managed entries; legacy entries are unchanged. No runtime code, switch default or Config UI markup changed.
- Older synthetic fixtures in scripts/check-config.test.mjs get complete metadata from a helper (`withFixtureMetadata`), so each still tests only its own rule.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: ok
- `node --test scripts/check-config.test.mjs scripts/tests/check-settings-classification.node-test.mjs scripts/tests/config-server-rag-gate-routes.node-test.mjs scripts/tests/config-server-security.node-test.mjs scripts/tests/rag-settings-hash.node-test.mjs`: 106 passed
- `npx vitest run tests/lib/rag-settings-hash.test.ts tests/ui/config-phase44-switches.test.ts` (test files that read the manifest or config-server-security): 41 passed
- rag-sidecar `pytest -q tests/test_settings_classification.py` (reads the manifest): 30 passed
- Not run (area untouched): rag-db, test-rag, gen:schemas, check-workflows, frontend-design summary (no UI change).

## Deviations

- Precondition and commit order: see key-decisions 1 and 9.
- The RAG Modes tab now holds ten settings cards and 149 managed inputs (the plan counted seven and 88); help was taken from all of them.

## Operator actions

None.

## Deferred

- Plan 07-20 adds `rag-panels/rag-pipeline.js` and its loader; only then does the generated-section rule replace the literal config-ui presence check.
- A later rule could check `provider` against the D-20 vendor inventory once `config/rag/vendor-data-flow.json` exists.
