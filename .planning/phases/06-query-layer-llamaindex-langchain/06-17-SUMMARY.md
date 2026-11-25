---
phase: 06-query-layer-llamaindex-langchain
plan: 17
subsystem: semantic-cache
tags: [cache, bypass, key-hash, security, tdd]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: personal_data and first_person lexicon entries (06-03)
  - phase: 06-query-layer-llamaindex-langchain
    provides: CachedAnswer zod schema with the groundedness label (06-11)
  - phase: 05-verified-citations-groundedness
    provides: groundedness labels verified, possibly_unreliable, not_checked (05-01)
provides:
  - SemanticCache, CacheQuery, CacheHit, CacheKeyParts, EntryProfile types (src/lib/rag/cache/types.ts)
  - computeCacheKeyHash and hashSystemPromptTemplate (src/lib/rag/cache/keys.ts)
  - checkBypassReason, storeBypassReason, retrievalOptionsAreDefault, hasPersonalData, TurnFacts, StoreTurnFacts (src/lib/rag/cache/bypass.ts)
affects: [06-21, 06-30, 06-32, 06-36, 06-41]

actuals:
  tokens: 60000
  tasks: 2
  commits: 5
plan_head_before: 52a724b

tech-stack:
  added: []
  patterns:
    - "Bypass rules are pure functions over a facts object; malformed facts return invalid_facts instead of throwing"

key-files:
  created:
    - src/lib/rag/cache/types.ts
    - src/lib/rag/cache/keys.ts
    - src/lib/rag/cache/bypass.ts
    - tests/rag/cache/keys.test.ts
    - tests/rag/cache/bypass.test.ts
  modified: []

requirements-completed: []
requirements-progressed: [CACHE-01]
---

# Phase 6 Plan 17: Semantic-cache contract, key hash and bypass rules

The cache now has its TypeScript contract, a key hash that keeps entry profiles, prompts, models, modes, languages, retrieval configs and frameworks apart, and every bypass rule from the spec, D-33, A-3 and plan-check B1/B2 as tested pure functions. Nothing calls them yet; 06-21, 06-32 and 06-36 wire them in.

## Commits

| Task | Commits |
|------|---------|
| 1 Contract types and key hash | 51d47e9 test(06-17): add failing tests for the semantic-cache key hash; ab2a252 feat(06-17): compute the semantic-cache key hash over canonical key parts; 851422c test(06-17): drop unused destructured bindings in key-hash tests |
| 2 Bypass rules | 5679a15 test(06-17): add failing tests for semantic-cache bypass rules; 01e7586 feat(06-17): add deterministic check-time and store-time cache bypass rules |

## What changed

- `types.ts`:
  - `SemanticCache` matches the locked spec contract (`check`, `store`, `invalidateTenant(scope, documentIds?)`).
  - `CacheQuery` holds the `TenantScope`, the standalone text and vector, the embedding profile id, and the seven key parts.
  - `CacheHit` holds the entry id, the distance and the parsed `CachedAnswer`.
  - `EntryProfile` is `chat | embed | eval`.
  - `GroundednessLabel` is derived from `CachedAnswer['groundedness']['label']`.
- `keys.ts`:
  - `computeCacheKeyHash` is SHA-256 over sorted-key JSON of exactly the seven parts: answerLanguage, entryProfile, generatorModel, queryFramework, ragMode, retrievalConfigHash and systemPromptHash.
  - A missing or empty part throws, and every part is also required at the type level.
  - `hashSystemPromptTemplate` hashes the template string as given. Callers pass it before `{{context}}` substitution.
- `bypass.ts`:
  - `checkBypassReason` checks the rules in this order: profile (chat and embed; eval only with the override; voice and media never), rag_mode (strict and balanced only), skip_retrieval, document_refs, retrieval_options, tools (webSearch or MCP), protected_tokens, relative_time, personal_data, uncondensed_follow_up.
  - `storeBypassReason` runs `checkBypassReason` first. Then it checks ghost_chat (`ghost-` ids), history_dependent (history present, or the raw message differs from the standalone after NFKC, trim, whitespace collapse and lowercase), source_images, retrieval_status (degraded or error; ok and empty can be stored, so refusals are cached), unreliable (`possibly_unreliable` only; verified, not_checked and absent can be stored), embed_check_only, empty_answer.
  - `retrievalOptionsAreDefault` treats these as non-default: `mediaKind` set, `generalOverview: true`, `degrade` set, or a `maxResults` that differs from the configured count. A missing `maxResults` is the default.
  - Personal data: the lexicon `personal_data` regexes are compiled once with the `u` flag. First-person terms match as substrings in zh, and in en and it only at word boundaries, case-insensitively, so `myRAG` and `mining` do not match. Both the raw query and the standalone are scanned.
  - Defence in depth beyond the gate result:
    - Protected tokens and relative time are also scanned in the raw query and the standalone. A code that only the condensed standalone carries (pulled in from history) still bypasses.
    - Malformed facts return `invalid_facts`.

## Behaviour changes

None at runtime. The module is new and nothing imports it yet.

## Tests that failed before the fix

- At RED 51d47e9, `tests/rag/cache/keys.test.ts`: 13 of 15 tests failed on assertions against the stub, which returned an empty string.
- At RED 5679a15, `tests/rag/cache/bypass.test.ts`: 40 of 47 tests failed on assertions against the stub, which returned no reason. The 7 that passed were the safe-question and default-option cases.
- Now: 15 and 47 tests pass. The plan required at least 10 and at least 21.

## Gate results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 261 files, 4214 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1446 pass, 4 fail, 4 skipped. All 4 failures are in `ingest-mode-routing.test.mts`. The sidecar worker cannot download tiktoken `cl100k_base` (SSL error to openaipublic.blob.core.windows.net, cold cache). It still fails when rerun alone, also with `REQUESTS_CA_BUNDLE` set. This is a known pre-existing failure; this plan touches no ingest, SQL or Python. |
| `check-rag-boundary` + node test | ok (1164 files), 38 pass |
| `node scripts/check-config.mjs` | ok, 135 variables |
| `check-workflows.py` | OK |
| Python suites, `gen:schemas`, `test-rag` | not run: no Python, contracts, retrieval wiring, ingest or golden sets touched |

## Deviations

1. **Two facts types instead of one.** `TurnFacts` holds what is known at check time. `StoreTurnFacts extends TurnFacts` adds `chatId`, `sourceImages`, `retrievalStatus`, `groundednessLabel`, `embedStore` and `answerText`, which exist only after the answer. `storeBypassReason` still repeats every check rule. 06-32 builds `TurnFacts` and 06-36 builds `StoreTurnFacts`.
2. **`CacheQuery.embeddingProfileId`.** The plan did not list this field. The cache check request (06-11 contract, 06-21 behaviour) needs the profile id, so the query carries it. It is a filter, not a key part.
3. **Extra reasons.** `invalid_facts` comes from the "never throws" rule. `empty_answer` comes from the plan's store list.
4. **Stricter than the gate.** Protected tokens and relative time are also rescanned on the raw query and the standalone, as described above. The only cost is a lower hit rate.

## Notes for later plans

- 06-32: `maxResults` is compared with strict equality to `defaultMaxResults`. Pass the same resolved number the route passes (`parseInt(env.RAG_FINAL_RESULT_COUNT || '25')`). A NaN from a malformed env value bypasses.
- The phone regex from the 06-03 lexicon also matches some runs of numbers, for example "2024 2025". Such turns bypass. This is safe, but it lowers the hit rate. Revisit if the eval shows misses.

## Decisions for STATE

- D-06-17-a: key parts are exactly answerLanguage, entryProfile, generatorModel, queryFramework, ragMode, retrievalConfigHash and systemPromptHash. The tenant and the embedding profile are backend filters, not hash parts.
- D-06-17-b: check-rule order is profile, rag_mode, skip_retrieval, document_refs, retrieval_options, tools, protected_tokens, relative_time, personal_data, uncondensed_follow_up. Store adds ghost_chat, history_dependent, source_images, retrieval_status, unreliable, embed_check_only, empty_answer.
- D-06-17-c: protected-token, relative-time and personal-data checks run on both the raw query and the standalone.
- Requirements progressed: CACHE-01.

## Operator actions

None.

## Deferred

- Wiring into the query layer, route store and eval: plans 06-32, 06-36 and 06-41.
