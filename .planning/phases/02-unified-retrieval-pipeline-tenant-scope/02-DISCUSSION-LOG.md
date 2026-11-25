# Phase 2: Unified Retrieval Pipeline & Tenant Scope - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-23
**Phase:** 02-unified-retrieval-pipeline-tenant-scope
**Mode:** `--auto` (standing instruction: "all questions follow your recommendations"); every choice below is the recommended option
**Areas discussed:** Chat tenant resolution, Embed tenant, Voice tenant, Other knowledge-base readers, Failure status mapping, Stage switches, RAG_PIPELINE values, Context-assembly sharing, Type-check criterion, Langfuse SDK, Review queue content, Negative control, Real-user gate, Node 22 scope

---

## Chat tenant resolution

| Option | Description | Selected |
|--------|-------------|----------|
| Verify body organizationId against organization_members; non-member 403; no session = empty | Fail closed, keeps today's empty result for anonymous callers (WhatsApp) | ✓ |
| Ignore body organizationId and always use the personal workspace | Breaks team workspaces | |
| 401 for every anonymous multi-tenant request | Breaks the WhatsApp webhook path | |

[auto] Chat tenant — Q: "How is the tenant resolved and what happens to a forged organizationId?" → Selected: "Verify membership; 403 for non-members; no session = empty/no_tenant" (recommended)

## Embed tenant

| Option | Description | Selected |
|--------|-------------|----------|
| Env-level `RAG_EMBED_TENANT`, fail closed in multi-tenant when unset, 403 on a mismatching body | Smallest change that binds the widget server-side | ✓ |
| Per-widget embed keys in a new table | New capability (deferred) | |
| Keep no scope | Violates PIPE-03 | |

[auto] Embed tenant — Q: "Where does the embed widget's workspace come from?" → Selected: "RAG_EMBED_TENANT env" (recommended)

## Voice tenant

| Option | Description | Selected |
|--------|-------------|----------|
| HMAC voice RAG token minted by the authenticated LiveKit token route, in participant metadata, forwarded by the agent | Signed, expiring, server-derived identity; no global fallback | ✓ |
| Verify the LiveKit JWT in the app | The agent never sees the user's JWT; identity is caller-chosen today | |
| Keep userId plus internal key | Violates PIPE-04 | |

[auto] Voice tenant — Q: "How does voice prove its tenant?" → Selected: "HMAC voice RAG token, TTL 3600 s, 401 otherwise" (recommended). Noted as one-way: app and voice-agent deploy together.

## Other knowledge-base readers

| Option | Description | Selected |
|--------|-------------|----------|
| Route generate-image/video, general-overview fallback and document references through the pipeline with scope | Closes global reads, satisfies the boundary check | ✓ |
| Allow-list them in the boundary check | Leaves cross-tenant reads | |

[auto] Other readers — Q: "What about the media routes' global search?" → Selected: "Through the pipeline with the caller's scope" (recommended)

## Failure status mapping

| Option | Description | Selected |
|--------|-------------|----------|
| Refusal only on verified empty; error and degraded-empty stream a localized error | Meets PIPE-06; keeps strict refusal for true empties | ✓ |
| Treat degraded-empty as empty | Could refuse because an optional stage failed | |

[auto] Status mapping — Q: "When does strict mode refuse?" → Selected: "Only on status empty" (recommended)

## Stage switches

| Option | Description | Selected |
|--------|-------------|----------|
| `RAG_DISABLED_STAGES` + `RAG_STAGE_TIMEOUTS` lists, per-profile defaults in code | Two env vars cover every stage | ✓ |
| One env var per stage and per timeout | Dozens of vars across five config locations | |

[auto] Stage switches — Q: "How are stage switches and timeouts configured?" → Selected: "Two list-valued env vars" (recommended)

## RAG_PIPELINE values

| Option | Description | Selected |
|--------|-------------|----------|
| `legacy` only in Phase 2, `v2` reserved for Phase 4 | Nothing new to compare yet | ✓ |
| Build a v2 strategy now | Scope creep into Phase 4 | |

## Context-assembly sharing

| Option | Description | Selected |
|--------|-------------|----------|
| Chat format canonical (byte-identical); embed reuses; voice keeps its response shape; characterize first | Shared step without breaking the baseline | ✓ |
| Keep three assemblers | Violates PIPE-05 | |

## Type-check criterion ("tsc --noEmit passes")

| Option | Description | Selected |
|--------|-------------|----------|
| Zero errors in new code plus a per-file ratchet over full tsc | 312 legacy errors exist today in unrelated code | ✓ |
| Fix all 312 legacy errors | Large scope creep across WhatsApp, MCP and UI | |

[auto] Type-check — Q: "How is SC1's tsc requirement met?" → Selected: "New-code zero + ratchet" (recommended)

## Langfuse SDK

| Option | Description | Selected |
|--------|-------------|----------|
| `@langfuse/tracing` + `@langfuse/otel` on an isolated provider | Supported OTLP path; Node 22 | ✓ |
| Legacy `langfuse` v3 SDK / ingestion API | Ingestion API sunset on Langfuse Cloud 2026-11-16 | |
| Hand-written OTLP exporter | Reinvents the SDK | |

## Review queue content

| Option | Description | Selected |
|--------|-------------|----------|
| Separate review sample (default 0) with server-side PII masking | Content masked by default stays the rule | ✓ |
| Capture content for all traces | Violates the default-masking decision | |

## Negative control

| Option | Description | Selected |
|--------|-------------|----------|
| Eval-only `drop_top_candidate` degrade with a 0.05 MRR margin assertion | Wide, deterministic margin | ✓ |
| Keep max_results=1 only | Margin about one dev item | |

## Real-user gate

| Option | Description | Selected |
|--------|-------------|----------|
| Gate on `production` items once present | Literal reading of EVAL-14 | ✓ |
| Gate on `production` + `human` | Human-drafted items are not real-user wording | |

## Node 22 scope

| Option | Description | Selected |
|--------|-------------|----------|
| App + voice-agent Dockerfile + docs + CI check; baileys stays on 20 | Covers PIPE-10 without touching an unrelated service | ✓ |
| Also move baileys-whatsapp | Unrelated service risk | |

## Claude's Discretion

- `src/lib/rag/` internal layout, PII patterns, span attribute names, sampling RNG, wording of the localized error messages.

## Deferred Ideas

- Per-widget embed keys; WhatsApp multi-tenant tenancy; voice token refresh; removing voice heuristics; revoking legacy RPC `anon` grants; latency gating.
