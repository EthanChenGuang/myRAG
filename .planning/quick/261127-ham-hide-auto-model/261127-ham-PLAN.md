---
quick_id: 261127-ham
branch: exec/quick-hide-auto-model
base: origin/ci/merge-train-39 (c6f1b3f7)
---

# Plan: hide the Auto model entry until model routing lands (Phase 6.2 verification G3)

06.2-02 added `{ id: 'auto', displayName: 'Auto' }` to the five model lists; no server path resolves it before 06.2-29/35.

1. RED: tests for the three cases (routing off: no Auto; routing effective and both routing ids listed: Auto; stored Auto: default model, one log line, no error).
2. GREEN: one shared check `isAutoModelSelectable` in `src/lib/chat/auto-model.ts`; `currentModelRouting()` in `@/lib/rag`; the chat model list (`GET /api/config/models?for=chat`) drops Auto unless selectable; chat and embed routes map a stored `auto` to the default model.
3. Keep the five model locations unchanged (hide, not delete). Gates per the brief.
