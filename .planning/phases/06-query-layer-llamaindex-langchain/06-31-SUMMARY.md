---
phase: 06-query-layer-llamaindex-langchain
plan: 31
subsystem: voice-agent
tags: [query-layer, voice, history, condensation, tenant-isolation]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-28 voice-rag optional history (6 turns, 1,000 chars, binding) and the x-rag-server-query-rewrite: 1 header"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-20 last edit of voice-agent/src/rag_client.ts (server-built context field)"
provides:
  - "RAGClient.query(text, token?, userId?, history?): history field only when given; last 6 user/assistant turns, each cut to 1,000 characters, bindings unchanged"
  - "scopeTokenBinding(token) = base64url(SHA-256(token)).slice(0, 22), same rule as the 06-28 route"
  - "ok results carry serverQueryRewrite (true only for x-rag-server-query-rewrite: 1); the JSON wire contract is unchanged"
  - "VOICE_SERVER_QUERY_REWRITE (voice-agent env, default false) in VoicePipeline: skip rewriteQueryWithContext and send bound history only while the latest voice-rag response of the session carried the header"
affects: [06-42]

actuals:
  tokens: 45000
  tasks: 2
  commits: 4
plan_head_before: c318c58

tech-stack:
  added: []
  patterns:
    - "Per-turn binding kept in a WeakMap keyed by the history message object, recorded through one recordTurn() helper, so a token refresh never rebinds earlier turns"

key-files:
  created:
    - voice-agent/test/voice_rewrite_switch.test.ts
  modified:
    - voice-agent/src/rag_client.ts
    - voice-agent/test/rag_client.test.ts
    - voice-agent/src/voice_agent.ts
    - voice-agent/.env.example

key-decisions:
  - "The server path runs only when the switch is 'true' (exact string), the session flag is set and a scope token is present; without a token the agent cannot bind turns, so it keeps the local rewrite"
  - "The session flag is set from every voice-rag response: an ok response sets it to serverQueryRewrite, any failure (401/403/503/other) clears it, so the next follow-up falls back to today's rewrite. The flag also clears on reset() and clearScope()"
  - "The agent takes the last 6 non-system turns and drops any without a binding (recorded before a token existed) or with empty content, because the route answers 400 to a missing binding or empty content; the client caps again (6 turns, 1,000 chars, roles user|assistant), cutting at a code-unit boundary without leaving a lone high surrogate"
  - "With the server path, the original utterance is the query and is what the history records for the user turn (no agent-side rewritten text)"
  - "History content is never logged by the client"

requirements-completed: [QRY-07]

coverage:
  - id: D1
    description: "Client: default body has no history key; history capped to the last 6 turns and 1,000 chars with bindings and roles unchanged; system/tool/empty turns dropped; serverQueryRewrite true only for header value '1' (absent, '0', 'true', other → false) with results and source_images unchanged; binding equals the 06-28 hash; history content not logged"
    requirement: QRY-07
    verification:
      - kind: unit
        ref: "voice-agent/test/rag_client.test.ts (25 cases; 6 new, 1 updated for the new field)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Switch unset/false/invalid ('yes', 'TRUE', '1'): local rewrite once per turn, no history; switch true without the header: identical to off; with the header: next follow-up skips the rewrite and sends the last 6 bound turns; a header-less or failed response puts the next follow-up back on the local rewrite; no token → local rewrite; two sessions keep their own bindings; token refresh keeps old bindings on earlier turns and new ones afterwards; reset clears the flag"
    requirement: QRY-07
    verification:
      - kind: unit
        ref: "voice-agent/test/voice_rewrite_switch.test.ts (13 cases)"
        status: pass
    human_judgment: false
---

# Phase 6 Plan 31: Voice agent server-side condensation switch Summary

**The voice agent can now hand follow-up condensation to `/api/internal/voice-rag`. With `VOICE_SERVER_QUERY_REWRITE=true` it skips its own `rewriteQueryWithContext` and sends up to 6 recent turns, each bound to the session token in use when it was recorded, but only while the server's latest response said it condenses (`x-rag-server-query-rewrite: 1`). The default `false`, and an app running with `RAG_QUERY_LAYER=false`, both give today's behaviour.**

## Tasks and commits

| Task | Commits |
|------|---------|
| 1 History in the RAG client | `bca8a49` test (RED, with an empty `scopeTokenBinding` stub so it fails on assertions), `ff114e5` feat |
| 2 VOICE_SERVER_QUERY_REWRITE in the agent | `e3bf666` test (RED, plus a behaviour-preserving split of `processUserMessage` into `retrieve` / `recordTurn` / `recordExchange`), `b5765ec` feat (switch, flag, bindings, `.env.example`) |

## Behaviour changes
- Switch off (default, or any value other than `true`): no change. The request body, the rewrite call and the LLM prompt are the same as before; only the in-memory result object gains `serverQueryRewrite`.
- Switch on: the first turn of a session always uses the local rewrite (no header seen yet). After a response with the header, follow-ups send the original utterance plus bound history; after a response without it, or any failure, the next follow-up uses the local rewrite again.
- After a voice token refresh, earlier turns keep the old binding. The server drops them (06-28), so that follow-up is retrieved with the original query; turns recorded after the refresh carry the new binding.
- The agent still makes no database RPC; `check-rag-boundary.mjs` passes.

## RED evidence
- rag_client.test.ts: 5 cases failed on assertions (binding stub `''`, history absent from the body, header not read, `serverQueryRewrite` missing from the empty result).
- voice_rewrite_switch.test.ts: 5 cases failed with `ERR_ASSERTION` (history undefined, rewrite count 5 instead of 1, and so on). The "header never sent" and invalid-value cases passed on the old code by design: they guard the default path.

## Deviations
1. **Refactor inside `voice_agent.ts`.** `processUserMessage` now calls `retrieve()` (rewrite decision, supersession check, RAG call, flag update) and `recordExchange()`; the greeting paths use `recordTurn()`. Logic and log lines are unchanged; this gives the tests a seam without driving TTS.
2. **Test expectation fix during GREEN.** The token-refresh case first expected the raw first utterance in history; the first turn goes through the local rewrite, so the recorded user turn is the rewritten text. Only the expectation changed.
3. **Config sync.** `VOICE_SERVER_QUERY_REWRITE` is a voice-agent variable, not an app `.env.local` variable, so it goes only into `voice-agent/.env.example` as the plan says; the five app locations and `scripts/rag/env-manifest.json` do not list voice-agent variables. The voice-agent's own config UI (`voice-agent/scripts/config-ui`) was not changed.

## Gates
- `cd voice-agent && npm test`: 46 pass, 0 fail; `npx tsc --noEmit -p voice-agent`: 0 errors
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 418 files, 7014 passed, 4 skipped, 0 failed
- `node --import tsx --test tests/*.test.mts`: 172 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 2070 tests, 2066 pass, 0 fail, 0 cancelled (the rest skipped)
- `check-rag-boundary.mjs` and its self-tests: pass
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- Not applicable: Python suites, `gen:schemas`, `test-rag` (no app retrieval, ingest, generation or golden-set change; the agent client is outside the harness), frontend design check (no UI)

## Operator actions
- Deploy order when turning it on: the app with 06-28 and `RAG_QUERY_LAYER=true` first, then the agent with `VOICE_SERVER_QUERY_REWRITE=true`. Either one off alone keeps today's behaviour.
- A live voice session check (follow-up resolved server-side, header observed) is an operator action; not run here.

## Deferred
- None.
