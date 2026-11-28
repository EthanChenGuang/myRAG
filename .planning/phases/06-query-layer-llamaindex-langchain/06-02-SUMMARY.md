---
phase: 06-query-layer-llamaindex-langchain
plan: 02
subsystem: config
tags: [env, config-ui, check-config, eval-pin, config-server-security, query-layer, semantic-cache]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-02 env recipe and check-config tests; 04-36 last Phase 4 Config UI edit (Retrieval pipeline card)"
  - phase: 05-verified-citations-groundedness
    provides: "05-02 / 05-10 last Phase 5 edits of the manifest and the five config locations"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-04 / 05.1-12 last Phase 5.1 edits of the manifest, env.ts, init-env.js, rag-eval-env.json, config-server.js and index.html"
provides:
  - "16 Phase 6 switches (RAG_QUERY_* and RAG_SEMANTIC_CACHE_*) and REDIS_URL as managed manifest entries, present in env.ts, init-env.js, the three config-server.js templates and the Config UI"
  - "Config UI Query layer card (after Retrieval pipeline): master switch, framework, query model, six transforms, voice allow-list, translate-disabled profiles, cache backend, REDIS_URL (password), TTLs, max distance, embed-store opt-in"
  - "REDIS_URL always classified as a secret by scripts/config-server-security.js"
  - "Eval pin: every new RAG_* default plus NEXT_PUBLIC_MCP_SYSTEM_ENABLED=true"
affects: [06-10, 06-13, 06-22, 06-27, 06-28, 06-30, 06-31, 06-40]

actuals:
  tokens: 11200
  tasks: 3
  commits: 9

tech-stack:
  added: []
  patterns:
    - "Phase 6 groups (# Query layer, # Semantic cache) sit right after the Prompt-injection defense group at every site"

key-files:
  created:
    - scripts/tests/config-server-security.node-test.mjs
    - tests/ui/config-query-layer-card.test.ts
  modified:
    - scripts/check-config.test.mjs
    - scripts/rag/env-manifest.json
    - src/lib/env.ts
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - eval/harness/eval-env.mts
    - eval/config/rag-eval-env.json
    - tests/eval-env-pin.test.ts
    - scripts/config-server-security.js
    - .github/workflows/pr-smoke.yml

key-decisions:
  - "REDIS_URL is in SECRET_VALUE_NAMES: its value never reaches the browser, and an empty field on save means unchanged (same as every other secret)"
  - "REDIS_URL is not pinned in the eval env (derivePinnedEvalEnv only takes RAG_* lines); the eval never needs Redis"
  - "Default-true transform checkboxes carry the HTML checked attribute, so a missing .env.local value shows the template default"

patterns-established:
  - "A per-template regression test in check-config.test.mjs: every Phase 6 name must be written by the save, standard and full config-server templates"

requirements-completed: [QRY-05, QRY-07, QRY-08, XLG-01, CACHE-01]

coverage:
  - id: D1
    description: "17 managed manifest entries; check-config fails when one drifts out of a location"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "node --test scripts/check-config.test.mjs"
        status: pass
  - id: D2
    description: "Query layer card in the Config UI with defaults and help text"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/ui/config-query-layer-card.test.ts"
        status: pass
  - id: D3
    description: "Eval pin of the Phase 6 defaults and NEXT_PUBLIC_MCP_SYSTEM_ENABLED"
    requirement: QRY-07
    verification:
      - kind: unit
        ref: "tests/eval-env-pin.test.ts"
        status: pass
  - id: D4
    description: "REDIS_URL never shown by the config server"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "node --test scripts/tests/config-server-security.node-test.mjs"
        status: pass
---

# Phase 6 Plan 02: Phase 6 config switches Summary

**Every Phase 6 query-layer and semantic-cache switch, plus REDIS_URL, now exists in the manifest, the five config locations and the eval pin. The query layer and the cache are off by default, and REDIS_URL is always masked by the config server.**

## Accomplishments
- Manifest: 17 new `managed` entries with empty `knownGaps` and a one-line `description` each. Legacy `RAG_QUERY_ENHANCEMENT`, `NEXT_PUBLIC_RAG_QUERY_ENHANCEMENT_ENABLED`, `RAG_CACHE_ENABLED` and `NEXT_PUBLIC_RAG_CACHE_*` are unchanged and still `legacy`.
- Defaults at every site: `RAG_QUERY_LAYER=false`, `RAG_QUERY_FRAMEWORK=llamaindex`, `RAG_QUERY_LLM_MODEL=openai/gpt-4.1-nano`, `RAG_QUERY_CONDENSE/EXPAND/DECOMPOSE/TRANSLATE/DATE_NORMALIZE=true`, `RAG_QUERY_HYDE=false`, `RAG_QUERY_TRANSLATE_DISABLED_PROFILES=`, `RAG_QUERY_VOICE_TRANSFORMS=condense_history,normalize_dates`, `RAG_SEMANTIC_CACHE=off`, `RAG_SEMANTIC_CACHE_TTL=3600`, `RAG_SEMANTIC_CACHE_REFUSAL_TTL=600`, `RAG_SEMANTIC_CACHE_MAX_DISTANCE=0.05`, `RAG_SEMANTIC_CACHE_EMBED_STORE=false`, `REDIS_URL=`.
- `src/lib/env.ts` defines `REDIS_URL` as an optional string; no app module reads it.
- Config UI: a "Query layer" card after "Retrieval pipeline", with the help texts from the plan ("HyDE is off by default and is never used in voice", the voice allow-list note, the embed-store note). REDIS_URL is a password field with a show/hide button, placed after the cache backend select.
- Eval pin: `derivePinnedEvalEnv` pins `NEXT_PUBLIC_MCP_SYSTEM_ENABLED='true'` next to the deployment mode, and the pin file was regenerated with `--write` (108 values).

## Task Commits
1. **Task 1: manifest and check-config cases.** RED `519f8a5`. The manifest is GREEN in `552e725`, together with Task 2, because a managed entry without its five locations makes check-config fail on the real tree.
2. **Task 2: five locations, Config UI card, eval pin.** RED `1675fb7` (card and pin tests); GREEN `552e725` (locations and card) and `6a85be2` (pin); polish `dafa923` (web-design-guidelines fixes).
3. **Task 3: REDIS_URL secret.** RED `75a746a`; GREEN `6446ffa`; CI wiring `d507017`.

## Behaviour changes
- None at runtime: every new switch defaults to off or inert, and no app code reads the new names yet.
- Config server: a set `REDIS_URL` is listed in `secretsSet` and never returned. An empty REDIS_URL field on save keeps the stored value.
- Eval: the harness and route-fixture env now set `NEXT_PUBLIC_MCP_SYSTEM_ENABLED=true`. Eval metrics are identical before and after: the fixture run gives recall@5 0.512, mrr 0.517, correct_refusal 0.667 and false_refusal 0.395 both with the old pin and with the new one.

## Tests that failed before the fix
- `scripts/check-config.test.mjs`: 5 new cases. They covered RAG_QUERY_LAYER missing from config-ui, RAG_SEMANTIC_CACHE_EMBED_STORE missing from config-server, REDIS_URL missing from env-ts, manifest statuses, and the per-template presence check.
- `tests/eval-env-pin.test.ts`: the MCP-flag and Phase 6 defaults cases.
- `tests/ui/config-query-layer-card.test.ts`: all 5 cases failed on assertions without the card.
- `scripts/tests/config-server-security.node-test.mjs`: the two REDIS_URL cases (`isSecretConfigEntry('REDIS_URL', 'redis://localhost:6379')` returned false before the fix).

## Gate results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: 0 diagnostics
- `npx vitest run`: 270 files, 4318 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 166 passed, 0 failed
- `node --import tsx --test tests/rag-db/*.test.mts`: 1446 passed, 4 failed, 4 skipped. All 4 failures are in `ingest-mode-routing` (known, pre-existing): the sidecar worker's tiktoken download of `cl100k_base` fails TLS verification through the proxy (`CERTIFICATE_VERIFY_FAILED`). This plan touches no ingest code. The skips include the known `ingestion-ledger-pg` skip as root.
- `node scripts/ci/check-rag-boundary.mjs`: ok (1179 files)
- `node scripts/check-config.mjs`: ok (161 variables)
- `uv run --directory eval python ../scripts/ci/check-workflows.py`: OK
- `npm run test-rag -- --out eval/out/06-02`: gate PASS. `--fixture-mode ingest --out eval/out/06-02-ingest`: gate PASS.
- Python suites and `gen:schemas`: not required, since no Python or contracts were touched.

## Deviations from Plan
1. **Task 1 GREEN is merged into the Task 2 commit.** Committing the managed manifest entries alone would leave check-config red on the real tree.
2. **The per-template check is a new test, not a check-config change.** check-config checks presence per file, so removing a name from only one of the three config-server templates is not detectable without restructuring it. The fixture case removes the name from config-server.js. A separate real-tree test asserts that each Phase 6 name is written by the save, standard and full templates. `check-config.mjs` itself is unchanged; its NAME_PATTERN already covers RAG_*, and REDIS_URL is checked by name through the manifest.
3. **Files added beyond the plan:**
   - `tests/ui/config-query-layer-card.test.ts`: card structure, defaults and help text.
   - `.github/workflows/pr-smoke.yml`: adds the new node test to the "Config check and type-check self-tests" step, because no glob would otherwise run it in CI.
4. **Manifest descriptions:** the 17 new entries carry a `description` field, which no earlier entry has. check-config ignores extra keys.

## Design skills
| Skill | Outcome |
| --- | --- |
| frontend-design | n/a. The card extends the existing Config UI card system (daisyUI `card bg-base-200`, `form-control`, bordered sub-groups as in "Retrieval pipeline" and "Prompt-injection defense") and sets no new visual direction. |
| Impeccable | pass. Structural critique against `reference/critique.md` and `harden.md`: the hierarchy runs master switch → framework and model → transforms → voice → cache. Every default-off or default-on state is visible without .env.local. The secret field has the same affordance as the Lakera key. No screenshot was taken, because the Config UI loads Tailwind and daisyUI from a CDN that this offline session cannot reach. |
| web-design-guidelines | pass (all findings resolved). Every control has a label (`for` or a wrapping label). Help text is linked with `aria-describedby`. The icon-only show/hide button has an `aria-label`. Placeholders show an example and end with `…`. `autocomplete="off"` and `spellcheck="false"` are set on code-like and secret fields. Number inputs use `type="number"` with `inputmode`. `translate="no"` is set on identifiers and `text-balance` on headings. zh/en/it parity does not apply, because the Config UI copy is English-only and no doc-type labels are involved. |

## Decisions for STATE
- REDIS_URL is a sidecar-only, always-secret variable. It appears in the five locations, is not in the eval pin, and the app does not read it.
- The eval pins `NEXT_PUBLIC_MCP_SYSTEM_ENABLED=true` (A-1). Fixture metrics did not change.

## Operator actions
- None. Optionally run `npm run config` once so `.env.local` gains the new names; check-config then also verifies them there.

## Deferred
- Query layer admin module (clear action, calibrated distance, warnings): plan 06-40.
- `VOICE_SERVER_QUERY_REWRITE` in the voice agent's env file: plan 06-31.
