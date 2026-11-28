---
quick_id: 261127-cuf
slug: config-ui-fixes
type: quick
branch: exec/quick-config-ui-fixes
base: origin/ci/merge-train-39
ui: true
files_modified:
  - scripts/config-ui/rag-panels/embedding-bindings.js
  - scripts/config-ui/rag-panels/languages.js
  - scripts/rag/language-settings-context.js
  - scripts/config-server.js
  - tests/ui/config-embedding-bindings-panel.test.ts
  - tests/ui/config-languages-panel.test.ts
  - scripts/tests/config-server-languages.node-test.mjs
  - scripts/tests/init-env-languages.node-test.mjs
  - .planning/phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/03.1.1-UI-SPEC.md
  - .planning/phases/03.2-language-support-ingestion-hardening/03.2-UI-SPEC.md
---

# Quick 261127-cuf: Config UI fixes (embedding bindings panel, Languages panel)

Two groups only. Every fix starts with a test that fails on an assertion (tests/ui or scripts/tests); zh/en/it copy
stays in step where the panel is localized.

## Task 1: Languages panel (owner walkthrough)

1. Stale primary announcement: choosing a primary radio announces the new primary; Reset selection clears the line.
2. "could not be read from the database": the config server never reads the active-profile pointer. With
   `RAG_EMBEDDING_PROFILES=off` the active profile *is* the legacy profile (`getActiveProfile()` returns `LEGACY_PROFILE`
   without a database), so the check against the default declaration is a check against the active profile: report it
   verified. Otherwise report why (`notVerifiedReason`: `profiles_on`, `default_not_active`, `no_declarations`) with honest copy.
3. The groundedness warning shows once: the inline note under the table; the post-save alert drops a
   `groundedness_not_checked` warning that the note already shows.

## Task 2: Embedding bindings panel (03.1.1-UI-REVIEW BLOCKER 1, WARNINGs 2-15)

Mobile table, "Close form", submit disabled with no scoped profile, no "recorded against None", form.profile.none spec
parity, proxy/5xx error alert with Try again, single no-profile sentence, soft switch-off note, visible gated Activate,
outlined non-wrapping Retire, left-aligned CLI hint, items-start warning icon, formOpen reset on 401, one message on 503,
explicit mono sizes and the double spacing.

## Task 3: Review loop

gsd-ui-checker on 03.1.1-UI-SPEC (sign-off), /gsd-ui-review 03.1.1, Playwright screenshots back into
`03.1.1 …/screenshots/`.

## Gates

tsc, typecheck:new, check-config, check-frontend-design-summary, `npx vitest run tests/ui`, config-server node tests.
