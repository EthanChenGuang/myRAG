---
phase: 05-verified-citations-groundedness
plan: 14
subsystem: generation
tags: [groundedness, hhem, vectara, sidecar, language, chinese-script]

requires:
  - phase: 05-verified-citations-groundedness
    provides: GroundednessRequest/Result/Thresholds contracts and the thresholds file (05-01), readGenerationConfig (05-02), AliasedBlock and stripCitationMarkers (05-03, 05-08)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: cl100k countTokens (03-06)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: detectLanguage (04-20), the static-import thresholds loader pattern (04-13)
provides:
  - "chineseScript, SIMPLIFIED_ONLY, TRADITIONAL_ONLY (src/lib/rag/lang/script.ts)"
  - "groundednessEligibility, buildPremise, buildHypothesis, answerGroundednessLanguage, allowVectaraFor, loadGroundednessThresholds(FromData), labelGroundedness (src/lib/rag/generation/groundedness.ts)"
  - "requestGroundedness (src/lib/rag/generation/groundedness-client.ts)"
affects: [05-18, 05-22]

actuals:
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Script heuristic from two aligned committed strings of script-specific characters; more hits wins, tie is ambiguous"
    - "Sidecar client: one AbortController covers the request and the body read; every failure is a not_checked result, never a throw"

key-files:
  created:
    - src/lib/rag/lang/script.ts
    - tests/rag/lang-script.test.ts
    - src/lib/rag/generation/groundedness.ts
    - tests/rag/generation/groundedness.test.ts
    - src/lib/rag/generation/groundedness-client.ts
    - tests/rag/generation/groundedness-client.test.ts
  modified: []

requirements-completed: []
requirements-advanced: [GEN-05, GEN-06]
---

# Phase 5 Plan 14: Groundedness decisions and the sidecar client

**Every app-side groundedness decision (when to score, what to send, which language, whether Vectara is allowed, how to label) is a pure tested function, and the sidecar client always returns a well-formed result in bounded time.**

## Tasks and commits

| Task | Commits |
|------|---------|
| 1. Chinese script heuristic | `80333a9` test (RED: 6 of 9 failed on assertions against a stub), `2bec724` feat |
| 2. Eligibility, premise, hypothesis, language, Vectara gate, labels | `8b5e292` test (RED: 30 of 32 failed on assertions against a typed stub), `3b51d3b` feat |
| 3. Sidecar client | `0f3b0aa` test (RED: 12 of 13 failed on assertions against a stub), `91f3c32` feat, `666c0d5` test typing fix |

## What changed

- `chineseScript(text)`: 92 aligned pairs of frequent characters whose Simplified and Traditional forms differ. Forms that also occur in the other script (后, 么, 只, 干, 里, 台, 万, 体) are left out. More Simplified-only hits gives `hans`, more Traditional-only hits gives `hant`, and a tie or no hit gives `ambiguous`. No package was added.
- `groundednessEligibility(input)`: `not_eligible` unless every D-14 condition holds: switch on, web chat with citations, strict or balanced, `ok`/`degraded` with at least one block, not a refusal, not a ghost chat. The MCP tool check (`tool_output`) runs only after those, so flexible and bypass are always `not_eligible`.
- `buildPremise({blocks, citedAliases, webSearchTexts, maxTokens, countTokens?})`:
  - The default counter is cl100k.
  - Under the cap, every text is kept in order: blocks in alias order, then the webSearch texts.
  - Over the cap, the cited blocks go first. Then the other blocks in alias order, then the webSearch texts, fill the space left. Anything that does not fit is skipped, a later smaller piece can still go in, and `truncated` is set. The pieces kept are returned in their original order.
  - If the cited blocks alone exceed the cap, the result is `too_long`. It is also `too_long` when nothing fits at all.
  - Empty texts are skipped. With nothing left, the result is `empty_premise`.
  - Cited aliases that were never sent are ignored.
- `buildHypothesis(answer)`: `stripCitationMarkers` plus trim. An empty result gives `not_checked`, reason `empty_answer`.
- `answerGroundednessLanguage(answer)`: `detectLanguage` runs on the answer with its markers stripped. Results: `en`, `it`, `zh-Hans`, `zh-Hant`, `zh` (Chinese whose script is ambiguous) or `unknown`. Only `en` and `zh-Hans` can be scored by the sidecar (D-11), so `zh` and `zh-Hant` end up not checked.
- `allowVectaraFor(config, multiTenant)`: true only with `vectaraOptIn`. In multi-tenant mode it also needs `vectaraMultiTenantAck`. Anything else gives false.
- Thresholds:
  - `loadGroundednessThresholds()` statically imports `eval/config/groundedness-thresholds.json`, validates it once with `GroundednessThresholdsSchema` and caches it.
  - `loadGroundednessThresholdsFromData(data)` gives an empty cell map for an invalid file, with exactly one `[Groundedness]` warning per process.
  - `labelGroundedness(result, language, cells?)` gives `verified` for a score at or above the threshold and `possibly_unreliable` below it. A cell missing from the file falls back to the 0.5 default. With no score (or scorer `none`), the label is `not_checked` with a null threshold and a null source. The result carries `label`, `threshold`, `thresholdSource`, `score`, `scorer`, `reason`, `truncated` and `latencyMs`.
- `requestGroundedness(request, {url, secret, timeoutMs, fetch})`:
  - It falls back to `RAG_SIDECAR_URL`, `RAG_SIDECAR_SECRET` and `readGenerationConfig().groundednessTimeoutMs` for any option not given.
  - An empty URL or secret gives `scorer_unavailable` and sends no request.
  - The request is validated with `GroundednessRequestSchema` before it is sent. It is POSTed to `<url>/v1/groundedness` with the `x-sidecar-secret` header.
  - One AbortController timer covers both the headers and the body read. A timeout gives `timeout`. An HTTP error, a transport failure, a non-JSON body or a schema failure gives `error`.
  - It never throws. Log lines carry only counts, the HTTP status, an error name or the timeout value, never request text or the secret.
  - The tests run against a real `node:http` server, not a mocked fetch.

## Behaviour changes

None at runtime. Nothing calls these functions yet. Plan 05-18 wires them in after the stream.

## Tests that failed before the fix

All three RED commits failed on assertions against stubs that had the final signatures. There was no module-not-found failure.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run typecheck:new`: 0 diagnostics.
- `npx vitest run`: 260 files, 4146 passed, 1 skipped.
- `node --import tsx --test tests/*.test.mts`: 166 pass, 0 fail.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1061 pass, 4 skipped, 4 fail. The failures are pre-existing (see below).
- `node scripts/ci/check-rag-boundary.mjs`: ok, 1147 files. `node --test scripts/tests/check-rag-boundary.node-test.mjs`: 38 pass.
- `node scripts/check-config.mjs`: ok, 135 variables.
- `uv run --directory eval python ../scripts/ci/check-workflows.py`: OK.
- Not run, because the plan touched none of their areas:
  - the Python suites: no Python changed;
  - `gen:schemas`: no contracts changed;
  - `test-rag`: no retrieval, ingest or golden-set code changed.

### Pre-existing failure

`tests/rag-db/ingest-mode-routing.test.mts` fails 4 subtests (`--routing tiered`, `--force-tier structured|fast|premium`). The sidecar worker cannot download `cl100k_base.tiktoken` from `openaipublic.blob.core.windows.net` (`SSLError ... CERTIFICATE_VERIFY_FAILED`). This is the known failure that 05-02 also recorded on its base commit.

## Deviations

1. `answerGroundednessLanguage` also returns `zh` for Chinese whose script is ambiguous. The plan lists only en, it, zh-Hans, zh-Hant and unknown. Ambiguous Chinese must not be labelled `zh-Hans` (research Open Question 3), and labelling it `zh-Hant` would be wrong. The sidecar answers `zh` with `unsupported_language`, so the result is the planned one: not checked.
2. `buildPremise` has an extra `empty_premise` result for the case where no block or web text has any content. The contract requires at least one non-empty premise text.
3. `requestGroundedness` validates the request with `GroundednessRequestSchema` before sending it. An invalid request gives `error` and sends nothing.
4. The test typing fix was its own commit, `666c0d5`. `tsc` flagged an implicit `any` in a test helper.

## Decisions for STATE

- Chinese script: 92 committed character pairs, and the script with more hits wins. A tie or no hit is ambiguous, and ambiguous Chinese is never scored.
- Premise order over the cap: cited blocks, then the other blocks in alias order, then the webSearch texts, filled greedily. The output keeps the original order.
- The `tool_output` reason is given only to requests that would otherwise be eligible.
- Threshold lookup key is `(scorer, language)`. A missing cell is 0.5 with source `default`. An invalid file gives one `[Groundedness]` warning.
- The client's failure reasons are `scorer_unavailable` (no URL or secret, no request sent), `timeout` and `error`.

## Operator actions

None.

## Deferred

- Composing these functions into `scoreAnswerGroundedness` and running it after the stream: plan 05-18.
