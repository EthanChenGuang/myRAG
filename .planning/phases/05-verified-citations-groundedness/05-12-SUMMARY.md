---
phase: 05-verified-citations-groundedness
plan: 12
subsystem: rag-sidecar
tags: [groundedness, hhem, vectara, sidecar, fastapi]

requires:
  - phase: 05-verified-citations-groundedness
    provides: GroundednessRequest and GroundednessResult (05-01), SidecarReady.scorers (05-07)
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: main.py, settings.py and .env.example as of 03.1-27 and 03.1-37
provides:
  - POST /v1/groundedness (raw score only, behind SharedSecretMiddleware)
  - rag_sidecar.groundedness package: Scorer protocol, StubScorer, ScorerUnavailable, ScorerBusy, build_scorers, VectaraScorer, LocalHhemScorer, build_groundedness_router
  - /ready lists the available scorers
  - sidecar settings VECTARA_API_KEY, VECTARA_BASE_URL, HHEM_MODEL_REVISION
affects: [05-14, 05-17, 05-18, 05-26]

actuals:
  tasks: 3
  commits: 7
plan_head_before: a563ff0
plan_head_after: 9b374b9

tech-stack:
  added: []
  patterns:
    - "Heavy ML imports live inside the default loader only; availability is find_spec plus the pinned HF snapshot directory"
    - "The concurrency-1 semaphore is released from the executor future's done callback, so a cancelled request cannot let a second inference start"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/groundedness/__init__.py
    - rag-sidecar/src/rag_sidecar/groundedness/scorer.py
    - rag-sidecar/src/rag_sidecar/groundedness/router.py
    - rag-sidecar/src/rag_sidecar/groundedness/vectara.py
    - rag-sidecar/src/rag_sidecar/groundedness/local_hhem.py
    - rag-sidecar/tests/test_groundedness.py
    - rag-sidecar/tests/test_groundedness_vectara.py
  modified:
    - rag-sidecar/src/rag_sidecar/main.py
    - rag-sidecar/src/rag_sidecar/settings.py
    - rag-sidecar/.env.example

key-decisions:
  - "Language matching is case-insensitive on the exact codes en and zh-Hans; zh, zh-Hant, it, mixed and anything else are unsupported_language"
  - "Order of checks: unsupported_language, then too_long, then routing"
  - "too_long applies to premise over 60,000 characters in total and, additively, to a hypothesis over 60,000 characters (the local model is O(n^2))"
  - "Request body capped at 1 MiB (413 groundedness_request_too_large); body parsed with model_validate_json so unknown fields, bad JSON and contract violations all give 422 invalid_groundedness_request"
  - "Any unexpected scorer exception and any NaN or out-of-range score is treated as ScorerUnavailable, never a 500"
  - "Vectara: one lazily created AsyncClient, httpx.Timeout(8.0, connect=2.0) plus an asyncio.wait_for total deadline of 8 s, no redirects, no retries; reasons vectara_timeout, vectara_network_error, vectara_http_<status>, vectara_bad_response; only the status code is logged"
  - "Local HHEM: available only when torch and transformers are importable and <HF hub cache>/models--vectara--hallucination_evaluation_model/snapshots/<HHEM_MODEL_REVISION> exists; a load failure is remembered and the scorer then reports unavailable instead of reloading per request"
  - "build_scorers only includes Vectara when a non-blank key is set and the local scorer only when available, so /ready reports exactly what can score"

requirements-completed: [GEN-05]
---

# Phase 5 Plan 12: Sidecar groundedness endpoint Summary

The sidecar now answers `POST /v1/groundedness` per D-11: Vectara hhem_v2.3 for en or zh-Hans when the request allows it and a key is set, local HHEM-2.1-Open for en otherwise, and `not_checked` with a reason code in every other case. Everything is tested with stub scorers and an httpx MockTransport; no weights or keys are needed.

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1 Router, scorer protocol, routing matrix | 9424b99 | fad6c5e |
| 2 Vectara client and settings | 2343d44 | 3afa221 |
| 3 Local HHEM-2.1-Open scorer | 985bd9c | 9b374b9 |

Each RED commit failed on assertions (endpoint 404, stub scorers returning wrong values), not on missing modules.

## Behaviour changes

- New authenticated endpoint `POST /v1/groundedness`; 401 without or with a wrong secret, 503 with no configured secret (existing middleware).
- `/ready` responses now carry `scorers` (empty unless a Vectara key is set or the hhem image is used). Existing ready/not-ready logic is unchanged.
- With no `VECTARA_API_KEY` and no hhem packages (the default image), every request returns `not_checked`; nothing leaves the deployment.

## Deviations

- Added a hypothesis length cap (60,000 characters, `too_long`) and a 1 MiB body cap (413). Both are additive DoS guards.
- `build_groundedness_router(settings, scorers)` takes settings as planned but does not read them yet.
- No migration and no app-side env changes: the three variables are sidecar-only, like the existing `RAG_INGEST_WORKER*`, which are not in `scripts/rag/env-manifest.json` either.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: 0 diagnostics
- `npx vitest run`: 248 files, 3907 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 166 passed
- `node scripts/ci/check-rag-boundary.mjs` ok; its node test 38 passed
- `node scripts/check-config.mjs`: ok, 125 variables
- `check-workflows.py`: OK
- `npm run gen:schemas`: no diff (no contract touched)
- rag-sidecar pytest: 1121 passed, 10 skipped
- `tests/rag-db/*.test.mts`: 980 passed, 12 failed — pre-existing (same 12 failures on base a563ff0: "every v2 retrieval path stays inside the caller tenant… with every switch on", scope `o` subtests for paths all, exact_id, translated)
- eval pytest: 632 passed, 4 failed — pre-existing: the 3 known test_parse_fixtures failures (fixtures restored), plus `test_ingest_golden.py::test_existing_ingest_golden_items_are_unchanged` (PRE_CLAUSE_SHA256 mismatch), which also fails on base a563ff0
- `npm run test-rag`: not run; this plan touches no retrieval, ingest or golden-set code

## Operator actions

- To use Vectara: set `VECTARA_API_KEY` in the sidecar environment only (the app still has to send `allow_vectara`, decided in 05-14).
- The local scorer needs the hhem image target and baked weights (plan 05-17), with `HF_HUB_OFFLINE=1`.

## Deferred

- Docker `hhem` target, weight baking and the flan-t5-base pin check: 05-17.
- App-side client, eligibility and the Vectara multi-tenant gate: 05-14.
- Live checks of Vectara and real HHEM latency and memory: 05-26.
