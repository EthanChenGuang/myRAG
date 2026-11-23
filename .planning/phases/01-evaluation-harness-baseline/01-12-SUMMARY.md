---
phase: 01-evaluation-harness-baseline
plan: 12
subsystem: infra
tags: [fastapi, sidecar, auth, docker, uv, pydantic, healthcheck]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-05 SidecarHealth, SidecarReady, SidecarInfo, SidecarError contracts; 01-01 locked rag-sidecar uv project"
provides:
  - "create_app(settings) FastAPI factory and module-level app (rag_sidecar.main:app)"
  - "SharedSecretMiddleware: fail-closed x-sidecar-secret auth with constant-time compare"
  - "GET /health, GET /ready (unauthenticated probes) and GET /v1/info (authenticated)"
  - "rag-sidecar/Dockerfile (python:3.12-slim, uv 0.11.32, locked, non-root, HEALTHCHECK) and .dockerignore"
affects: [01-22, 02-docling-parse, 02-hhem-groundedness]

plan_head_before: 72cd7d83b238632c47fc40f5fc82968b080f4cf9
plan_head_after: 2ee46f2b297d502afd20163b7d66363a74f47ce3

actuals:
  tokens: 11000
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Pure ASGI middleware guards every path (unknown paths and disabled docs included) so a future /v1 route cannot ship unauthenticated"
    - "Secret compared as SHA-256 digests under hmac.compare_digest; header value never logged"
    - "Boot test builds its own locked --no-dev environment under tmp_path via UV_PROJECT_ENVIRONMENT, leaving the dev venv intact"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/settings.py
    - rag-sidecar/src/rag_sidecar/auth.py
    - rag-sidecar/src/rag_sidecar/main.py
    - rag-sidecar/tests/test_auth.py
    - rag-sidecar/tests/test_health.py
    - rag-sidecar/Dockerfile
    - rag-sidecar/.dockerignore
    - rag-sidecar/tests/test_boot.py
    - rag-sidecar/tests/test_image_boundary.py
  modified: []

key-decisions:
  - "A secret shorter than 32 characters is treated exactly like an unset secret (503 everywhere except probes), so a weak secret can never authenticate"
  - "Probe exemption is exact-match on /health and /ready; /health/ and every other path require auth"
  - "WebSocket scopes are closed with 1008; lifespan scopes pass through"
  - "Boot test uses an isolated locked --no-dev environment in tmp_path instead of mutating the dev venv mid-pytest-run"

patterns-established:
  - "Sidecar routes are added under the /v1 APIRouter and inherit auth from the middleware, not per-route dependencies"

requirements-completed: []

coverage:
  - id: D1
    description: "GET /health returns 200 without a secret; GET /ready is 200 only with a secret of at least 32 characters, otherwise 503 not_ready"
    requirement: EVAL-01
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_health.py (unset, 31-char and 48-char secrets)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Unset or short secret makes every non-probe request (including /v1/info, unknown paths, /docs, /openapi.json) return 503 SidecarError"
    requirement: EVAL-01
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_health.py::test_unconfigured_secret_refuses_every_non_probe_path_even_with_header"
        status: pass
    human_judgment: false
  - id: D3
    description: "With the secret set, missing or wrong (including last-character-only) header is 401, correct header returns SidecarInfo; docs and OpenAPI are disabled (401 then 404)"
    requirement: EVAL-01
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_auth.py"
        status: pass
    human_judgment: false
  - id: D4
    description: "Twenty concurrent /v1/info requests with mixed valid, wrong and missing headers are each judged by their own header"
    requirement: EVAL-01
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_auth.py::test_twenty_concurrent_requests_are_judged_by_their_own_header"
        status: pass
    human_judgment: false
  - id: D5
    description: "Dockerfile uses python:3.12-slim, pinned uv 0.11.32, uv sync --locked --no-dev, non-root USER, HEALTHCHECK on /health, no secret in ENV/ARG; uv.lock holds no deepeval, ragas, langchain or anthropic"
    requirement: EVAL-01
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_image_boundary.py (9 cases)"
        status: pass
    human_judgment: false
  - id: D6
    description: "uvicorn boots rag_sidecar.main:app from the locked --no-dev environment and answers /health 200, /ready 503"
    requirement: EVAL-01
    verification:
      - kind: integration
        ref: "rag-sidecar/tests/test_boot.py"
        status: pass
    human_judgment: false
  - id: D7
    description: "The image actually builds and runs as a healthy non-root container"
    requirement: EVAL-01
    verification:
      - kind: manual
        ref: "docker build rag-sidecar plus run/curl matrix from the plan; no Docker daemon here, CI docker-build job lands in plan 01-22"
        status: pending
    human_judgment: true

duration: 8min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 12: Authenticated Sidecar Skeleton and Dockerfile Summary

**FastAPI sidecar with fail-closed shared-secret ASGI middleware (SHA-256 + hmac.compare_digest, 32-char minimum), unauthenticated /health and /ready probes, authenticated /v1/info, and a locked non-root uv Dockerfile**

## Performance

- **Duration:** 8 min
- **Tasks:** 2
- **Files modified:** 9 (all created)

## Accomplishments
- `auth.py` guards every HTTP path except the exact probe paths: 503 `sidecar secret not configured` when the secret is unset or under 32 characters, 401 `unauthorized` for a missing or wrong `x-sidecar-secret`. Docs and OpenAPI are disabled, so unknown paths and `/docs` are 503 or 401 before they can be 404.
- `main.py` exposes `create_app`/`app` with `/health`, `/ready` and `/v1/info` (service `rag-sidecar`, package version, contracts schema version 1), using the plan 01-05 contracts for responses and errors.
- `Dockerfile` follows the uv Docker guide layering (dependency layer, then project), pinned `ghcr.io/astral-sh/uv:0.11.32`, `uv sync --locked --no-dev`, uid 10001, stdlib `HEALTHCHECK` on `/health`, no secret baked in. `.dockerignore` excludes venvs, caches, tests, schemas and env files.
- Full sidecar suite: 131 passed (100 pre-existing, 21 for Task 1, 10 for Task 2). `npm test` and `npm run test-rag` stay green.

## Task Commits

1. **Task 1: FastAPI app, fail-closed middleware, probes, /v1/info** (TDD) - `afba3be` (feat)
2. **Task 2: Dockerfile, .dockerignore, boot and image-boundary tests** - `2ee46f2` (feat)

## TDD Evidence

- **Task 1:** tests were written before the modules; the first run failed at collection with `ModuleNotFoundError` for `rag_sidecar.main`/`settings` (no implementation existed), then 21 passed after implementation. RED and GREEN were committed together as one `feat` commit rather than a separate `test` commit, so there is no `test(01-12)` gate commit; this plan is `type: execute`, not `type: tdd`.

## Files Created/Modified
- `rag-sidecar/src/rag_sidecar/settings.py` - `SidecarSettings`, `load_settings`
- `rag-sidecar/src/rag_sidecar/auth.py` - `SharedSecretMiddleware`, `PROBE_PATHS`
- `rag-sidecar/src/rag_sidecar/main.py` - `create_app`, `app`
- `rag-sidecar/tests/test_auth.py`, `test_health.py`, `test_boot.py`, `test_image_boundary.py`
- `rag-sidecar/Dockerfile`, `rag-sidecar/.dockerignore`

## Decisions Made
- A secret under 32 characters is handled as unset (503), never as a usable credential.
- Probe exemption is exact-match only; `/health/` requires auth.
- Non-HTTP scopes: lifespan passes through, WebSocket closes with code 1008.
- The empty string for `RAG_SIDECAR_SECRET` is read as unset.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Boot test would uninstall pytest from the running dev venv**
- **Found during:** Task 2
- **Issue:** The plan has test_boot.py run `uv sync --locked --no-dev` against the project environment, which removes pytest from the venv that is executing the test run (the next `uv run` had to reinstall it).
- **Fix:** The test sets `UV_PROJECT_ENVIRONMENT` to a directory under `tmp_path`, syncs the locked no-dev environment there and boots uvicorn with that interpreter. This also proves the production dependency set on its own.
- **Files modified:** `rag-sidecar/tests/test_boot.py`
- **Commit:** `2ee46f2`

**Total deviations:** 1 auto-fixed. **Impact:** none on scope; the verify command from the plan passes unchanged.

## Issues Encountered
- `commits: 3` in the frontmatter is the measured `rev-list` count from the plan start; it includes `7a20050` (`docs(prompts): ...`), a commit by another actor made on the same branch while this plan ran. Plan 01-12's own commits are `afba3be` and `2ee46f2`.

## Known Stubs
None.

## Threat Flags
None beyond the register: T-01-12 to T-01-16 and T-01-SC are mitigated as planned (middleware covers all non-probe paths, compare_digest over SHA-256, 32-char minimum, non-root user, locked no-dev install, nothing logged).

## User Setup Required
None. Set `RAG_SIDECAR_SECRET` (at least 32 characters) at run time for the service to become ready.

## Open Verification
- Docker image build and run were not exercised (no Docker daemon). Run the plan's human-check (`docker build -t rag-sidecar:local rag-sidecar`, run with and without `RAG_SIDECAR_SECRET`, curl `/health`, `/ready`, `/v1/info`, `docker inspect` for non-root and healthy) or rely on the `docker-build` CI job in plan 01-22.
- EVAL-01 stays Pending in REQUIREMENTS.md: plan 01-22 also lists it (CI image build).

## Next Phase Readiness
- Later `/v1/*` routes added to `main.py` are authenticated by default. Plan 01-22 wires `docker build rag-sidecar` into CI.

## Self-Check: PASSED

All nine created files exist, commits `afba3be` and `2ee46f2` are ancestors of HEAD, and `uv run --directory rag-sidecar pytest -q` reports 131 passed.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
