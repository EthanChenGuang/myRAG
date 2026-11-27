---
status: resolved
trigger: "Two production UI bugs: (1) suggested follow-up questions (↳ lines after ---) render run together on one line; (2) Document Management upload modal closes when clicking outside the per-file doc-type dropdown but inside the modal."
created: 2026-11-26
updated: 2026-11-26
---

## Symptoms

### Bug 1 — follow-ups on one line
- expected: each `↳ ` suggestion renders as its own clickable row below the answer.
- actual: suggestions appear run together in one paragraph ("↳ A? ↳ B? ↳ C?").
- error: none.
- repro: chat answer whose tail is `---` + `↳` lines.

### Bug 2 — upload modal closes
- expected: with the per-file type select open, clicking inside the modal (outside the select list) closes only the select.
- actual: the whole Document Management dialog closes and the selected file is lost.
- error: none.
- repro: Document Management → Upload New → pick a file → open the type select → click the empty area of the file row.

## Current Focus
- hypothesis: resolved.
- next_action: none.

## Evidence

- timestamp: 2026-11-26 — Playwright against `npm run dev` (Supabase auth and `/api/chat` mocked with a UI-message stream whose text ends `---\n↳ A?\n↳ B?\n↳ C?`): 0 `[data-related-question]` rows; one `.react-markdown p` holding all three `↳` lines; stop button still red after 20 s.
- timestamp: 2026-11-26 — temporary log in `ChatMessage` `followupSplit`: final message has `isStreaming=false`, `isThinking=false`, but `followupsDisabled=true` (page `isResponseInFlight`). `useChat().isLoading` does not exist in `@ai-sdk/react` v3, so the flag is page `isStreaming`, stuck at true.
- timestamp: 2026-11-26 — `commitStreamingMessage` in `src/app/page.tsx` called `setIsStreaming(true)` / `setStreamingMessage()` inside the `setMessages` updater. React runs queued updaters during the next render, after the manual-finish `setIsStreaming(false)`, so the last streamed chunk re-set `isStreaming` to true.
- timestamp: 2026-11-26 — `splitFollowups` already handled single-newline and blank-line tails; markdown joined the unsplit single-newline `↳` lines into one paragraph.
- timestamp: 2026-11-26 — bug 2 repro: dialog closes, file lost. Capture-phase mousedown log: target is a home-page `SPAN.suggestion-button-label` behind the dialog, `body.style.pointerEvents === 'none'` (Radix Select open disables outside pointer events, dialog content included). Both the dashboard's document `mousedown` listener (target outside `dialogRef`) and the DialogContent `onPointerDownOutside={() => setOpen(false)}` fired and closed the dialog.

## Eliminated

- hypothesis: parser only splits on blank lines — eliminated, unit tests and code show single-newline tails split.
- hypothesis: the prompt format is wrong — eliminated, the prompt asks for exactly the format the parser accepts.

## Resolution

- root_cause (1): `setIsStreaming(true)` ran inside a `setMessages` updater, so after the stream finished `isStreaming` was re-set to true; `followupsDisabled` stayed true, the follow-up tail was never split off, and markdown merged the single-newline `↳` lines into one paragraph.
- root_cause (2): while the Radix Select is open, page pointer events are disabled, so a press inside the dialog lands on the page under it; the dashboard's custom outside-click listener and the Radix `onPointerDownOutside` prop handler both treated it as an outside press and closed the dialog.
- fix (1): call `setIsStreaming` / `setStreamingMessage` directly in `commitStreamingMessage`, outside the updater (`src/app/page.tsx`); `separateFollowupLines()` puts every follow-up line in its own markdown paragraph when the tail is rendered as markdown (streaming, or a tail that cannot be split), and `splitFollowups` also splits several `↳`/`→` questions written on one line (`src/lib/chat/followups.ts`, `src/components/ui/chat-message.tsx`).
- fix (2): a capture-phase `pointerdown` listener records whether a Radix popper was open when the press started; the custom listener ignores that press and `onPointerDownOutside` calls `preventDefault()` for it. The 100 ms listener timer is now cleared on cleanup (`src/components/ui/document-dashboard.tsx`).
- verification: Playwright against `npm run dev`: bug 1 — 3 rows per answer for single-newline, blank-line and same-line tails, no `↳` left in markdown, stop button resets; a tail followed by a Source line renders one `↳` paragraph per line. Bug 2 — press inside dialog with select open keeps the dialog and the file; genuine outside press, Escape and the close button still close it; Escape with the select open closes only the select; picking an option keeps the dialog. `npx next typegen && npx tsc --noEmit -p tsconfig.json` passes; eslint counts on touched files unchanged; `vitest run tests/ui tests/lib/chat-followups.test.ts` 53 files / 1017 tests pass.
- files_changed: src/app/page.tsx, src/lib/chat/followups.ts, src/components/ui/chat-message.tsx, src/components/ui/document-dashboard.tsx, tests/lib/chat-followups.test.ts
