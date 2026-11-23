---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 17
subsystem: voice-agent
tags: [voice, tenant-scope, scope-token, livekit, ci]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: signed voice token minted into LiveKit participant metadata (02-15); voice-rag and voice-chat routes that require x-rag-scope-token (02-16)
provides:
  - "voice-agent/src/participant_scope.ts: parseScopeToken and ActiveUserGuard"
  - "RAGClient.query returning a typed result (ok, or unauthorized / unavailable / error) and forwarding x-rag-scope-token"
  - "Agent wiring: token read at TrackSubscribed, single active user, spoken fallback line, token header on the voice-chat save"
  - "voice-agent test runner (npm test) and a pr-smoke voice-agent job"
  - "README_VOICE_INTEGRATION.md 'Voice RAG token' section (deploy order, paired rollback, expiry)"
affects: [02-19, 02-20]

requirements-completed: [PIPE-04]

actuals:
  tokens: 7070
  tasks: 3
  commits: 4
plan_head_before: 5642d0f39e7db90787ce90852cea5ceabb7f5993
plan_head_after: 8212721fca3f92e7df3d02f29045f006099d6d7c

tech-stack:
  added: []
  patterns:
    - "Typed result union instead of swallowing errors in a client; callers branch on ok"
    - "Tests under voice-agent/test/ run with node --test through tsx; tsconfig include stays src/** so the build never ships them"

key-files:
  created:
    - voice-agent/src/participant_scope.ts
    - voice-agent/test/rag_client.test.ts
    - voice-agent/test/participant_scope.test.ts
  modified:
    - voice-agent/src/rag_client.ts
    - voice-agent/src/voice_agent.ts
    - voice-agent/src/agent.ts
    - voice-agent/package.json
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - README_VOICE_INTEGRATION.md

key-decisions:
  - "RAGClient.query signature is (query, scopeToken?, userId?): the token is second as the plan specifies, userId stays third so the request body keeps userId for the old app"
  - "A failed knowledge-base turn speaks the fixed English line and does not touch conversation history, so the saved chat never holds an unanswered question or an invented answer; the overlay still shows the line as an assistant message"
  - "No zh/it variant: the voice agent has no per-language message handling (only an STT language setting), so the line is English only"
  - "The single-user guard also protects the other lifecycle handlers: a second user connecting does not reset the active conversation, and the ignored user's disconnect does not save or reset it"
  - "The new CI job reuses the existing voice-agent key in scripts/ci/sibling-tsc-baseline.json (total 0), which the sibling-types job already used; no new baseline was created"

patterns-established:
  - "Non-active participants are filtered by identity through the guard before any per-user state (userId, token, history) is touched"

coverage:
  - id: D1
    description: "Token forwarded as x-rag-scope-token with x-api-key; no header when there is no token; body keeps query, userId, matchCount"
    requirement: PIPE-04
    verification:
      - kind: unit
        ref: "voice-agent/test/rag_client.test.ts (local node:http server)"
        status: pass
  - id: D2
    description: "401/403 map to unauthorized, 503 to unavailable, network and other statuses to error; token and api key never logged"
    requirement: PIPE-04
    verification:
      - kind: unit
        ref: "voice-agent/test/rag_client.test.ts"
        status: pass
  - id: D3
    description: "parseScopeToken and ActiveUserGuard behaviour (second user rejected, release by a non-active identity is a no-op)"
    requirement: PIPE-04
    verification:
      - kind: unit
        ref: "voice-agent/test/participant_scope.test.ts"
        status: pass
  - id: D4
    description: "Agent wiring: guard claim and token read at TrackSubscribed, fixed spoken line on a non-ok result, token header on voice-chat save"
    requirement: PIPE-04
    verification:
      - kind: static
        ref: "npx tsc --noEmit -p voice-agent/tsconfig.json clean; tsc-ratchet voice-agent key reports 0 errors; grep for parseScopeToken, ActiveUserGuard, x-rag-scope-token"
        status: pass
      - kind: live
        ref: "voice session against the app with the rebuilt agent image (not runnable here: no LiveKit, no live app)"
        status: pending
  - id: D5
    description: "CI job and documentation"
    requirement: PIPE-04
    verification:
      - kind: static
        ref: "check-workflows.py reports OK (run with uv --all-extras so PyYAML is present); README contains RAG_VOICE_TOKEN_SECRET"
        status: pass
---

# Phase 2 Plan 17: Voice agent scope token, single user, spoken fallback Summary

**The voice agent now reads the server-signed scope token from participant metadata, forwards it to the voice routes, answers one user at a time, and says "I can't reach the knowledge base right now" instead of answering without context.**

## Performance

- **Tasks:** 3 (Task 1 as RED then GREEN)
- **Tests:** 21 passing in `voice-agent` (12 RAG client, 9 participant scope), 0 failing

## Accomplishments

- `RAGClient.query` returns `{ ok: true, context, sources, source_images }` with the same formatting as before, or `{ ok: false, reason }`; the old "swallow every error into empty context" path is gone (research R-5).
- `parseScopeToken` and `ActiveUserGuard` live in `voice-agent/src/participant_scope.ts`; `agent.ts` claims the guard at `TrackSubscribed` before creating the audio stream, sets the token on the pipeline, and releases the guard and clears the token after the conversation is saved on disconnect.
- `voice_agent.ts` skips the LLM when retrieval fails and speaks the fixed line through the TTS and audio output path, then frees the pipeline; the `voice-chat` save adds `x-rag-scope-token` when a token is set.
- `pr-smoke` gains a `voice-agent` job (`npm ci --ignore-scripts`, `npm test`, tsc ratchet on the existing `voice-agent` baseline key); `check-workflows.py` asserts it.
- README documents the one-way contract.

## Task Commits

1. Task 1 RED: `d116d0d` test(02-17): failing tests (stub exports, 16 of 21 failing on assertions)
2. Task 1 GREEN: `0f7676f` feat(02-17): typed RAG client and participant scope helper
3. Task 2: `736d230` feat(02-17): agent wiring
4. Task 3: `8212721` ci(02-17): voice-agent job and deploy documentation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Second user could still disturb the active session through the lifecycle handlers**
- **Found during:** Task 2
- **Issue:** `ParticipantConnected` called `pipeline.reset()` and `ParticipantDisconnected` saved and reset the conversation for any `user-` participant, so a second user joining or leaving would wipe or save the active user's conversation even though its audio was ignored.
- **Fix:** both handlers check the guard's active identity first and leave the session untouched for any other identity.
- **Files modified:** voice-agent/src/agent.ts
- **Commit:** 736d230

**2. [Rule 3 - Blocking] Worktree plan-head ledger file could not be written**
- **Issue:** the tool sandbox refused writing into the shared git directory, so `gsd-plan-head-before-02-17` was not created. `plan_head_before` is the known base (5642d0f, verified with `git merge-base --is-ancestor`) and `commits: 4` was measured with `git rev-list --count 5642d0f..HEAD`.

### Notes

- `check-workflows.py` needs PyYAML; `uv run --directory eval python ...` as written in the plan fails without the extras. It passes with `uv run --directory eval --all-extras ...`, which is what CI gets from `uv sync --all-extras`.
- The tsc ratchet for voice-agent was already wired by plan 02-01 (`sibling-types` job, baseline total 0). The new job runs it too; it reports 0 errors.
- No English-only caveat for other languages was needed beyond the fixed English line (see key-decisions).

## Known Stubs

None.

## Threat Flags

None. No new endpoints or trust boundaries; the token is forwarded, never logged (asserted by a test that captures console output).

## Live Items

- Run a voice session with the rebuilt agent image against the app using the signed token (needs LiveKit and a configured `RAG_VOICE_TOKEN_SECRET`); not possible in this environment.

## Self-Check: PASSED

- voice-agent/src/participant_scope.ts, voice-agent/test/rag_client.test.ts, voice-agent/test/participant_scope.test.ts present
- commits d116d0d, 0f7676f, 736d230, 8212721 are ancestors of HEAD
- `npm test` 21 pass, 0 fail; `tsc --noEmit` clean; workflow check OK
