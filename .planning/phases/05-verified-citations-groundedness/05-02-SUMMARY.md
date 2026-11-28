---
phase: 05-verified-citations-groundedness
plan: 02
subsystem: config
tags: [config, env, check-config, citations, groundedness, anthropic, config-ui]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: last edits to env.ts, init-env.js, config-server.js templates, the manifest and check-config (04-02); last Config UI edit (04-36)
provides:
  - Ten D-21 variables in the five config places and the manifest, all off by default
  - check-config tracks ANTHROPIC_* names
  - readGenerationConfig(source), GenerationConfig, GenerationEnvSource, DEFAULT_ANTHROPIC_BASE_URL in src/lib/rag/generation/config.ts
affects: [05-10, 05-12, 05-13, 05-14, 05-16, 05-21, 05-25]

actuals:
  tasks: 3
  commits: 7
plan_head_before: b4ec4a8
plan_head_after: see git log exec/05-02

tech-stack:
  added: []
  patterns:
    - "Call-time config reader returns a frozen object; only the trimmed literal 'true' turns a switch on"
    - "Empty or whitespace ANTHROPIC_BASE_URL means the default URL (research P-3); a trailing slash is dropped"

key-files:
  created:
    - src/lib/rag/generation/config.ts
    - tests/rag/generation/config.test.ts
  modified:
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - scripts/rag/env-manifest.json
    - src/lib/env.ts
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - eval/config/rag-eval-env.json

requirements-completed: [GEN-01, GEN-05, GEN-07, EVAL-16]
---

# Phase 5 Plan 02: Switches, check-config and the generation config reader

**Ten citation and groundedness switches, all off, mirrored in every config place; check-config now refuses an unmirrored `ANTHROPIC_*` variable; one call-time reader gives later plans a typed view.**

## Tasks and commits

| Task | Commits |
|------|---------|
| 1. Track ANTHROPIC_ names in check-config | `81ecfd4` test (RED: 2 cases failed), `c2fc8df` feat |
| 2. Ten variables in the five config places | `7ec3a2c` feat, `2f2074b` fix (web-design-guidelines pass on the new card) |
| 3. Call-time generation config reader | `b1f7346` test (RED: 7 cases failed on assertions against a stub), `cdb45e0` feat |

## What changed

- `scripts/check-config.mjs`: `NAME_PATTERN` gains `ANTHROPIC_[A-Z0-9_]+`. Nothing else changed. New cases: an `ANTHROPIC_API_KEY` read in `src/` but missing from the manifest fails; listed as managed but missing from the Config UI fails for `config-ui`; `MY_ANTHROPIC_API_KEY_X` and `XANTHROPIC_KEY` are not discovered.
- Variables and defaults: `RAG_CITATIONS=false`, `RAG_CLAUDE_CITATIONS=false`, `ANTHROPIC_API_KEY=`, `ANTHROPIC_BASE_URL=`, `RAG_GROUNDEDNESS=false`, `RAG_GROUNDEDNESS_VECTARA_OPT_IN=false`, `RAG_GROUNDEDNESS_TIMEOUT_MS=20000`, `RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS=3000`, `RAG_ANSWER_FEEDBACK=false`, `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false`. They are in `src/lib/env.ts`, a "Verified citations and groundedness" section of `scripts/init-env.js`, all three templates of `scripts/config-server.js`, the Config UI and the manifest (managed, alphabetical position).
- Config UI: a new "Citations and groundedness" card after Langfuse tracing. It has six checkboxes, two number inputs (timeout 1–55000, premise cap 256–8000), a password input for `ANTHROPIC_API_KEY` with the existing delegated reveal button, and a text input for `ANTHROPIC_BASE_URL` marked "for tests and recorded streams only". The help text for the multi-tenant acknowledgement says to tick it only after the Vectara data-retention terms were recorded in live verification. The existing generic loader and saver handle the fields by id.
- `ANTHROPIC_API_KEY` is not in the 32-character secret warning list.
- `src/lib/rag/generation/config.ts`: `readGenerationConfig(source = process.env)` returns a frozen `GenerationConfig`, with no caching and no logging:
  - Defaults: everything off; `anthropicApiKey` null; `anthropicBaseUrl` `https://api.anthropic.com/v1`; timeout 20000; premise cap 3000.
  - Timeout: a non-number or a value ≤ 0 gives 20000; values above 55000 are clamped to 55000.
  - Premise cap: a non-number gives 3000; numbers are clamped to 256–8000, so 0 gives 256.
  - The API key is trimmed; empty gives null.

## Behaviour changes

None at runtime. Nothing reads the new switches yet, and every default is off.

## Deviations

1. **[Rule 3, blocking] `eval/config/rag-eval-env.json` regenerated.** The eval env pin test (`tests/eval-env-pin.test.ts`, part of the Task 2 verify command) derives every `RAG_*` default from `scripts/init-env.js`. After the new variables were added, the test failed until the file was rewritten with `npx tsx eval/harness/eval-env.mts --write`. That added eight `RAG_*` keys, all off or default. The change is committed with Task 2.
2. **Web-design-guidelines fixes on the new card**, applied in a separate commit:
   - `name` on the form controls;
   - `autocomplete="off"` and `inputmode="numeric"` on the number inputs;
   - `type="button"` on the reveal button;
   - `translate="no"` on the default URL;
   - `text-balance` on the heading;
   - the multi-tenant warning shown as body text with an icon (the warning yellow was unreadable on the light theme).
3. The reader trims `ANTHROPIC_API_KEY`. Whitespace is never part of a valid key.

## Design skills

| Skill | Outcome | What it found and changed |
|-------|---------|---------------------------|
| frontend-design | n/a | A settings card inside the existing Config UI. It follows the sibling Langfuse and retrieval cards (DaisyUI `card bg-base-200`, checkbox rows, two-column number grid) and adds no new visual direction. |
| Impeccable | pass | Rendered the card standalone with headless Chromium, using the page's Tailwind and DaisyUI CDN, at 1280 px and 375 px. No horizontal overflow at either width. Found: warning-yellow help text with low contrast on the light theme. Changed: body-text colour with a ⚠️ marker. |
| web-design-guidelines | all findings resolved | Found and fixed: missing `name` on controls, missing `autocomplete="off"` on number inputs, a reveal button without `type="button"`, the URL in the copy without `translate="no"`, and the heading without balanced wrapping. Labels use `for` or wrap their checkbox. The reveal button has an `aria-label`. |

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run typecheck:new`: 0 diagnostics.
- `npx vitest run`: 254 files, 4070 passed, 1 skipped.
- `node --import tsx --test tests/*.test.mts`: 166 pass, 0 fail.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1061 pass, 4 skipped, 4 fail. All 4 failures are pre-existing (see below).
- `node scripts/ci/check-rag-boundary.mjs`: ok. `node --test scripts/tests/check-rag-boundary.node-test.mjs`: 38 pass.
- `node scripts/check-config.mjs`: ok, 135 variables. `node --test scripts/check-config.test.mjs`: 27 pass.
- `uv run --directory eval python ../scripts/ci/check-workflows.py`: OK.
- Not required, so not run:
  - the Python suites: no Python changed;
  - `gen:schemas`: no contracts changed;
  - `test-rag`: no retrieval, ingest or golden-set code changed.

### Pre-existing failure

`tests/rag-db/ingest-mode-routing.test.mts` fails 4 subtests: `--routing tiered` and `--force-tier structured|fast|premium`. The sidecar parse worker downloads `cl100k_base.tiktoken` from `openaipublic.blob.core.windows.net`, and the download fails in this container with `SSLError ... CERTIFICATE_VERIFY_FAILED ... self-signed certificate in certificate chain`. The test fails the same way (9 pass, 4 fail) on the base commit `b4ec4a8`, which was checked out in a separate worktree. This environment needs network access to that host, or the tiktoken cache baked in.

## Decisions for STATE

- The generation switches are read only through `readGenerationConfig`. Only the trimmed literal `true` turns a switch on. An empty `ANTHROPIC_BASE_URL` means the default URL.
- Clamp ranges: timeout 1–55000 ms (inside the 60 s function limit); premise cap 256–8000 cl100k tokens.

## Operator actions

None. Every switch is off. `ANTHROPIC_API_KEY` stays empty until Claude Citations is enabled in a later plan.

## Deferred

- The sidecar-only `VECTARA_API_KEY`, `VECTARA_BASE_URL` and `HHEM_MODEL_REVISION` belong to plan 05-12.
