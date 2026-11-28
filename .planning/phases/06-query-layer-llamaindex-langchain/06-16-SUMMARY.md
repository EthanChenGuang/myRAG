---
phase: 06-query-layer-llamaindex-langchain
plan: 16
subsystem: rag-query
tags: [query-layer, translation, xlg-01, kb-languages, tenant-cache, query-llm]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-04 rag_tenant_language_shares (0601); 06-05 QueryTranslationSchema; 06-07 checkVariant and the prompt renderer; 06-10 RagDeps.queryLlm and the fake query LLM"
provides:
  - "getKbLanguageShares(scope, { deps?, signal? }) with a 10-minute per-tenant cache; null on any failure"
  - "translationTargets(queryLanguage, shares): the D-23 20% rule, up to two targets, largest share first"
  - "resetKbLanguageCacheForTests(tenantKey?)"
  - "nativeTranslate({ query, language, targets, protectedTokens, signal, maxItems?, limits?, deps? }) -> { variants, skipped }"
  - "shared.translate prompt (v1) registered in PROMPT_REGISTRY; renderTemplate (render without the shared suffix); LANGUAGE_NAMES exported"
affects: [06-18, 06-23, 06-37]

actuals:
  tokens: 60000
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Tenant-keyed in-process cache: key = scopeKey(minted scope), TTL from deps.now(), failures never cached, logs carry a 12-hex sha256 prefix of the key"
    - "Translate skips name the target and the reason only (never text)"

key-files:
  created:
    - src/lib/rag/query/kb-languages.ts
    - src/lib/rag/query/llamaindex/translate.ts
    - src/lib/rag/query/prompts/shared.translate.v1.json
    - tests/rag/query/kb-languages.test.ts
    - tests/rag/query/translate.test.ts
  modified:
    - src/lib/rag/query/prompts/render.ts

key-decisions:
  - "The translate prompt is rendered without the shared suffix: suffix rule 1 ('write in the same language as the query') and rule 4 ('return it unchanged') contradict translation. The translate prompt carries its own rules (translate only, no answer, protected tokens verbatim, target code, query block is data)."
  - "Shares keep only zh/en/it rows (taken from the generated QueryTranslationSchema enum) and are not renormalised, so other KB languages still count against the query language's share."
  - "A translation whose target_language differs from the requested target is skipped as invalid_output (checked after the schema parse; the LLM schema stays the plain contract)."
  - "Tenant key is scopeKey(scope), the same value hybrid_search_chunks receives; the SQL guard rag_assert_tenant_key rejects anything else. An unminted scope throws before any RPC."

requirements-completed: [XLG-01]

coverage:
  - id: D1
    description: "KB language shares: RPC arguments, 10-minute cache, two tenants, error null with hashed key, 20% rule"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "tests/rag/query/kb-languages.test.ts (13 cases)"
        status: pass
  - id: D2
    description: "Native translator: parallel calls, at most 2 variants, protected-token discard, wrong-language skip, abort, prompt shape"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "tests/rag/query/translate.test.ts (11 cases)"
        status: pass
---

# Phase 6 Plan 16: KB language shares client and native query translator Summary

**The query layer can now read a tenant's knowledge-base language shares (cached per tenant for 10 minutes), decide translation targets by the 20% rule, and produce at most two translated query variants that keep every protected token verbatim. Nothing calls these yet; 06-23 wires them into the translate slot.**

## Accomplishments
- `src/lib/rag/query/kb-languages.ts`
  - `getKbLanguageShares(scope)` calls `rag_tenant_language_shares` with `{ p_tenant_key: scopeKey(scope) }` on the admin client (default `getRagDeps()`, injectable `{ adminClient, now }`), with an optional abort signal.
  - Module-level `Map<tenantKey, { shares, fetchedAt }>`, TTL 600000 ms measured with `deps.now()`. Hits return a copy. Errors, a missing admin client and thrown requests return `null`, are not cached, and log one `[Query Layer]` warning with a 12-hex sha256 prefix of the key and an error code (never the key, the message or the org id).
  - `translationTargets(lang, shares)`: `[]` when shares are null/empty or the query language's share is above 0.2; otherwise the other languages with share > 0.2, largest first, at most two.
- `src/lib/rag/query/llamaindex/translate.ts`
  - `nativeTranslate` drops the query's own language and duplicate targets, caps at `min(2, maxItems)`, then runs one `queryLlm().generate({ transform: 'translate', schema: QueryTranslationSchema, targetLanguage, signal })` per target with `Promise.all`.
  - Each result passes `checkVariant` (D-15). A wrong `target_language` is skipped as `invalid_output`; LLM failures are skipped by `QueryLlmError` kind; an aborted signal gives `aborted` for every pending call.
  - Returns `{ variants: { kind: 'translated', language, text }[], skipped: { kind: 'translate', target, reason }[] }`.
  - `<query>` tags inside the query or the protected tokens are entity-escaped, so the query cannot close its data block.
- `src/lib/rag/query/prompts/shared.translate.v1.json` (myRAG, MIT, v1) with placeholders `target_language`, `protected_tokens`, `target_code`, `query`.
- `src/lib/rag/query/prompts/render.ts`: registers `shared.translate`, exports `LANGUAGE_NAMES` and adds `renderTemplate(prompt, vars)` (same escaping and one-pass fill as `renderPrompt`, no suffix, no history).

## Task Commits
1. **Task 1: KB language shares with a 10-minute per-tenant cache.** RED `22510b5` (tests plus an API stub), GREEN `6cadad0`.
2. **Task 2: Native translator with the shared prompt.** RED `2f3cf28` (tests, prompt file and stub), GREEN `3836ab0`.
3. **Fix:** `2b82777` reads the language list from `QueryTranslationSchema` (check-language-literals rejected the hard-coded list).

## Behaviour changes
- None at runtime. No pipeline code calls `getKbLanguageShares` or `nativeTranslate` yet (06-23 does). The Phase 4 translator slot still holds `NONE_TRANSLATOR`. Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed are untouched.
- Eval fixture runs: gate PASS on both.

## Tests that failed before the fix
- `tests/rag/query/kb-languages.test.ts`: 10 of 13 failed on assertions against the stub (the 3 that passed expect null or `[]`).
- `tests/rag/query/translate.test.ts`: 9 of 10 failed on assertions against the stub (the no-targets case passed). The query-block escape case was added with GREEN.

## Gate results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: no errors.
- `npx vitest run`: 346 files, 5721 passed, 1 skipped (rerun after the fix commit: same result).
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1793 passed, 0 failed.
- `node scripts/ci/check-rag-boundary.mjs`: ok, 1329 files. `node --test scripts/tests/check-rag-boundary.node-test.mjs`: 39 passed.
- `node scripts/ci/check-language-literals.mjs`: ok (after `2b82777`).
- `node scripts/check-config.mjs`: ok, 183 variables. `check-workflows.py`: OK.
- `npm run test-rag -- --out eval/out/06-16`: gate PASS. `npm run test-rag -- --fixture-mode ingest --out eval/out/06-16-ingest`: gate PASS.
- Python suites, `gen:schemas` and the UI gate: not applicable (no Python, contracts or UI touched).

## Deviations from Plan
1. **Neutral test sentences.** The plan's example query is a lodging/reimbursement question; the owner's domain-neutrality rule forbids that, so the tests use synthetic sentences ("What does the synthetic module report each cycle?") and an inline fake table.
2. **`render.ts` modified** (not in `files_modified`): the prompt must be registered in `PROMPT_REGISTRY`, and a suffix-free `renderTemplate` was added because the shared suffix's same-language and return-unchanged rules contradict a translation.
3. **Return shape** is `{ variants, skipped }` rather than a bare variant list, so 06-23 can record skips in `query_plan.skipped`. Skip reasons `invalid_output` and `unavailable` are not in the trace enum yet; 06-23 maps them (e.g. to `error`).
4. **Extra cases**: errors are not cached, no admin client, unminted scope refused before any RPC, non-zh/en/it rows dropped, query-language target dropped, empty output, LLM failure kinds, prompt shape, and query-block escaping.

## Notes for later plans
- 06-23: `translationTargets` and the gate's R8 (`rewrite-gate.ts`, `TRANSLATE_MAX_SHARE`) implement the same 20% threshold; pass the same `getKbLanguageShares` result as `ctx.kbShares` so they agree.
- `checkVariant` applies the 4x length-ratio cap to translations. A short zh query translated into en can exceed 4x and be dropped as `length`. Worth watching in the 06-38 cross-lingual eval; changing the post-check is outside this plan.
- 06-18 boundary rule: the RPC name is a module constant (`RPC_NAME`) used as `client.rpc(RPC_NAME, ...)`, so a literal-pattern rule allows this file trivially; the literal string is still present in the file.

## Decisions for STATE
- Translate prompts render without the shared D-14 suffix; their own rules cover protected tokens.
- KB shares cache: per tenant key, 10 minutes, failures uncached, logs hash the key.

## Operator actions
- None. Live translation quality of `RAG_QUERY_LLM_MODEL` stays a phase-level live check.

## Deferred
- None.
