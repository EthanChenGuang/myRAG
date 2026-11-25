# Phase 5: Verified Citations & Groundedness - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-24
**Phase:** 05-verified-citations-groundedness
**Mode:** `--auto` (user standing instruction: accept the recommended option for every gray area)
**Areas discussed:** Citation record and unit, Non-Claude marker format and parsing, Scope of entry points, Claude path provider and eligibility, Groundedness scorer routing and packaging, Groundedness labels and thresholds, Post-stream delivery and storage, Answer-record storage and tenancy, Feedback and review queue, Badge and citation UI, Switches and defaults

[auto] Selected all gray areas. No todos matched (todo_count 0). No SPEC.md. No spike or sketch findings.

---

## Citation record and unit

| Option | Description | Selected |
|--------|-------------|----------|
| One normalized `CitationRecord` per final context block, with a snapshot (recommended) | Aliases assigned after the last context step; merged blocks keep every chunk id; snapshot quote persisted | ✓ |
| Per-chunk citations by raw chunk UUID | Models mangle UUIDs; breaks with Phase 4 merged blocks | |
| Store only chunk ids and re-read text on render | Breaks after re-chunk, replace or hard delete | |

**Choice:** [auto] recommended. D-01 to D-03.

## Non-Claude marker format and parsing

| Option | Description | Selected |
|--------|-------------|----------|
| Short aliases `[S1]` with an incremental split-safe parser; validated list as a schema record at finish (recommended) | Streams normally; "structured output" = Pydantic/Zod-validated record; no JSON mode on the answer | ✓ |
| JSON-mode / `responseFormat` answer with a citations array | Kills token streaming | |
| A second LLM helper call that lists citations after the answer | Extra cost; citations not produced by the generation are unverifiable | |

**Choice:** [auto] recommended. D-04.

## Scope of entry points

| Option | Description | Selected |
|--------|-------------|----------|
| Web chat only, gated by a client capability flag; WhatsApp, voice and embed unchanged; ghost chats not persisted (recommended) | WhatsApp hits `/api/chat` and would otherwise get raw markers; TTS would read markers | ✓ |
| Every caller of `/api/chat` | WhatsApp text would show `[S1]` markers | |
| Web chat plus embed | The embed widget has no message store; deferred | |

**Choice:** [auto] recommended. D-05 to D-07.

## Claude path provider and eligibility

| Option | Description | Selected |
|--------|-------------|----------|
| `@ai-sdk/anthropic` 3.x (ai-v6 tag), one text/plain citation document per block, `anthropicId` on the Model schema, conservative eligibility with a pre-first-token fallback to OpenRouter + chunk-alias (recommended) | Stays on AI SDK v6; MCP and multi-step turns fall back; webSearch enabled after the spike | ✓ |
| `@anthropic-ai/sdk` with `search_result` blocks | Bypasses the AI SDK stream; kept as an escape hatch only | |
| Separate map file for OpenRouter-to-Anthropic ids | Would drift from the five-location model sync | |

**Choice:** [auto] recommended. D-08 to D-10.

## Groundedness scorer routing and packaging

| Option | Description | Selected |
|--------|-------------|----------|
| Sidecar `/v1/groundedness` returns the raw score; Vectara for en/zh-Hans with key + opt-in; local HHEM-2.1-Open for en; else not_checked; HHEM in an optional `hhem` extra and Docker target with weights at build time and a pinned revision (recommended) | Keeps the default sidecar image small; no runtime downloads | ✓ |
| HHEM-2.1-Open in the default image | Adds torch and weights to every sidecar deploy | |
| Download weights at first request | Cold-start timeouts; unpinned remote code | |

**Choice:** [auto] recommended. D-11 and D-12.

## Groundedness labels and thresholds

| Option | Description | Selected |
|--------|-------------|----------|
| Vendor default 0.5 per (scorer, language) in a committed thresholds file, overridable by a calibration tool with a dev fit and a test holdout (recommended) | Same pattern as Phase 4 refusal calibration; the source of the threshold is recorded | ✓ |
| Show "not checked" until calibrated | The badge would be useless until labelled data exists | |
| Show the numeric score | Forbidden by GEN-06 | |

**Choice:** [auto] recommended. D-13 and D-14.

## Post-stream delivery and storage

| Option | Description | Selected |
|--------|-------------|----------|
| Close the stream normally; score in `after()`; the client polls a read endpoint and merges into message metadata (recommended) | Never delays the answer or keeps `useChat` busy | ✓ |
| Keep the stream open and push a `data-groundedness` part | Keeps the chat in a streaming state, which blocks the next message | |
| The server patches `chats.messages` JSONB | Races with client-side saves of the same array | |

**Choice:** [auto] recommended. D-15.

## Answer-record storage and tenancy

| Option | Description | Selected |
|--------|-------------|----------|
| New `rag_answer_records` table (migration, RLS select-own, server-only writes, chat cascade, 404 for not-owned) (recommended) | Authoritative server-side store for citations, groundedness and feedback; works with client-owned message JSONB | ✓ |
| Message metadata only | The server cannot write it safely; votes and scores would be lost | |
| Langfuse only | Langfuse is optional and sampled | |

**Choice:** [auto] recommended. D-16 and D-17.

## Feedback and review queue

| Option | Description | Selected |
|--------|-------------|----------|
| Thumbs control with an optional reason; database first, then a Langfuse `user_feedback` score; the review queue keeps the Phase 2 Langfuse tags and adds a DB source with reasons (recommended) | Votes are never lost; the queue does not depend on sampling | ✓ |
| A new standalone review-queue table and UI now | The Config UI queue is Phase 7 scope | |

**Choice:** [auto] recommended. D-18 and D-19.

## Badge and citation UI

| Option | Description | Selected |
|--------|-------------|----------|
| Three-state pill with a tooltip in the action row; hidden while pending and outside strict/balanced; superscript chips open the sources panel with the snapshot (recommended) | Matches GEN-06; no number | ✓ |
| Inline sentence highlighting | UX-01, deferred | |

**Choice:** [auto] recommended. D-20.

## Switches and defaults

| Option | Description | Selected |
|--------|-------------|----------|
| Separate off-by-default switches for citations, Claude citations, groundedness, the Vectara opt-in (plus a multi-tenant acknowledgment) and feedback, in the five locations (recommended) | Each component can be rolled back alone | ✓ |
| One master switch | Cannot isolate the Claude path or the external egress | |

**Choice:** [auto] recommended. D-21 to D-26.

## Claude's Discretion

- File layout under `src/lib/rag/generation/`, prompt and tooltip wording, polling constants, badge visuals, jsonb field names beyond those named.

## Deferred Ideas

- Embed widget citations; webSearch citations on the Claude path; an Italian LLM-judge fallback; per-tenant Vectara opt-in; treating zero-citation strict answers as unsupported; UX-01 and UX-02; blocking on groundedness; garbage collection of superseded chunks.
