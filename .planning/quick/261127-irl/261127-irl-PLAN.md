---
quick_id: 261127-irl
type: quick
branch: exec/quick-it-refusal-locale
base: origin/ci/merge-train-38
autonomous: true
---

# Quick: strict refusals pick their language among the tenant's enabled languages

Root cause: .planning/debug/it-refusal-locale.md (route-local `isSpanishText` heuristic, not the language settings).

## Task 1 (RED)
tests/rag/generation/refusal-language-route.test.ts: zh, en, it questions; strict "information not available" and the access
refusal; text language equals the question language; a language that is not enabled is never chosen; the fallback chain
(previous turn, UI language, primary); languages unset keep today's legacy texts.

## Task 2 (GREEN)
`refusalTextTurn(turn, input)` in src/lib/rag/generation/messages.ts: an answer turn already on registry texts is returned as is;
otherwise, while the languages are configured, a registry turn with `resolveAnswerLanguage` over `getLanguageSettings().languages`
(previous turn, UI, primary); otherwise the turn unchanged (legacy texts, D-02/D-10). The chat route uses it for the strict refusal,
the unavailable message, the identifier suggestion and the retrieval-log language. Embed and voice are untouched.
Update tests/rag/generation/registry-texts-route.test.ts rows that locked the old configured + registry-off behaviour.

## Gates
typegen + tsc, typecheck:new, check-config, check-language-literals, check-rag-boundary, check-settings-classification, the vitest
files importing the changed modules, `npm run test-rag -- --fixture-mode ingest` and the default profile.
