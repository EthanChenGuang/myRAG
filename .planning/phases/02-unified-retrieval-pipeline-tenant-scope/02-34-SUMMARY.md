---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 34
subsystem: type-safety
tags: [typescript, ai-sdk-v6, chunking, supabase, tdd]
requires: [02-06]
provides:
  - Zero tsc errors in system-prompt-manager, the system-prompts validate route, semantic-chunker, organization-handler, chat-store, chat-utils, chat-title-utils
  - readToolCallInput / readToolResultOutput / readToolResultIsError helpers with typed legacy fallbacks
affects: [ingestion chunking (Phase 3), chat message rendering of stored tool parts]
key-files:
  created:
    - tests/lib/semantic-chunker.test.ts
    - tests/lib/chat-utils-tool-parts.test.ts
  modified:
    - src/lib/system-prompt-manager.ts
    - src/app/api/config/system-prompts/validate/route.ts
    - src/lib/semantic-chunker.ts
    - src/lib/auth/organization-handler.ts
    - src/lib/chat-store.ts
    - src/lib/chat-utils.ts
    - src/lib/chat-title-utils.ts
    - src/lib/supabase.ts
key-decisions:
  - "Chat.folder_id widened to string | null in src/lib/supabase.ts (matches DB and the existing null writes) instead of casting in chat-store"
  - "v6 tool-result output envelopes ({type: text|json|error-text|error-json, value}) are unwrapped; error-* marks isError"
requirements-completed: [PIPE-01]
status: complete
duration: 25min
completed: 2026-11-23
commits: 4
plan_head_before: 2495420
actuals:
  tasks: 3
  commits: 4
---

# Phase 02 Plan 34: Type fixes in prompt manager, chunker, organization handler and chat utils Summary

40 tsc errors across seven modules are gone; the chunker ReferenceErrors and the AI SDK v4 tool-part reads got the intended fix with tests, and the system-prompt manager was typed without changing what it serves.

## Tasks

| Task | Commit | Result |
| ---- | ------ | ------ |
| 1. System-prompt manager + validate route | 272ba42 | 19 errors to 0; chat characterization and prompt tests unchanged |
| 2. Semantic chunker + organization handler | cc0eebf (RED), 2fefaf1 (GREEN) | 12 errors to 0; 6 chunker tests |
| 3. Chat store / utils / title utils | b2fae5a | 9 errors to 0; 9 tool-part and folder-move tests |

Verification: `tsc-ratchet` reports ok (81 errors remaining repo-wide, 47 files improved); full tsc diff against the pre-plan output shows no new error locations; `tests/rag`, `tests/chat-*`, `tests/lib`, `tests/eval-answer.test.mts`, `tests/prompt-context.test.mts` pass.

## Intended behaviour changes

- **Semantic chunker (ingestion path, Phase 3 must re-measure):** `chunkContent` referenced an undefined `maxTokens` in five places (accumulate-then-split check, oversized-paragraph check, and the three sub-chunkers' limits). Whenever those branches ran, ingestion threw `ReferenceError`. They now use `maxOutputTokens` from the chunking config (default 800). Chunk boundaries for any document that reaches those branches therefore change from "throws" to "split at the configured maximum"; document-processor behaviour on such documents needs re-measuring in Phase 3.
- **Tool parts:** chat-utils and chat-title-utils read AI SDK v6 `input` / `output`, falling back to the legacy `args` / `result` / `isError` of stored messages (typed `LegacyToolCallPart` / `LegacyToolResultPart`). Stored messages convert exactly as before. New: a v6 `output` envelope is unwrapped to its `value`, and `error-text` / `error-json` set `isError`. chat-store now builds its title tool calls with `input`.
- **System-prompt manager:** translations carry no `systemPrompts` block today. Before, `getPromptTemplate` / `getAvailableTemplates` / `getAllTemplates` would throw a TypeError (or return undefined) in that case; the typed version reads the block through a local interface with optional chaining, so they now return `null` / `[]` / `{}` and `getAssembledPrompt` returns the existing default prompt. Prompt text, the `{{context}}` placeholder contract and the chat characterization snapshots are unchanged. `SystemPromptTemplate` is now the explicit union `'helpful'` (the only key the module and chat route use).
- **Validate route:** template values are narrowed with a type guard; output shape is unchanged.

## Deviations from Plan

**1. [Rule 3 - Blocking] Widened `Chat.folder_id` in `src/lib/supabase.ts`**
- Issue: the three chat-store `setState` callbacks write `folder_id: null`, which `Chat.folder_id?: string` rejects. The plan said to type the callbacks so the union matches Chat; matching it required the type to admit `null`, which the database column and `getChatsByFolder(null)` already rely on.
- Fix: `folder_id?: string | null`. No new tsc error locations anywhere.
- Commit: b2fae5a

**2. [Rule 1 - Bug] Line 621 spread error in `mergeSmallChunks`**
- The plan guessed a non-object spread; the cause was `let currentMerge: SemanticChunk | null = null` narrowing to `null` inside the loop. Fixed with `null as SemanticChunk | null`; no runtime change, covered by two `mergeSmallChunks` tests.

**3. Organization handler fix is a one-line type change**
- The helper's parameter is `ReturnType<typeof createServiceRoleClient>` (the client callers pass) instead of `ReturnType<typeof createClient>`; no runtime change.

**4. TDD note for Task 3**
- Task 3's tests were written after the implementation (no separate RED commit); Task 2 has a RED commit (`cc0eebf`, fails with `ReferenceError: maxTokens is not defined`) followed by GREEN.

## Known Stubs

None.

## Threat Flags

None. T-02-83 (prompt content) mitigated by unchanged characterization and prompt tests; T-02-84 (old chats failing to render) mitigated by the legacy fallback tests.

## Self-Check: PASSED

- tests/lib/semantic-chunker.test.ts, tests/lib/chat-utils-tool-parts.test.ts present
- commits 272ba42, cc0eebf, 2fefaf1, b2fae5a reachable from HEAD
