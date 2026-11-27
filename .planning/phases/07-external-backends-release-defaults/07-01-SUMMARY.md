---
phase: 07-external-backends-release-defaults
plan: 01
subsystem: infra
tags: [boundary-check, weaviate, qdrant, docker-compose, supply-chain]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: check-rag-boundary.mjs rule shape (04-09), package.json baseline (04-33), phase close (04-42)
  - phase: 05.1-prompt-injection-defense
    provides: last boundary-check edit (05.1-08)
provides:
  - VECTOR_STORE_PACKAGES export and the vector-store-client boundary rule
  - docker-compose.backends.yml with digest-pinned Qdrant v1.20.2 and Weaviate 1.40.7
  - package legitimacy evidence for @weaviate/node 3.15.5, @weaviate/core 3.15.5, @qdrant/js-client-rest 1.20.0
affects: [07-16 backend canary CI job, qdrant and weaviate adapters, src/lib/rag/sync]

actuals:
  tokens: 5200
  tasks: 2 of 3 (Task 1 checkpoint pending)
  commits: 4

tech-stack:
  added: []
  patterns: ["vendor client confined to its adapter folder by a dedicated boundary rule"]

key-files:
  created: [docker-compose.backends.yml]
  modified: [scripts/ci/check-rag-boundary.mjs, scripts/tests/check-rag-boundary.node-test.mjs]

key-decisions:
  - "Task 1 left at the human checkpoint: no package installed, evidence recorded under Operator pending"
  - "The boundary rule was added before the install, since it does not depend on the packages being present"
  - "Weaviate image 1.40.7 (newest 1.40.x patch, published 2026-11-20, 7 days old at execution)"

requirements-completed: []

coverage:
  - id: D1
    description: "vector-store-client rule refuses the seven Weaviate/Qdrant client names outside the three allowed folders"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "scripts/tests/check-rag-boundary.node-test.mjs#vector-store-client"
        status: pass
  - id: D2
    description: "Digest-pinned local Qdrant and Weaviate with write and read-only keys on 127.0.0.1"
    requirement: RET-07
    verification:
      - kind: other
        ref: "docker compose -f docker-compose.backends.yml config"
        status: pass
  - id: D3
    description: "Exact pins of the vector-store clients in package.json and package-lock.json"
    requirement: RET-06
    verification:
      - kind: other
        ref: "Task 2 lock check"
        status: unknown
---

# Phase 7 Plan 01: Vector-store packages gate, boundary rule, local backends Summary

The vector-store clients can now only be imported from the Weaviate and Qdrant adapter folders and `src/lib/rag/sync/`, and a digest-pinned compose file provides local Qdrant and Weaviate. The packages themselves are **not installed**: Task 1 is still waiting for the operator.

## Performance

- Tasks: Task 2 (boundary-rule part) and Task 3 done; Task 1 pending; Task 2 pin check pending until the install
- Files modified: 3

## Accomplishments

- `VECTOR_STORE_PACKAGES` (`@weaviate/node`, `@weaviate/core`, `@weaviate/web`, `weaviate-client`, `weaviate-ts-client`, `@qdrant/js-client-rest`, `@qdrant/qdrant-js`) and the rule `vector-store-client`. The rule applies everywhere except `src/lib/rag/backend/weaviate/`, `src/lib/rag/backend/qdrant/` and `src/lib/rag/sync/`, and it also covers sub-paths, `require` and dynamic `import`. Other `src/lib/rag/` folders (for example `v2/` and `backend/` outside the two adapters) are refused now, though the old `vector-or-rerank-client` rule allowed them.
- `VECTOR_OR_RERANK_PACKAGES` keeps only `cohere-ai` and `voyageai`, so the reranker clients behave as before.
- `docker-compose.backends.yml`: `qdrant/qdrant:v1.20.2@sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac` and `semitechnologies/weaviate:1.40.7@sha256:1373d227ef808c95601b79be75d5e613c04c5ad33a1a2e91ed91a5e6c2748144`. Both are OCI index digests, confirmed with `docker buildx imagetools inspect`. Write and read-only keys come from `QDRANT_API_KEY`, `QDRANT_READ_API_KEY`, `WEAVIATE_API_KEY` and `WEAVIATE_READ_API_KEY`, with placeholder defaults. Weaviate has AdminList on, with `reader` read-only and anonymous access off. It has a wget health check. Qdrant has no health check because its image has no curl or wget. All ports are bound to 127.0.0.1.

## Task Commits

1. Task 2 RED: `5698532e` test(07-01): add failing vector-store-client boundary cases. The 4 new cases failed with AssertionError.
2. Task 2 GREEN: `2daa8aa2` feat(07-01): confine vector-store clients to the adapter and sync folders
3. Task 3: `aca988af` chore(07-01): add digest-pinned local Qdrant and Weaviate compose file
4. SUMMARY: this commit

## Operator pending

**Task 1 (package-legitimacy checkpoint) is not approved, and nothing was installed.** The plan marks this checkpoint as never auto-approved and says only the orchestrator installs. The executor brief forbids adding packages. The delegation note that came in this session's automated notification does not count as owner approval. So the evidence below goes to a human, who answers "approved" or "fallback". The orchestrator then runs `npm install --save-exact @weaviate/node@3.15.5 @qdrant/js-client-rest@1.20.0` and commits package.json and package-lock.json. After that, the Task 2 lock check (the plan's `<verify>` node one-liner) needs to be run.

Evidence collected 2026-11-27 from registry.npmjs.org and api.npmjs.org (read-only):

| Check | @weaviate/node 3.15.5 | @weaviate/core 3.15.5 | @qdrant/js-client-rest 1.20.0 |
|---|---|---|---|
| repository | github.com/weaviate/typescript-client | github.com/weaviate/typescript-client | github.com/qdrant/qdrant-js |
| maintainers | 7, all @weaviate.io (incl. hello@weaviate.io) | same 7 | qdrant-tech (tools@qdrant.com), rendez |
| publisher | GitHub Actions trusted publisher (OIDC) | GitHub Actions trusted publisher (OIDC) | GitHub Actions trusted publisher (OIDC) |
| SLSA provenance | weaviate/typescript-client, .github/workflows/main.yaml, refs/tags/v3.15.5 | same | qdrant/qdrant-js, .github/workflows/release.yaml, refs/tags/v1.20.0 |
| registry signatures | present (keyid SHA256:DhQ8wR5A…) | present | present |
| install scripts | none (build only; no pre/post/install/prepare) | none (build only) | none (lint/test/build/codegen only) |
| engines | node >=22.0.0 | node >=22.0.0 | node >=22.0.0 |
| weekly downloads (11-19..11-25) | 1,312 | 1,377 | 918,532 |
| package created | 2026-09-16 | 2026-09-16 | 2023-04-18 |
| version published | 2026-11-13 (weekly cadence 3.15.0–3.15.5) | 2026-11-13 | latest |
| integrity | sha512-9maDwLAk…SHRA== | sha512-0hIfaqtX…85Bzw== | sha512-NhvW4z3r…2YQdg== |

- Fallback `weaviate-client` 3.15.3: same repository, created 2020-06-30. It is not marked deprecated on the registry.
- Look-alikes: none. `@weaviate/*` and `@qdrant/*` are vendor scopes. All three are published from the vendor repositories by OIDC with provenance.
- Not checked: the Weaviate docs page that names `@weaviate/node` as the new install line (how-to-verify step 2). This needs a browser check by the operator.
- Executor recommendation: **approve**. Every technical check passes. The only weak signal is the low download count of the two-month-old `@weaviate/*` names, which the rename from `weaviate-client` explains.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/rag/approval-gate-boundary.test.ts` (the only vitest file referencing the boundary script): 10 passed
- `node --test scripts/tests/check-rag-boundary.node-test.mjs`: 64 passed, 0 failed
- `node scripts/ci/check-rag-boundary.mjs`: ok, 2182 files, no violations
- `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: exit 0
- `docker compose -f docker-compose.backends.yml config`: valid. The three Task 3 acceptance greps return 1, 1 and 4.
- Not run, because the area was not touched: rag-db, Python, gen:schemas, test-rag, UI.
- Setup: `npm ci --ignore-scripts` and `fill-tiktoken-cache.py`. The uv syncs were skipped because no Python was touched.

## Deviations

- Task 2's precondition (the orchestrator's install commit) is not met. The boundary-rule part was done anyway, because it does not depend on the packages. The pin verification and the two package.json acceptance greps stay open.
- One existing test case changed: `vector-or-rerank-client: client packages …` now covers 5 imports instead of 7. The weaviate-client and qdrant imports moved to the new rule, so the case reports them as `vector-store-client`.

## Behaviour changes

- The CI boundary check now fails on any vector-store client import outside the three folders. No such import exists today.
- No runtime change and no new env variable.

## Deferred

- Task 1 approval and the orchestrator install, followed by the Task 2 pin check.
- RET-06 and RET-07 are not marked complete until the packages are installed and pinned.
