---
phase: 07-external-backends-release-defaults
plan: 17
subsystem: rag-eval-contracts
tags: [pydantic, zod, contracts, release-defaults, regression, vendor-inventory, adm-02, adm-04]

requires:
  - phase: 05.1.1-feedback-loop
    provides: "ShipCheckResult (05.1.1-01), the closing registry edit 05.1.1-22"
  - phase: 04.1-retrieval-defaults
    provides: "eval/decisions/04.1-retrieval-defaults.json, the incumbent source (04.1-09)"
  - phase: 05-verified-citations-groundedness
    provides: "closing plan 05-25; 05-VERIFICATION.md status human_needed"
  - phase: 05.1-prompt-injection-defense
    provides: "closing plan 05.1-22; 05.1-VERIFICATION.md status human_needed"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "closing plan 06-45; 06-VERIFICATION.md status human_needed"
provides:
  - "rag-sidecar/src/rag_sidecar/contracts/release.py: DefaultsDecision, SwitchVerdict, BackendComparison, BackendResult, IncumbentSource, CostSummary, CostPer1000, CostAmount, CostBasis, IngestCostParts, QueryCostParts, LatencySummary, LatencyEntry, LatencyValue, LanguageQuality, RegressionPlan (canonical_json, canonical_sha256), RegressionRunConfig, TestSplitUse, VendorDataFlow, VendorEntry"
  - "Schemas DefaultsDecision, RegressionPlan, VendorDataFlow and their Zod schemas in src/lib/rag-eval/contracts.generated.ts"
affects: [07-21, 07-24, 07-25, 07-27, 07-30, 07-33, 07-40, 07-43]

actuals:
  tasks: 2
  commits: 4  # RED, GREEN, registration, SUMMARY

tech-stack:
  added: []
  patterns:
    - "Optional record blocks (ship_check_ref, cost, latency, per_language, ack_switch) are left out of the serialised JSON while None (exclude_if + omit_none_schema), so the Zod key is optional"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/release.py
    - rag-sidecar/tests/test_release_contracts.py
    - rag-sidecar/schemas/DefaultsDecision.schema.json
    - rag-sidecar/schemas/RegressionPlan.schema.json
    - rag-sidecar/schemas/VendorDataFlow.schema.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json

key-decisions:
  - "Module name contracts/release.py as the plan says (PATTERNS.md proposed defaults.py and vendor.py); next to the existing release_gate.py (Phase 5.3), no name clash"
  - "Incumbent source is a typed IncumbentSource {path: Literal 'eval/decisions/04.1-retrieval-defaults.json', sha256}; any other path or a missing sha256 fails"
  - "'Adopts a configuration' (ADM-02 language rule) means: some defaults value differs from the incumbent map, or the backend is not pgvector (DefaultsDecision.adopts_change()); every defaults key must also be in the incumbent map"
  - "cost, latency and per_language are optional on the model and required by a validator only when provisional is None (planner resolution); an empty per_language list is refused"
  - "Each cost amount is CostAmount {usd >= 0 | None, reason not_measured | not_provided}: exactly one of the two; per_1000_documents rows carry embedding_profile and backend, per_1000_queries rows carry config_name; basis holds price_table_sha256, document and query sample sizes and measured | estimated"
  - "LatencySummary holds budgets_sha256 and per (config, channel chat | voice) entries of stage values (p50, p95, budgets, within_budget, report_only); each entry must contain the stage 'total'"
  - "LanguageQuality.below_baseline may be None (too-small slice) only with a reason code, matching 07-43's too_small"
  - "SwitchVerdict: p_holm < p_value fails (also p_holm set without p_value); decision adopt | keep_incumbent; an adopted switch must have gated_slices_ok, latency_ok and injection_asr exactly 0 (D-18). Added beyond the plan's listed behaviours because the decision rule makes these necessary conditions"
  - "BackendComparison: incumbent fixed to pgvector; a non-pgvector winner needs a valid result with ci_low > 0 and delta > band (D-18 'beyond the bootstrap CI width'); the record's backend must equal the winner, and a provisional fixtures record must keep pgvector (07-24/07-25)"
  - "BackendResult.invalid_reason is set exactly when valid is false (e.g. backend_impl_fake, backend_not_ready from 07-24)"
  - "RegressionPlan adds incumbent_config (must name a listed config) and created_at; config names unique; a dev-split plan must have test_split_budget 0; alpha default 0.05 in (0,1); min_gate_n default 10, >= 1; canonical JSON = model_dump(mode=json), sorted keys, compact separators, UTF-8"
  - "TestSplitUse (one ledger line): run_id, config_name, plan_sha256, used_at, registered; an unregistered use needs a reason of 10-500 characters (Pitfall 12)"
  - "VendorEntry: hosts are bare lowercase hostnames (no scheme or path), unique within the inventory; content kinds are the seven of D-20; switch may be None for a vendor with no single enabling switch; multi_tenant requires_ack must name ack_switch (and only then); retention and training are free text with 'to_verify' accepted; providers are manifest provider ids"
  - "Export modes: DefaultsDecision and RegressionPlan 'serialization' (tool-written), VendorDataFlow 'validation' (hand-edited config file)"
  - "Samples: DefaultsDecision main sample is a complete non-provisional record (ship_check_ref and all three blocks); variant DefaultsDecision:provisional_fixtures has none of them; sample languages come from LANGUAGE_CODES, vendor samples use example.com hosts (domain neutral)"
  - "review.py untouched (Phase 5.1.1 owns the review contracts)"

patterns-established: []

requirements-completed: [ADM-02, ADM-04]

duration: ~1h
completed: 2026-11-27
---

# Phase 7 Plan 17: Closeout contracts (defaults decision, regression plan, vendor inventory)

The release, regression and vendor-inventory structures each have one Pydantic definition, with generated JSON Schema and Zod and no drift.

## Preconditions

- Every plan in depends_on, transitively (309 plans), has a SUMMARY on this branch.
- 05-VERIFICATION.md, 05.1-VERIFICATION.md and 06-VERIFICATION.md: `status: human_needed`.
- No earlier `exec/07-17` branch existed on origin; the branch was created from `base/07-17-v2` (87d31b24).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 RED | 69ccb122 | tests plus field-only models; 19 tests failed with "DID NOT RAISE ValidationError" (assertion failures, no import error) |
| 1 GREEN | 5debbf26 | validators; 40/40 pass |
| 2 | bc46563a | registry, samples, regenerated schemas, Zod and samples.json |

## Behaviour changes

None at runtime. The change is additive: new contract module, three new schema files, three new Zod schemas, new samples. No product code, switch, default or migration changed.

## Gates run

- `uv run --directory rag-sidecar pytest -q tests/test_release_contracts.py tests/test_contract_models.py`: 114 passed
- `uv run --directory rag-sidecar pytest -q` (full sidecar suite, shared registry changed): 2718 passed, 12 skipped
- `npm run gen:schemas` run twice, then `git diff --exit-code` on rag-sidecar/schemas, contracts.generated.ts and samples.json: no diff
- `npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts`: 507 passed
- `npx vitest run` on all 149 test files that import `contracts.generated` or `fixtures/contracts/samples.json`: 3072 passed, 1 skipped
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok

Not run (area not touched): rag-db tests, workflow check, eval pytest, test-rag fixture runs, frontend design check.

## Deviations

- Extra validation beyond the plan's behaviour list (adopted verdicts need every gate and ASR 0, the backend-winner rule, unique hosts, ack_switch for requires_ack, dev plans with budget 0, incumbent_config). All follow from D-18, D-20 and A-10; the downstream plans 07-21, 07-24, 07-25 and 07-43 produce data that satisfies them. If 07-21 needs a vendor with multi_tenant requires_ack, it names the ACK switch (e.g. the Vectara and Lakera multi-tenant ACK variables).
- Fields named by me where the plan left them open: `incumbent_source`, `incumbent_config`, `created_at`, `budgets_sha256`, `CostAmount`, `IngestCostParts`/`QueryCostParts`, `LatencyEntry`/`LatencyValue`, `BackendResult`.

## For STATE

- Requirements: ADM-02 (record contract incl. the revision-4 blocks), ADM-04 (inventory contract). Both complete only with 07-21, 07-24, 07-25, 07-30, 07-43 and the live 07-33.
- No migration, no new env variable, no package installed.

## Operator actions

None.

## Deferred

The inventory file (07-21), the regression runner (07-24), the fixture record (07-25), the ADM-02 annotation (07-43) and the release-defaults check (07-30).
