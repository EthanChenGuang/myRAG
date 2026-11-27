---
status: awaiting_human_verify
trigger: "After submitting a chat question, the user dictates into the chat input with OS speech-to-text (macOS dictation). The button right of the input stays red in its stop state and the textarea accepts no typed or dictated text until the red button is clicked. Reported on myrag.laoxiang.app, desktop browser."
created: 2026-11-26T22:30:00Z
updated: 2026-11-26T22:50:00Z
---

## Current Focus

bug_class: Heisenbug-ish race (timing-dependent; 100% repro when the last stream chunks and [DONE] arrive before React renders)
hypothesis: commitStreamingMessage called setIsStreaming(true) inside a setMessages updater; React runs that updater lazily during the next render, after the end-of-stream setIsStreaming(false) was queued, so isStreaming ends true
test: tests/ui/chat-stream-state.test.ts (RED 2/2 on the old page.tsx, GREEN 2/2 after the fix); Playwright repro in the session scratchpad (stubbed /api/chat, short stream in one chunk)
expecting: confirmed
next_action: owner verifies on myrag.laoxiang.app after deploy

## Symptoms

expected: when the answer finishes, the send/mic button returns and the textarea takes typed or OS-dictated text
actual: red "Stop generating" button stays, textarea stays disabled; clicking it calls handleStop -> resetStreamingState and unblocks
errors: none
timeline: production, desktop
reproduction: submit a question that gets a short answer (or any answer whose tail chunks arrive together), then try to type or dictate

## Evidence

- Playwright, unfixed: 4/4 rounds textareaDisabled=true, red button aria-label "Stop generating", insertText (OS dictation simulation) rejected
- Playwright, fixed: 4/4 rounds textarea enabled, no red button, insertText accepted
- Playwright, fixed: a live slow stream still shows the stop button, the textarea is disabled during it, and clicking stop ends it and re-enables the textarea
- ChatInput disables the textarea on parentIsLoading (= isChatLoading || isStreaming) and renders the red stop button for it

## Eliminated

- hypothesis: OS dictation events (composition/insertText/keydown) start the in-app mic recorder (red pulsing mic, isRecording). Recording starts only from the mic button's onClick; the stuck button observed in repro is the stop-generation button.
- hypothesis: useChat status stuck. The manual fetch path drives isStreaming itself; isChatLoading is false in repro.

## Resolution

root_cause: In src/app/page.tsx handleSubmit, commitStreamingMessage put setIsStreaming(true) and setStreamingMessage(...) inside the setMessages(prev => prev.map(...)) updater. Updaters run during the next render, so when the final deltas and [DONE] are read in the same tick, the end-of-stream setIsStreaming(false) is processed before the deferred updater re-sets isStreaming to true. isLoading stays true: stop button stuck, textarea disabled. Dictation is how the owner noticed it, not the cause.
fix: commitStreamingMessage calls setStreamingMessage outside the updater and no longer sets isStreaming (already true from submit); the updater is pure.
verification: vitest RED->GREEN; Playwright repro fixed; stop on a live stream still works; tsc --noEmit 0 errors; eslint on page.tsx unchanged (230 pre-existing problems before and after), new test clean
files_changed: src/app/page.tsx, tests/ui/chat-stream-state.test.ts
