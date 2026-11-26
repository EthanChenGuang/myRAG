---
quick_id: 261126-w4x
status: complete
---

# Summary: RAG_HISTORY_NOT_EVIDENCE

- New switch `RAG_HISTORY_NOT_EVIDENCE` (default `false`), synced to env.ts, init-env.js, config-server.js, Config UI (checkbox under Answer style), env manifest, settings classification (query side) and the pinned eval env.
- `src/lib/chat/history-not-evidence.ts` holds the fixed instruction and `appendHistoryNotEvidence`.
- Chat route: appended after the citation decoration on the knowledge-base prompt branch, and to the Claude Citations system text; never for bypass or small talk; strict refusal, webSearch, `source_images`, citations untouched. Balanced mode with no matching chunks still runs the knowledge-base prompt ("No relevant context found."), so it gets the instruction.
- Embed route: same, on its knowledge-base branch. Voice-chat route has no prompt assembly; voice agent prompt is separate and unchanged.
- Prior-turn cap skipped (not trivial).

## Verification
- tests/chat-history-not-evidence.test.ts: 11 passed (off/unset messages identical; on: instruction once in the system message and nothing else changed, strict/balanced/flexible; bypass unchanged; strict refusal unchanged; embed off/on).
- Full vitest: 584 files, 10414 passed, 16 skipped (after regenerating eval/config/rag-eval-env.json).
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. check-config, check-settings-classification, check-language-literals, check-rag-boundary: ok. ESLint on touched routes: same 182 pre-existing problems before and after; new files clean.

## Design skills
- Config UI change is one checkbox reusing the existing checkbox markup pattern (label, help text with aria-describedby); no new visual design.
