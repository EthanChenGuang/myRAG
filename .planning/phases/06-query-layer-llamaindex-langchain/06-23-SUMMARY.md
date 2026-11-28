---
phase: 06-query-layer-llamaindex-langchain
plan: 23
subsystem: rag-query
tags: [query-layer, translation, xlg-01, d-22-slot, kb-languages, cross-lingual]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-16 getKbLanguageShares / translationTargets / nativeTranslate; 06-19 runQueryLayer parallel group and soft status; 06-20 variant caps and lexicalLanguages for translated variants"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-24 Translator contract (D-22 slot) and the fixture translator"
provides:
  - "QueryTransformer.translate (native nativeTranslate)"
  - "queryLayerTranslator (src/lib/rag/query/translate.ts): the D-22 Translator over QueryTransformer.translate; QueryLayerTranslateContext; TranslateCallFailed"
  - "runQueryLayer reads the tenant KB shares (scope key only, cached) before the gate, feeds R8 with them and runs translate in the parallel group; QueryLayerOutcome.handledTranslate is now set"
  - "buildQueryPlan accepts translated variants (after condensed, before expanded)"
  - "RagConfig.operatorDisabledStages: only the stages RAG_DISABLED_STAGES lists"
  - "statusRecords(records, survivors, layerTranslate): the layer's translate record is soft like the other layer stages"
affects: [06-28, 06-32, 06-37, 06-38, 06-42, 04.1.1-07]

actuals:
  tokens: 13000
  tasks: 2
  commits: 4
plan_head_before: aae1f56

tech-stack:
  added: []
  patterns:
    - "The layer owns the shared translate stage name when its translate switch is on; the Phase 4 stand-down record is written only if the layer recorded no translate stage (the trace keys stages by name, last wins)"

key-files:
  created:
    - tests/rag/query/translate-slot.test.ts
    - tests/rag-db/cross-language-query.test.mts
  modified:
    - src/lib/rag/query/translate.ts
    - src/lib/rag/query/transformer.ts
    - src/lib/rag/query/run-layer.ts
    - src/lib/rag/query/plan.ts
    - src/lib/rag/v2/stages/query.ts
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/config.ts
    - tests/rag/query/condense.test.ts

key-decisions:
  - "handledTranslate = the layer may translate for this request: layer on, RAG_QUERY_TRANSLATE on (or the eval override), not monolingual, translate not in RAG_DISABLED_STAGES or the eval request's disabledStages, and for voice listed in the voice allow-list. It is true even when R8 does not fire, the shares are unavailable or the profile is disabled, so the Phase 4 fixture translator never runs on top of the layer"
  - "The layer's translate stage ignores RAG_LEXICAL_TRANSLATION (which only gates the Phase 4 fixture slot); it uses the shared translate stage name and its D-27 timeout (600 ms chat/embed, 300 ms voice)"
  - "Shares are read only when the layer may translate and the profile is not disabled; the read is bounded by the translate stage timeout and counted inside the A-7 group deadline (anchored before the read)"
  - "Unavailable shares: plan.skipped {translate, error}, no stage record, R8 does not fire, status unaffected"
  - "disabled_for_profile: the request's embedding profile (eval option, else getActiveProfile().id, read only when the disabled list is non-empty) is in RAG_QUERY_TRANSLATE_DISABLED_PROFILES; plan.skipped {translate, disabled_for_profile}, no shares read, no LLM call"
  - "Every target failing in the model call (not a post-check) makes queryLayerTranslator throw, so the stage is recorded skipped/failed and the plan gets {translate, error}; post-check discards keep the stage ok and land in plan.skipped with their reason"
  - "With zero survivors and core stages ok, a skipped layer translate record no longer turns a legitimate empty into degraded (A-2 extended to the layer's translate); the Phase 4 translate record still counts as before"

requirements-completed: [XLG-01, QRY-05]

coverage:
  - id: D1
    description: "Layer translate through the D-22 slot: R8 with KB shares, one zh variant with a zh lexical leg, Phase 4 stand-down, unavailable shares, disabled_for_profile, scope-keyed cached shares read, call failure, protected tokens, layer-off fixture path, no double translation, soft status"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "tests/rag/query/translate-slot.test.ts (12 cases)"
        status: pass
  - id: D2
    description: "en and it questions about the zh-only contract fixture reach its scope-clause chunk through the translated variant and RRF; en-heavy tenant does not translate; real shares SQL on the fixture corpus; layer off unchanged"
    requirement: XLG-01
    verification:
      - kind: integration
        ref: "tests/rag-db/cross-language-query.test.mts (5 cases, PGlite, in-process eval route)"
        status: pass
---

# Phase 6 Plan 23: Query-layer translator in the D-22 translate slot Summary

**With the query layer on, a query in a rare language for the tenant's knowledge base is now translated by the small query model into up to two KB languages. The translations are searched as extra variants with a lexical leg restricted to their language, and RRF fuses them with the original. The Phase 4 fixture translator stays for eval runs with the layer off.**

## Accomplishments
- `QueryTransformer` gains `translate`, served by `nativeTranslate` (06-16).
- `queryLayerTranslator` in `src/lib/rag/query/translate.ts` implements the Phase 4 `Translator` contract. Its context (`QueryLayerTranslateContext`) adds the KB targets, the protected tokens, `max_translations`, the post-check limits, the framework transformer and an `onSkip` sink. Without targets it translates nothing. The transformer module is loaded with a dynamic import, so the layer-off path loads nothing new.
- `runQueryLayer`:
  - decides whether the layer owns translation, reads `getKbLanguageShares(scope)` (request scope key only, 10-minute per-tenant cache) before the gate, and passes it as `ctx.kbShares`, so R8 and `translationTargets` apply the same 20% rule;
  - runs `translate` in the parallel group on the standalone query, under the group deadline and the translate stage timeout;
  - puts the translated variants into the plan (after condensed) and so into the Phase 4 seam, where `max_translations` caps them and `lexicalLanguages` restricts their lexical leg;
  - maps translate skips to the plan enum (post-check reasons kept, `aborted` → `timeout`, other call failures → `error`);
  - sets `handledTranslate`.
- `runQueryStages` passes the scope. It writes the `handled_by_query_layer` record only when the layer recorded no translate stage itself.
- `statusRecords` treats the layer's translate record as soft (A-2), and `runV2Pipeline` passes `layerTranslate` to `buildV2Result`.

## Task Commits
1. **Task 1 (translate through the D-22 slot):** RED `0edb481` (11 of 12 failed on assertions), GREEN `a57f997`.
2. **Task 2 (cross-language retrieval on the fixtures):** `16db355` (tests only; no run-layer fix was needed).
3. SUMMARY (this commit).

## Behaviour changes (layer on only)
- `RAG_QUERY_TRANSLATE` (default `true` under the master switch) now takes effect. When the query language's share of the KB is at most 20%, translate runs and adds up to two translated variants.
- Every layer request where the layer may translate reads `rag_tenant_language_shares` (cached per tenant for 10 minutes). If the read fails, the plan records `{translate, error}` and the request goes on without translation.
- With the layer on, the Phase 4 fixture translator no longer runs (before this plan, `RAG_LEXICAL_TRANSLATION=true` with the layer on ran the fixture translator).
- With the layer off nothing changes. The translation-seam suite and the parity, characterize and status suites are unchanged, and the eval gates pass. Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed are untouched with the switches off.

## Tests that failed before the fix
- `tests/rag/query/translate-slot.test.ts`: 11 of 12 failed on the pre-change source. Among them is "with the layer on, the fixture translator never runs on top of the layer": before this plan the fixture translation was searched alongside the layer's variants.

## Deviations from Plan
1. **Files outside `files_modified`:** `plan.ts` (translated variants), `v2/stages/query.ts` (passes the scope, no duplicate translate record), `v2/pipeline.ts` and `v2/result.ts` (soft layer translate), `config.ts` (`operatorDisabledStages`). Without `operatorDisabledStages` the layer could not tell an operator's `RAG_DISABLED_STAGES=translate` from the stage being disabled by `RAG_LEXICAL_TRANSLATION=false`.
2. **One translate record, not two.** The plan's behaviour lists a layer `translate` record and a Phase 4 `disabled/handled_by_query_layer` record. Both share the stage name, and `stage_status`/`stage_latency_ms` are keyed by name (last wins), so the stand-down record would hide the layer's real status. The stand-down record is written only when the layer did not record translate (R8 not fired, shares unavailable, profile disabled).
3. **`tests/rag/query/condense.test.ts`** now sets `RAG_QUERY_TRANSLATE=false`. Its exact `plan.skipped` assertions run without a shares source, so the default-on translate added `{translate, error}`; the suite tests condense in isolation.
4. **Task 2 uses new neutral questions** about the scope clause of the zh-only contract fixture, not golden items. The golden en→zh items either share zh tokens with the evidence (the original query already finds it) or touch HR topics the neutrality rule excludes. The KB shares are stubbed per test (zh-heavy, en-heavy) because the fixture corpus is balanced (en 7, it 6, zh 6 documents), so R8 never fires on it. One case reads the real SQL function.
5. **Disabled profile:** the plan records `disabled_for_profile` from the pre-check (no shares read, so the gate's R8 cannot fire to route it), and the chat/embed profile id now comes from `getActiveProfile()`. Before this plan the router received `''` outside eval, so `RAG_QUERY_TRANSLATE_DISABLED_PROFILES` could never match in chat.

## Gate results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: no errors.
- `npx vitest run`: 389 files, 6511 passed, 4 skipped.
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1969 passed, 0 failed, 4 skipped.
- `check-rag-boundary.mjs`: ok (1444 files); its node test: 52 passed.
- `node scripts/check-config.mjs`: ok (190 variables). `check-workflows.py`: OK. `check-language-literals.mjs`: ok.
- `npm run test-rag -- --out eval/out/06-23`: gate PASS (7 skipped). `--fixture-mode ingest --out eval/out/06-23-ingest`: gate PASS (7 skipped).
- Not applicable: Python suites, `gen:schemas` (no contract change), the frontend design check (no UI).
- ESLint on the touched files: the only errors are on pre-existing lines (`config.ts:666`, `pipeline.ts:20/259`, `result.ts:131`).

## Threats
- T-06-52: every translated variant passes `checkVariant` (protected tokens verbatim); a lost token is discarded and recorded.
- T-06-53: the shares are read with `scopeKey(scope)` from the request's minted scope only (asserted for two tenants in the unit suite and as the only RPC argument in the PGlite suite); the cache is per tenant key.

## Decisions for STATE
- With the layer on and `RAG_QUERY_TRANSLATE` on, the layer owns the shared `translate` stage. The Phase 4 fixture translator only runs with the layer off, or when the layer's translate is off.
- Unavailable KB shares are a plan skip (`error`), never a stage failure.
- `RagConfig.operatorDisabledStages` holds the operator's `RAG_DISABLED_STAGES` list on its own.

## Operator actions
- None new. Live translation quality of `RAG_QUERY_LLM_MODEL` stays a phase-level live check. Migration 0601 (`rag_tenant_language_shares`) must be applied before translate can fire; without it, layer requests record `{translate, error}` and do not translate.

## Deferred
- The shared `eval/fixtures/query-llm/transforms.json` translation entries and the cross-lingual eval slice stay with 06-38.
- Voice-rag with translate (06-28) needs `scope` passed through as here; `runQueryStages` already does.
