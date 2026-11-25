---
phase: 05-verified-citations-groundedness
plan: 05
subsystem: rag
tags: [rag, dependencies, citations, groundedness, hhem, supply-chain]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: extras layout and the pytorch-cpu index and torch source entries (03-05)
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: dependency-boundary test and the last pyproject/lock edit (03.1-04); last package.json edit (03.1-51)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: last package.json edit (04-33)
provides:
  - "@ai-sdk/anthropic 3.0.143 pinned exactly on the ai-v6 line; ai stays 6.0.3"
  - "rag-sidecar optional `hhem` extra: torch==2.15.0 (pytorch CPU index) and transformers==5.23.0, locked"
  - "Approved HF revisions for the HHEM image: vectara/hallucination_evaluation_model@de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8, google/flan-t5-base@7bcac572ce56db69c1ea7c8af255c5d7c9672fc2"
affects: [05-08 Claude Citations path, 05-17 HHEM image build]

actuals:
  tokens: 30000
  tasks: 3
  commits: 6

tech-stack:
  added:
    - "@ai-sdk/anthropic 3.0.143 (npm, exact)"
    - "hhem extra: torch 2.15.0+cpu, transformers 5.23.0 (already in the lock via docling/constraints; no new Python packages)"
  patterns:
    - "Dependency pins guarded by tests that read package.json, package-lock.json and uv.lock"

key-files:
  created:
    - tests/rag/citations/provider-pin.test.ts
  modified:
    - package.json
    - package-lock.json
    - rag-sidecar/pyproject.toml
    - rag-sidecar/uv.lock
    - rag-sidecar/tests/test_dependency_boundary.py
    - eval/uv.lock

key-decisions:
  - "Checkpoint outcome: user approved 2026-11-25 ('approved, no sentencepiece'); evidence in 05-05-PACKAGE-VERIFICATION.md"
  - "sentencepiece rejected and asserted absent from the hhem extra and the sidecar lock; transformers 5.23.0 does not require it (only an optional extra, left off)"
  - "torch stays 2.15.0, the version already locked for docling"

requirements-completed: [GEN-01, GEN-05]
---

# Plan 05-05 Summary: approved provider and HHEM runtime pins

## Checkpoint (Task 1)

Satisfied before execution. The user approved on 2026-11-25 with "approved, no sentencepiece" and accepted both lockfile side effects of the provider install (eventsource-parser 3.0.6 → 3.1.1, nested undici 6.29.1). The verification report is `05-05-PACKAGE-VERIFICATION.md`.

## Commits

| Task | Commit | What |
|---|---|---|
| 2 RED | 8a3d71a | `tests/rag/citations/provider-pin.test.ts` (3 of 5 cases failed on assertions) |
| 2 GREEN | 666092a | `npm install --save-exact --ignore-scripts @ai-sdk/anthropic@3.0.143` |
| 3 RED | 171ca00 | hhem cases in `test_dependency_boundary.py` (2 failed on assertions) |
| 3 GREEN | 203cd16 | `hhem` extra in pyproject, `uv lock` |
| 3 follow-up | cfdd0d7 | `eval/uv.lock` mirrors the rag-sidecar path dependency metadata |

## Lockfile changes

`package-lock.json`, compared package by package against trunk: exactly the approved set.

```
ADDED    node_modules/@ai-sdk/anthropic                                     3.0.143
ADDED    node_modules/@ai-sdk/anthropic/node_modules/@ai-sdk/provider       3.0.19
ADDED    node_modules/@ai-sdk/anthropic/node_modules/@ai-sdk/provider-utils 4.0.67
ADDED    node_modules/@ai-sdk/anthropic/node_modules/undici                 6.29.1
CHANGED  node_modules/eventsource-parser                                    3.0.6 -> 3.1.1
```

`rag-sidecar/uv.lock`: only the rag-sidecar metadata changes (hhem optional deps, two requires-dist entries, `provides-extras` gains `hhem`). There are no new or changed packages, and no sentencepiece.

`eval/uv.lock`: the same three metadata lines for the rag-sidecar path dependency. There are no package changes.

## Behaviour changes

None at runtime. The provider is installed but nothing imports it yet (plan 05-08). The default sidecar environment still cannot import torch or transformers. Installing the extra and baking the weights is plan 05-17.

## Deviations

1. **Waived precondition.** The 04-43 and 03.1-54 SUMMARYs did not exist. The orchestrator waived this because neither plan modifies any file, so only the ordering changes.
2. **`eval/uv.lock` changed** even though it is not in `files_modified`. eval depends on rag-sidecar by path, and `uv sync --locked` in `eval/` fails without the refresh ("hint: To update the lockfile, run `uv lock`"). The change covers metadata only and adds no package. The first gate run (`uv run --directory eval ...`) made it automatically.
3. **Extra tests.** Task 3 also asserts that sentencepiece is absent from the hhem extra and from the lock, and that torch resolves from the CPU index with sha256 hashes for every artifact.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 289 files, 4596 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 172/172 passed. The first run failed 3 sidecar launcher subtests because the tiktoken cache was empty (the known environment issue). They passed after `scripts/ci/fill-tiktoken-cache.py`.
- `node --import tsx --test tests/rag-db/*.test.mts`: 1457 passed, 4 skipped, 0 failed
- `check-rag-boundary` and its node test: pass
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- rag-sidecar pytest: 1393 passed, 11 skipped
- eval pytest: 735 passed
- Contracts were not touched, so `gen:schemas` was not needed.

## Operator actions

None. A streaming smoke test of the chat path after deploy is advisable because the hoisted eventsource-parser moves to 3.1.1. Every unit test covering the streaming path passes.

## Deferred

- Installing the hhem extra, baking the pinned HF revisions, running offline, and checking that the flan-t5 tokenizer loads without sentencepiece: plan 05-17.
