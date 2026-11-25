---
phase: 05-verified-citations-groundedness
plan: 10
subsystem: config
tags: [config, check-config, models, anthropic, citations, config-ui]
status: complete

requires:
  - phase: 05-verified-citations-groundedness
    provides: "05-02: last edit of the five config files and check-config (ANTHROPIC_* tracking)"
provides:
  - "Claude 5.5 family (opus, sonnet, haiku) in the five model locations, each with anthropicId"
  - "check-config model check: anthropicId agreement across init-env, config-server, env.ts, the three Config UI fallback arrays and .env.local"
  - "anthropicIdFor(modelId, source = process.env) in src/lib/rag/generation/citations/models.ts"
affects: [05-11, 05-16, 05-25, 05-26]

actuals:
  tokens: 7200
  tasks: 3
  commits: 5
plan_head_before: 01b43787dbe6c49e3616084bb5f79f3ea3db5d22
plan_head_after: c89b933d

tech-stack:
  added: []
  patterns:
    - "Model lists are scanned as array literals (JSON or JS object literals) from fixed anchors; a mapped id must agree everywhere, unmapped ids stay free"
    - "Call-time model lookup: process.env first, env.ts default when the variable is empty; malformed list means no direct path"

key-files:
  created:
    - src/lib/rag/generation/citations/models.ts
    - tests/rag/citations/models.test.ts
  modified:
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - src/lib/env.ts
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/config-ui/index.html

key-decisions:
  - "Task 1 (D-08): option-a. Add anthropic/claude-opus-5.5 -> claude-opus-5-5, anthropic/claude-sonnet-5.5 -> claude-sonnet-5-5, anthropic/claude-haiku-5.5 -> claude-haiku-5-5; Sonnet 4.5 and Opus 4.1 stay unmapped; isDefault unchanged. Decided on the user's standing instruction to decide by recommendation."
  - "The OpenRouter ids of the 5.5 family are assumed (research A6); live confirmation with GET /v1/models is plan 05-26"
  - "New entries: supportsReasoning true, reasoningMethod 'effort' (adaptive thinking with effort only on the 5.5 family), contextLength 1000000"
  - "check-config skips a .env.local NEXT_PUBLIC_OPENROUTER_MODELS that is empty (runtime uses the env.ts default) or has no readable list (every model then lacks anthropicId, so no direct path)"

requirements-completed: [GEN-01]

duration: 15min
completed: 2026-11-25
---

# Phase 5 Plan 10: anthropicId model map and its five-location check

**The Claude 5.5 family maps to Anthropic ids identically in all five model locations, check-config fails when any location disagrees, and `anthropicIdFor` answers the lookup at call time.**

## Task 1 decision (checkpoint:decision, gate blocking-human)

The orchestrator passed the answer: **option-a**. It was decided under the user's standing instruction to decide by recommendation.

| OpenRouter id | anthropicId |
|---|---|
| `anthropic/claude-opus-5.5` | `claude-opus-5-5` |
| `anthropic/claude-sonnet-5.5` | `claude-sonnet-5-5` |
| `anthropic/claude-haiku-5.5` | `claude-haiku-5-5` |
| `anthropic/claude-sonnet-4.5` | none (retires 2026-11-30) |
| `anthropic/claude-opus-4.1` | none (retired) |

**The OpenRouter ids are assumed (research A6).** Plan 05-26 confirms them, together with every Anthropic id, through a live GET /v1/models. `isDefault` is still on `anthropic/claude-sonnet-4.5`; moving it is the Phase 7 release-default decision (ADM-02).

Model fields come from the current Anthropic model table (claude-api skill, cached 2026-11-03). All three have a 1M context window. Thinking is adaptive only, `budget_tokens` is rejected, and depth is set with effort. That gives `supportsReasoning: true`, `reasoningMethod: 'effort'` and `contextLength: 1000000`.

## Tasks and commits

| Task | Commits |
|------|---------|
| 1. Model choice | decision only (option-a) |
| 2. Five-location anthropicId check | `c3b9a6aa` test (RED: 6 cases failed on exit-code assertions), `331b7ec4` feat |
| 3. Mapped entries and anthropicIdFor | `70692509` test (RED: 3 cases failed against a null stub), `b8755f33` fix (check-config .env.local edge, see Deviations), `c89b933d` feat |

## What changed

- `scripts/check-config.mjs`: the new `checkModelMappings(root, texts)` export runs inside `checkConfig`. It reads the OpenRouter list from fixed anchors:
  - `DEFAULT_OPENROUTER_MODELS = '…'` in init-env and config-server;
  - `NEXT_PUBLIC_OPENROUTER_MODELS: process.env… || JSON.stringify([` in env.ts;
  - the three Config UI fallback arrays (`defaultOpenRouterModels = … JSON.stringify(`, `safeJsonParse(defaultOpenRouterModels, [`, and the non-empty `openrouterModels: [{` in the catch block);
  - `.env.local`, when it sets the variable to a readable list.

  It reports four kinds of problem. First, an id that carries `anthropicId` anywhere but is missing from a location, listed there without one, or listed with a different value. Only the locations that differ from the majority are reported, and the message lists every `location=value` pair. Second, an `anthropicId` that does not match `^claude-[a-z0-9-]+$`. Third, an `anthropicId` on an id outside `anthropic/`. Fourth, a list that cannot be found while mapped ids exist. Unmapped ids keep their current freedom.
- Five model locations: three entries appended after `Claude Opus 4.1`. The order of the existing models and every existing flag are unchanged (`git diff` touches no `isDefault`).
- `src/lib/rag/generation/citations/models.ts`: `anthropicIdFor(modelId, source = process.env)`. It reads `NEXT_PUBLIC_OPENROUTER_MODELS` on every call and falls back to the env.ts default when the variable is empty. It parses the list with a zod/v3 passthrough schema. It returns null for an unknown id, an unmapped id, a malformed list, or a malformed or non-anthropic mapping.
- `tests/rag/characterize-chat.test.ts` still picks the same non-GPT, non-Claude model (`google/gemini-2.5-flash-lite`), because the new ids contain `claude`.

## Deviations from Plan

**1. [Rule 1 - Bug] The .env.local list compare failed on an empty or unreadable value**
- **Found during:** Task 3. The existing case "warns on cloud-off with legacy…" writes `init-env.js` text as `.env.local`, so the variable holds a template literal. Once mapped ids existed, it failed with "list not found".
- **Fix:** skip `.env.local` when the value is empty (the runtime `||` falls back to the env.ts default) or holds no readable array (every model then lacks an anthropicId, so there is no direct path). A new empty-value assertion failed on the old code.
- **Files:** `scripts/check-config.mjs`, `scripts/check-config.test.mjs`
- **Commit:** `b8755f33`

No other deviations. Migration numbers: none used.

## Gates (targeted, per the brief)

- `node --test scripts/check-config.test.mjs`: 34/34 pass. `node scripts/check-config.mjs`: ok (135 variables).
- `npx vitest run`: 17 files and 246 tests pass. The run covered `tests/rag/citations/models.test.ts`, `tests/rag/characterize-chat.test.ts`, `characterize-chat-overview`, `embed-route`, `tests/rag/citations/`, `tests/rag/generation/`, `v2/routes-two-tenant-v2`, `v2/route-filters`, `ingest/invoice-extract-stage` and `ingest/detect-doc-type`, which are every suite that reads the model lists.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`: ok.
- Acceptance greps: `anthropicId` appears 10 times in check-config.mjs (≥2), 18 in check-config.test.mjs (≥3), 9 in config-ui/index.html (≥3) and 3 in env.ts (≥1). `export function anthropicIdFor` appears 1 time (==1).
- Not run: the full vitest and node suites, Python, gen:schemas and test-rag. No Python, contract, retrieval, ingest or golden file was touched.

## Design skills

| Skill | Outcome |
|-------|---------|
| frontend-design | n/a. The change adds model entries to existing arrays and builds no new interface. |
| Impeccable | n/a, for the same reason. |
| web-design-guidelines | pass. Ran on the 9 changed lines in `scripts/config-ui/index.html` and on how `renderModels` displays them; the hunks have no findings. The entries show as a display name (short), the model id and the existing reasoning icon; `anthropicId` and `contextLength` are not rendered. |

Problems already in `renderModels` when this plan ran were outside its hunks. Merge train 8 brings `exec/fix-config-ui-bugs`, which resolves all four (`.planning/quick/2026-11-25-config-ui-fixes.md`): status icons get `role="img"` and `aria-label`, Move up/down buttons give a keyboard alternative to drag-to-reorder, Remove asks for confirmation in a `<dialog>`, and `displayName` and `id` are rendered through `textContent`.

## Deferred

- The TypeScript `Model` / `ModelWithReasoning` interfaces (`src/components/providers/model-provider.tsx`, `src/app/api/config/models/route.ts`) do not declare `anthropicId`. JSON passes it through unchanged, and the Config UI save path keeps it because it posts the whole model objects. The field docs are plan 05-25 (AGENTS.md §7).
- The Config UI "add model" form has no anthropicId input. A model added there takes no direct path, which is the safe default.
- `src/components/providers/model-provider.tsx` has its own hardcoded fallback list (not one of the five locations), which still lists only the 4.5 and 4.1 entries.

## Threat model

- T-05-27 (drift or malformed mapping): mitigated by `checkModelMappings` and its 7 new cases.
- T-05-28 (retired model): mitigated by mapping only the current 5.5 family. 404 fallback and live confirmation are plans 05-16 and 05-26.
- T-05-SC: no package installed.

## Self-Check: PASSED

- FOUND: src/lib/rag/generation/citations/models.ts, tests/rag/citations/models.test.ts
- FOUND commits: c3b9a6aa, 331b7ec4, 70692509, b8755f33, c89b933d (all ancestors of HEAD)
