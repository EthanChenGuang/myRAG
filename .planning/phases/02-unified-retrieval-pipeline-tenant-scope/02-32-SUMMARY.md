---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 32
subsystem: ui
tags: [useChat, embed, ai-sdk, typescript, tsc-ratchet, react]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: tsc ratchet baseline and typegen step (02-01)
provides:
  - Embed window on the current useChat API with a tested request-body helper
  - Zero tsc errors in the embed window, main page, shared page, streaming-markdown, useShareChat and use-voice-mode
  - Fixes for two latent runtime ReferenceErrors (streaming-markdown hooks, useShareChat Supabase client)
affects: [02-33, ci-tsc-ratchet]

requirements-completed: [PIPE-01]

actuals:
  tokens: 14000
  tasks: 2
  commits: 4
plan_head_before: e308307fe9a17df0009fbdc60faacadf928e2603
plan_head_after: 4945e93abd925d4659b9bd701dd5704ece5fe08d

tech-stack:
  added: []
  patterns:
    - "Embed client builds the route body in a pure helper (toEmbedRequestBody) passed to DefaultChatTransport.prepareSendMessagesRequest"

key-files:
  created:
    - src/app/embed/window/embed-request.ts
    - tests/ui/embed-window-request.test.ts
    - tests/ui/ui-runtime-fixes.test.ts
  modified:
    - src/app/embed/window/page.tsx
    - src/app/page.tsx
    - src/app/shared/[shareId]/page.tsx
    - src/components/ui/streaming-markdown.tsx
    - src/hooks/useShareChat.ts
    - src/lib/hooks/use-voice-mode.ts

key-decisions:
  - "Embed model value stays the existing default in the window module; tenant fields are never sent (the route resolves tenant from server config)"
  - "Shared page resolves a null title to the existing 'Shared Chat' fallback at the page boundary so SharedChatContent keeps its string contract"
  - "ExtendedFormEvent gets an optional typed data.settings.webSearch field instead of a cast"

patterns-established:
  - "TDD for UI fixes in the node vitest environment: react-dom/server render plus module mocks, RED on assertions"

duration: 12min
completed: 2026-11-23
---

# Phase 02 Plan 32: Page and hook UI type errors Summary

The embed window now uses the current AI SDK useChat API (transport, sendMessage, status, text parts) with a tested request mapping, and the remaining page and hook type errors in six files are at zero, including two latent runtime ReferenceErrors.

## Performance

- 4 commits (2 RED, 2 GREEN), all on the worktree branch
- tsc ratchet: ok, 213 errors, 6 files improved; `npx vitest run tests/ui`: 8 tests pass

## Task Commits

1. Task 1 RED: `4f8df21` failing embed request mapping tests (stub export, assertion failures)
2. Task 1 GREEN: `1ef24ec` migrate embed window to current useChat API
3. Task 2 RED: `4880496` failing UI runtime fix tests
4. Task 2 GREEN: `4945e93` page/hook type errors and two latent ReferenceErrors

## Intended behaviour changes

- Embed window: the v4 `useChat` destructuring (input, handleInputChange, handleSubmit, isLoading, body) returned undefined at runtime with the installed SDK. It now keeps local input state, calls `sendMessage({ text })`, derives loading from `status`, renders text parts, sets the greeting as a UIMessage with a text part, and posts `{ messages: [{ role, content }], model }` through `DefaultChatTransport`. Layout, styling and config loading unchanged.
- streaming-markdown: now imports `useState` and `useEffect`; previously rendering threw a ReferenceError.
- useShareChat: uses `createClient()` from `@/lib/supabase/client`; the removed `supabaseAuth` export made sharing throw.
- Shared page: a null chat title now becomes 'Shared Chat' before reaching the client component (matches what the metadata already shows).
- `src/app/page.tsx`: only the optional typed `data` field on `ExtendedFormEvent`; main chat behaviour untouched.

## Deviations from Plan

**1. [Rule 1 - Bug] use-voice-mode error was on the analyser buffer, not an audio conversion**
- **Found during:** Task 2
- **Issue:** The plan described copying into a new Uint8Array for a BufferSource. The actual error (line 78) is `getByteFrequencyData(dataArrayRef.current)` where the ref was typed `Uint8Array<ArrayBufferLike>`.
- **Fix:** Typed the ref as `Uint8Array<ArrayBuffer>`; the buffer is already created with `new Uint8Array(n)`, so no runtime change and no copy needed.
- **Files modified:** src/lib/hooks/use-voice-mode.ts
- **Commit:** 4945e93
- **Test:** none added for this item (type-only; covered by tsc and the ratchet); the plan's "identical bytes" test has no corresponding runtime path.

Otherwise the plan executed as written.

## Known Stubs

None.

## Threat Flags

None. T-02-81 mitigated: request body built by a tested helper matching the route's Zod schema; no tenant fields sent.

## Human check (VERIFICATION)

Open the embed window page and send one message; expect a streamed assistant reply and the greeting from config.

## Self-Check: PASSED

- Files exist: embed-request.ts, both test files, this summary
- Commits 4f8df21, 1ef24ec, 4880496, 4945e93 are ancestors of HEAD
- `grep -c '^src/app/embed/window/'` on tsc output is 0; the combined six-file grep is 0
