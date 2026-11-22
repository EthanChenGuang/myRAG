# Phase 1: Evaluation Harness & Baseline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-22
**Phase:** 1-Evaluation Harness & Baseline
**Areas discussed:** Hard-to-reverse choices

The user's standing instruction for this run is "all questions follow your recommendations", so recommended answers were accepted without a prompt.

---

## Hard-to-reverse choices

| Option | Description | Selected |
|--------|-------------|----------|
| PGlite + real SQL functions | In-process Postgres with pgvector loading the repo's SQL, behind a Supabase-compatible rpc() adapter | ✓ |
| In-memory JS cosine mock | No SQL fidelity; would not exercise the real RPC functions | |
| Docker Postgres | No Docker daemon in this environment | |
| `POST /api/internal/rag/run` with `x-rag-eval-secret` | Off in production unless enabled, constant-time compare, fails closed | ✓ |
| Bearer token / CLI only | Bearer conflicts with user-session auth headers; CLI-only does not exercise the endpoint | |
| Span-labelled `GoldenItem` (Pydantic) | Survives re-chunking | ✓ |
| Chunk-ID gold labels | Invalidated by every chunking change | |
| Vitest, json-schema-to-zod, PGlite, uv + lockfile, FastAPI + pytest | Standard, TS-native, reproducible | ✓ |
| node:test, hand-written Zod mirror, pip without lockfile | Drift and reproducibility risks | |

**User's choice:** Recommended answers (standing instruction).

---

## Decided autonomously

[auto] [Fixture run] — Q: "How are embeddings produced without live keys?" → Selected: "Deterministic local fixture embedder, only when explicitly selected" (reversible technical — decided autonomously: internal provider behind a switch)
[auto] [Fixture run] — Q: "How do TS and Python exchange results?" → Selected: "JSONL traces scored by the Python runner" (reversible technical — decided autonomously: internal file format)
[auto] [Baseline] — Q: "How is the noise band defined?" → Selected: "mean minus max(3 x spread, 0.02)" (reversible technical — decided autonomously: one config value)
[auto] [Baseline] — Q: "Where does the baseline live?" → Selected: "eval/baselines/fixture-baseline.json" (reversible technical — decided autonomously: one file)
[auto] [Baseline] — Q: "How is the failing-PR demo shown?" → Selected: "A test with a degraded config asserts gate failure" (reversible technical — decided autonomously: test code)
[auto] [Golden set] — Q: "When does a retrieved chunk match gold evidence?" → Selected: "Same document and contains the normalized quote" (reversible technical — decided autonomously: metric code)
[auto] [Golden set] — Q: "How is the dev/test split frozen?" → Selected: "Hash-based 70/30 split in a manifest" (reversible technical — decided autonomously: recomputable)
[auto] [Golden set] — Q: "Which judge model?" → Selected: "Pinned non-Claude judge via OpenRouter, temperature 0, telemetry off" (reversible technical — decided autonomously: config value)
[auto] [CI] — Q: "Which CI provider and layout?" → Selected: "GitHub Actions PR smoke + nightly, Node 22, Python 3.12" (reversible technical — decided autonomously: workflow files)
[auto] [Config] — Q: "How is config drift checked?" → Selected: "Manifest + check-config script" (reversible technical — decided autonomously: script and JSON)

## Claude's Discretion

- Fixture corpus content and size; report layout; how characterization tests isolate the chat route.

## Deferred Ideas

- Real-knowledge-base baseline and threshold calibration (live verification).
- Production sampling into eval (v2).
