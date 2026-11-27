---
status: resolved
trigger: "strict refusals (information not available, access refusal) answer an Italian question in Spanish"
found_by: 04.3-52 executor
---

# Debug: Italian strict refusals rendered in Spanish

## Symptom
Strict mode, web search off. An Italian question gets the Spanish "Información no disponible" text, and an access refusal gets the
unavailable message in the UI language instead of the question's language. 04.3-52 locked only the English texts.

## Which detector
Not `detectLanguageWithConfidence` and not 06.2-10's `resolveQueryLanguage`. The chat route computes its own
`fallbackLanguage` (`src/app/api/chat/route.ts`, request setup): `userLanguage === 'en' && isSpanishText(question) ? 'es' : userLanguage`.
`isSpanishText` is a route-local regex over words that Italian shares with Spanish (`la`, `una`, `con`, `es`, `son`, `sobre`...), so
any Italian question on an en UI matches. `fallbackLanguage` feeds `noInformationText`, `kbUnavailableText` and the identifier
suggestion whenever `answerTurn.textsSource` is `legacy`, i.e. whenever `RAG_REGISTRY_TEXTS` is off or every Phase 5.2 switch is off
(`createAnswerTurn` resolves no answer language then). The candidate set is not the tenant's languages at all: `es` is not a registry
language and can never be enabled, yet it is picked. No threshold is involved; the heuristic has none.

The access refusal (`resolveAccessScope` refusal, scope left unresolved, retrieval fails closed with status `error`) reaches the
knowledge-base-unavailable branch, which uses the same `fallbackLanguage` (UI language), so it ignores the question's language too.

## Evidence
`detectLanguageWithConfidence` over the enabled set (zh,en,it) detects the Italian questions as `it` with confidence 0.67-0.83, so
the existing D-09 chain (`resolveAnswerLanguage`) gives the right answer once it is used.
RED: tests/rag/generation/refusal-language-route.test.ts, 16 assertion failures on the old code (registry-off rows).

## Resolution
See .planning/quick/261127-irl/261127-irl-SUMMARY.md.
