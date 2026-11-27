---
quick_id: 261127-irl
status: complete
branch: exec/quick-it-refusal-locale
base: origin/ci/merge-train-38
---

# Summary: strict refusals speak the question's language among the tenant's enabled languages

Defect found by the 04.3-52 executor: with strict mode and web search off, an Italian question got the Spanish "Información no
disponible" text, and the access refusal used the UI language. Fixed.

## Root cause (/gsd-debug: .planning/debug/it-refusal-locale.md)
Neither `detectLanguageWithConfidence` nor 06.2-10's `resolveQueryLanguage` was involved. The chat route computed its own
`fallbackLanguage = userLanguage === 'en' && isSpanishText(question) ? 'es' : userLanguage`. `isSpanishText` is a route-local regex
over words Italian shares with Spanish (`la`, `una`, `con`, `es`...). It has no threshold and ignores the language settings: `es` is
not a registry language and can never be enabled, yet it was picked. That value fed `noInformationText`, `kbUnavailableText`, the
identifier suggestion and the retrieval-log language whenever the answer turn was on legacy texts (`RAG_REGISTRY_TEXTS` off, or every
Phase 5.2 switch off, so `createAnswerTurn` resolved no answer language). The access refusal (resolver refusal, scope unresolved,
retrieval fails closed with status `error`) goes through the knowledge-base-unavailable branch and used the UI language.

## Fix
- `refusalTextTurn(turn, { question, history, uiLanguage })` in `src/lib/rag/generation/messages.ts`, exported from `@/lib/rag`:
  - an answer turn already on registry texts is returned unchanged;
  - while the languages are configured (`getLanguageSettings()`), it returns a registry text turn whose language is
    `resolveAnswerLanguage` over the enabled languages: confident question detection, then the previous turn, the UI language if
    enabled, the primary language (the existing D-09 chain). A language outside the enabled set can never be returned;
  - with the languages unset (D-02) it returns the turn unchanged and runs no detector: today's legacy texts byte for byte.
- `src/app/api/chat/route.ts`: the strict "information not available" branch, the unavailable branch (retrieval failure and access
  refusal), the identifier suggestion and the retrieval-log language use `refusalTurn()`. Nothing else in the route changes; the
  structured response shape (start metadata, text parts, error part, cache store of refusals) is the same.
- Texts come from the registry (`notices.no_information`, `notices.kb_unavailable` in `config/rag/language-packs.json`); no new
  strings, no language list in product code. The en registry texts equal the legacy English texts (checked: no_information and
  kb_unavailable for en; kb_unavailable also equal for zh and it).
- Embed chat (`/api/embed/chat`, `preferredLanguage`) and voice are untouched.

## Behaviour changes (proved by tests)
Only with `RAG_SUPPORTED_LANGUAGES` / `RAG_PRIMARY_LANGUAGE` configured and the turn on legacy texts:
- the refusal and the unavailable message follow the question's language among the enabled ones: an it question gets the it text,
  a zh question the zh text (before: English for "information not available"), an en question on a zh/it/es UI now gets English
  (before: the UI language, or Spanish for an es UI);
- `es` is never chosen (before: es UI or the Spanish heuristic).
Languages unset: unchanged (tests below keep the legacy rows under `withLanguagesUnset`).

## Tests
- RED (cb1163ba): `tests/rag/generation/refusal-language-route.test.ts`, 16 assertion failures on the old code (the registry-off
  rows; Italian rendered as Spanish, zh as English, access refusal in the UI language). Covers zh, en, it x {information not
  available, access refusal} with registry texts off and on; four Italian questions never answered in Spanish; a disabled language
  never chosen (es UI, it not enabled); the fallback chain (previous turn, UI, primary); languages unset keep the legacy texts.
- Updated rows that locked the old configured + legacy choice, now run with the languages unset plus configured counterparts:
  `tests/rag/generation/registry-texts-route.test.ts`, `tests/chat-strict.test.ts`, `tests/rag/chat-status.test.ts`,
  `tests/rag/feedback-loop/routes-log.test.ts`, `tests/rag/chat-identifier-refusal.test.ts` (new configured rows: zh, it, es UI ->
  registry text and suggestion in zh/it/en). `tests/rag/chat-query-layer.test.ts` and `tests/rag/chat-standalone-metadata.test.ts`:
  the `你好` refusal is now the zh text. New helper `tests/helpers/language-env.ts`.
- `tests/rag/characterize-defaults.test.ts`: `LOCALIZED_NOT_AVAILABLE` adds the zh/it registry titles;
  `tests/fixtures/characterization/chat-v2-default.json` regenerated (`UPDATE_CHARACTERIZATION=1`): only the refusal `text` of 140
  entries changed (it 44, zh 74, cross-lingual 22); no system prompt changed. Embed and voice snapshots unchanged and passing.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: pass
- `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-rag-boundary.mjs`,
  `node scripts/ci/check-settings-classification.mjs`: pass
- `npx vitest run` on every test file importing the changed modules (`generation/messages`, `@/lib/rag`, the chat, embed and
  voice-rag routes): 124 files, 1607 passed, 3 skipped
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-261127-irl-ingest`: gate PASS, absolute gate PASS (enforce)
- `npm run test-rag -- --out eval/out/quick-261127-irl` (default): gate PASS; absolute gate FAIL in report mode, exit 0. This is
  pre-existing: `eval/reports/phase-05.3/absolute-gate-measurement.json` already records the smoke tier as `passed: false`, mode
  report. Retrieval is unaffected by this change.
- Not run: full `npx vitest run` (no core types, env.ts or test setup changed), SQL tests (no SQL).

## Decisions
- Configured languages take precedence over `RAG_REGISTRY_TEXTS` for the two fixed refusal texts only: the legacy refusal has no zh
  or it text, so the question's language cannot be met otherwise. The switch still governs every other registry text.
- Languages unset keep the legacy Spanish heuristic (D-02/D-10: no language setting, no detector). So an unconfigured deployment can
  still answer an Italian question on an en UI in Spanish; setting the languages (as CI, the eval pin and 04.3 do) fixes it.

## Deviations
- The task was run from the orchestrator brief as GSD context (debug notes + quick PLAN/SUMMARY), without spawning GSD subagents.
- Paused once by the orchestrator (WIP commit 295ea121 with a .continue-here.md, removed on completion).
