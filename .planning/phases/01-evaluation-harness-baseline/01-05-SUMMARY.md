---
phase: 01-evaluation-harness-baseline
plan: 05
subsystem: testing
tags: [pydantic, zod, contracts, eval-report, baseline, judge, sidecar]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-03 golden contracts (Language, Category literals) and the 01-01 CONTRACTS registry and gen-zod path"
provides:
  - "MetricValue, SliceMetrics, ItemResult and EvalReport (eval report with per-language, per-category and language/category slices)"
  - "Baseline (three-run minimum, stdev_ddof1), BaselineMetricStat, BaselineRun, NoiseConfig (k 3.0, floor 0.02), GateOffender, GateResult"
  - "JudgeConfig (temperature pinned to 0, provider openrouter), JudgeItemScore, JudgeReport"
  - "SidecarHealth, SidecarReady, SidecarInfo, SidecarError"
  - "Generated <Model>Schema Zod exports for the ten registered models (17 schemas total)"
affects: [01-06, 01-12, 01-13, 01-16, 01-18, 01-20, 01-21]

plan_head_before: 62151fa05d8f764038e00d80ea41620e4a398ca0
plan_head_after: a1b339445af4465c0e46876cab35e9113f3b79d9

actuals:
  tokens: 14000
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Every contract is frozen with extra=forbid; Literals are explicit; no recursive references"
    - "Constraints that must survive into Zod use JSON-Schema-expressible Field bounds (temperature ge=0 le=0 becomes .gte(0).lte(0))"
    - "TDD RED uses a shape-only skeleton so tests fail on assertions instead of import errors"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/report.py
    - rag-sidecar/src/rag_sidecar/contracts/baseline.py
    - rag-sidecar/src/rag_sidecar/contracts/judge.py
    - rag-sidecar/src/rag_sidecar/contracts/sidecar.py
    - rag-sidecar/tests/test_contract_models.py
    - rag-sidecar/schemas/EvalReport.schema.json
    - rag-sidecar/schemas/Baseline.schema.json
    - rag-sidecar/schemas/NoiseConfig.schema.json
    - rag-sidecar/schemas/GateResult.schema.json
    - rag-sidecar/schemas/JudgeConfig.schema.json
    - rag-sidecar/schemas/JudgeReport.schema.json
    - rag-sidecar/schemas/SidecarHealth.schema.json
    - rag-sidecar/schemas/SidecarReady.schema.json
    - rag-sidecar/schemas/SidecarInfo.schema.json
    - rag-sidecar/schemas/SidecarError.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - src/lib/rag-eval/contracts.generated.ts

key-decisions:
  - "NoiseConfig.metrics defaults to the five report metrics with false_refusal_rate lower-is-better, so NoiseConfig() validates as the plan's behavior requires"
  - "ItemResult and JudgeItemScore reuse the golden Language and Category literals rather than free strings"
  - "JudgeConfig.temperature is a required field bounded ge=0 le=0 so both Pydantic and the generated Zod reject non-zero values"

patterns-established:
  - "Report and judge contracts import Language and Category from golden.py to keep one vocabulary"

requirements-completed: [EVAL-02]

coverage:
  - id: D1
    description: "Eval report, baseline, noise config, gate result, judge config and report, and the four sidecar shapes are frozen strict Pydantic models, each generated into a Zod schema"
    requirement: EVAL-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_contract_models.py (54 cases incl. registry check for all ten models)"
        status: pass
      - kind: integration
        ref: "Task 2 verify: npm run gen:schemas then grep of all ten 'export const <Model>Schema' lines; 17 schema files"
        status: pass
    human_judgment: false
  - id: D2
    description: "NoiseConfig defaults k 3.0, floor 0.02, gated prefixes ['overall','language:']; Baseline rejects fewer than three runs and any spread_kind other than stdev_ddof1; JudgeConfig rejects temperature other than 0"
    requirement: EVAL-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_contract_models.py::TestNoiseConfig, TestBaseline, TestJudgeConfig"
        status: pass
      - kind: integration
        ref: "tsx check: generated JudgeConfigSchema rejects temperature 0.2 and accepts 0; BaselineSchema rejects an empty runs list"
        status: pass
    human_judgment: false
  - id: D3
    description: "MetricValue represents an empty slice as value None with n 0, and rejects negative n"
    requirement: EVAL-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_contract_models.py::TestMetricValue"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every new model forbids extra keys and is frozen, so a hand-edited file with a smuggled field fails validation (T-01-37)"
    requirement: EVAL-02
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_contract_models.py (unknown-key and frozen cases per model family)"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 05: Report, Baseline, Judge and Sidecar Contracts Summary

**Seventeen frozen, strict Pydantic models for the eval report, three-run baseline, noise band, gate result, pinned-temperature judge and sidecar probes, generated into Zod before any consumer exists**

## Performance

- **Duration:** 5 min
- **Tasks:** 2
- **Files modified:** 18 (15 created, 3 modified)

## Accomplishments
- `report.py`: `MetricValue` (value or None with n >= 0), `SliceMetrics` (five metrics), `ItemResult`, and `EvalReport` with overall, by-language, by-category and `<language>/<category>` slices.
- `baseline.py`: `Baseline` requires at least three runs and `spread_kind == 'stdev_ddof1'`; `NoiseConfig` defaults to k 3.0, floor 0.02, gated prefixes `['overall', 'language:']`; `GateOffender` and `GateResult` carry the gate output.
- `judge.py` and `sidecar.py`: `JudgeConfig` with temperature bounded to 0 and provider `openrouter`, `JudgeItemScore` (score 0..1 or None with a skip reason), `JudgeReport`, and `SidecarHealth/Ready/Info/Error`.
- Ten models registered in serialization mode; `npm run gen:schemas` produced 17 schema files and 17 Zod exports. The generated `JudgeConfigSchema` rejects temperature 0.2 and `BaselineSchema` enforces `.min(3)` runs.

## Task Commits

1. **Task 1: Report and baseline contracts** (TDD)
   - RED - `b2b03e7` (test)
   - GREEN - `08a77da` (feat)
2. **Task 2: Judge and sidecar contracts, registry, Zod** (TDD)
   - RED - `0edfb31` (test)
   - GREEN - `a1b3394` (feat)

## TDD Evidence

- **Task 1 RED:** `pytest tests/test_contract_models.py` with a shape-only skeleton: 18 failed, 7 passed. All failures were "DID NOT RAISE ValidationError" or default-value assertions on the planned rules (extra keys, frozen, three runs, spread kind, noise defaults, direction literals); no import or syntax faults. **GREEN:** 25 passed.
- **Task 2 RED:** 24 failed, 30 passed, all assertion failures (temperature, provider, score range, enums, literals, frozen, registry lookups). **GREEN:** 54 passed; full sidecar suite 100 passed.
- JUnit reports for both REDs were captured under the git-ignored `.gsd/tdd-evidence/01-05/`. The classifier has no pytest adapter, so the semantic assessment above (target tests ran and failed on the planned assertions) is the durable record.
- Gate order: `test(01-05)` precedes `feat(01-05)` for both tasks.

## Files Created/Modified
- `rag-sidecar/src/rag_sidecar/contracts/{report,baseline,judge,sidecar}.py` - the four contract modules
- `rag-sidecar/src/rag_sidecar/contracts/__init__.py` - re-exports
- `rag-sidecar/src/rag_sidecar/export_schemas.py` - ten new `CONTRACTS` entries
- `rag-sidecar/schemas/*.schema.json` - ten generated files (17 total)
- `src/lib/rag-eval/contracts.generated.ts` - regenerated (17 schemas), never hand-edited
- `rag-sidecar/tests/test_contract_models.py` - 54 cases

## Decisions Made
- `NoiseConfig.metrics` has a default (the five report metrics, `false_refusal_rate` lower-is-better) because the plan requires `NoiseConfig()` with no arguments to validate. Plan 01-16 (gate) can read directions from here.
- `ItemResult.language/category` and `JudgeItemScore.language/category` use the golden `Language` and `Category` Literals, which keeps slice vocabulary identical to the golden set. A new language or category needs a golden.py change first.
- `JudgeConfig.temperature` is required (no default) and bounded `ge=0, le=0`, so the zero-temperature pin is explicit in every committed judge config and enforced identically by Zod.
- `NoiseConfig.k` and `floor` have `ge=0` bounds (small hardening beyond the plan; negative values would invert the band).
- Cross-field rules are not added: `MetricValue` does not force value None when n is 0, and `GateResult.passed` is not tied to `offenders`. Consumers (01-12, 01-16) own those semantics.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Non-negative bounds on NoiseConfig k and floor**
- **Found during:** Task 1
- **Issue:** The plan lists k and floor as bare floats; a hand-edited negative value would silently move the gate threshold the wrong way (T-01-37 concern).
- **Fix:** `Field(ge=0)` on both.
- **Files modified:** `rag-sidecar/src/rag_sidecar/contracts/baseline.py`
- **Commit:** `08a77da`

**2. [Rule 3 - Blocking] NoiseConfig.metrics needs a default**
- **Found during:** Task 1
- **Issue:** The plan's behavior says `NoiseConfig()` has the decided defaults, but `metrics` was listed without one, so a no-argument construction would fail.
- **Fix:** default factory with the five report metrics and their directions.
- **Files modified:** `rag-sidecar/src/rag_sidecar/contracts/baseline.py`
- **Commit:** `08a77da`

The shape-only skeleton in the RED commits is a TDD mechanic, not a scope change.

## Issues Encountered
None.

## Known Stubs
None.

## Threat Flags
None. The plan adds no endpoints or trust-boundary surface beyond the T-01-37 contracts it hardens.

## User Setup Required
None.

## Next Phase Readiness
- Plans 01-12, 01-13, 01-16, 01-18 and 01-20 can import these models and the Zod schemas without adding contracts of their own; 01-21 adds the samples round trip and stale-output tests.
- Zod enforces structure, enums, bounds, `.min(3)` runs and the temperature pin, but not Pydantic-only cross-field rules (none are defined in this plan).

## Self-Check: PASSED

All created files exist, the four commits (`b2b03e7`, `08a77da`, `0edfb31`, `a1b3394`) are ancestors of HEAD, `npm run gen:schemas` produced 17 schema files and all ten new `<Model>Schema` exports, and the full sidecar suite passes (100 passed).

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
