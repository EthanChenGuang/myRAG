---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 16
subsystem: database
tags: [relex, lexical, pgvector, fixture]

requires:
  - phase: 04-03
    provides: chunkLexicalText and LEXICAL_VERSION 2
  - phase: 04-06
    provides: rag_relex_candidates and rag_relex_batch RPCs
provides:
  - npm run rag:relex operator CLI
  - runRelex / dryRunRelex batch job
  - fixture databases with v2 lexical_text by default
affects:
  - eval harness and legacy smoke baselines
  - Phase 4 pgvector conformance factory (04-17)

actuals:
  tokens: 52000
  tasks: 2
  commits: 2
plan_head_before: 8d4b7f098a762aa819ff28ef8fe7ef659ced7e39
plan_head_after: e0ee0bb

tech-stack:
  added: []
  patterns:
    - "Ingest batch job mirroring re-embed: RpcClient paging + keyset resume"
    - "PGlite pgliteRpcClient for in-process service-role RPCs in fixtures"

key-files:
  created:
    - src/lib/rag/ingest/relex/run.ts
    - src/lib/rag/ingest/relex/cli.ts
    - tests/rag-db/relex.test.mts
  modified:
    - package.json
    - eval/harness/pglite-supabase.mts
    - eval/harness/two-tenant.mts

key-decisions:
  - "Fixture builds run relex by default with opt-out relex:false for job tests"
  - "two-tenant harness runs a second relex pass after canary chunks are inserted"

patterns-established:
  - "Operator lexical backfill uses rag_relex_* RPCs only; no ingest or embedding deps"

requirements-completed: [RET-03]

coverage:
  - id: D1
    description: "npm run rag:relex rebuilds lexical_text resumably with dry-run and tenant filters"
    requirement: RET-03
    verification:
      - kind: integration
        ref: "node --import tsx --test tests/rag-db/relex.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fixture databases ship with lexical_version 2 on every chunk"
    requirement: RET-03
    verification:
      - kind: integration
        ref: "tests/rag-db/relex.test.mts fixture databases ship with lexical v2"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 16: rag:relex backfill and fixture lexical v2 Summary

**Resumable `npm run rag:relex` rebuilds lexical_text from stored chunk columns with zero parser or embedding calls, and fixture databases default to tokenizer v2.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2
- **Commits:** 2 (`028e006`, `e0ee0bb`)

## Accomplishments

- `runRelex` / `dryRunRelex` page `rag_relex_candidates`, build text via `chunkLexicalText`, fill NULL `language` with `detectLanguage`, write through `rag_relex_batch`.
- CLI: `--dry-run`, `--batch-size`, `--tenant`, `--resume-after`; refuses without `SUPABASE_SERVICE_ROLE_KEY`.
- `createFixtureDatabase` and `createTwoTenantDatabase` run the job after corpus/canary inserts; `sqlSha256` records `lexical_version:2`.

## Tests

| Command | Result |
|---------|--------|
| `node --import tsx --test tests/rag-db/relex.test.mts` | pass (9) |
| `node --import tsx --test tests/two-tenant-fixture.test.mts` | pass (8) |
| `npm run test-rag -- --out eval/out/p4-16` | **skipped** (`spawnSync uv ENOENT` — no `uv` on VM; orchestrator smoke) |
| `npx tsc --noEmit` | pass (pre-existing test file warnings in output) |
| `check-rag-boundary`, `check-config`, `check-workflows` | pass |

## Deviations from Plan

None — plan executed as written.

## Self-Check: PASSED

- FOUND: `src/lib/rag/ingest/relex/run.ts`
- FOUND: `src/lib/rag/ingest/relex/cli.ts`
- FOUND: `tests/rag-db/relex.test.mts`
- FOUND: commit `028e006`
- FOUND: commit `e0ee0bb`