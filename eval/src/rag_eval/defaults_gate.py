"""Phase 4.1 defaults gate: pre-registered criteria G1 to G6 and G8 and the selection rules D-04 and D-06, applied as data.

The one absolute number in the criteria file is derived from the ingest baseline in force (`derive`) and checked against
it before every evaluation; the tool never edits a baseline, the noise config or the thresholds file."""

import argparse
import hashlib
import json
import math
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from rag_sidecar.contracts.baseline import Baseline, BaselineMetricStat, GateResult, NoiseConfig
from rag_sidecar.contracts.eval_run import RunManifest
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.report import EvalReport, MetricValue, SliceMetrics

from rag_eval.bounds import upper_bound
from rag_eval.gate import evaluate_gate
from rag_eval.paths import repo_relative, resolve_cli_path

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_INVALID = 2
EXIT_INTERNAL = 70

CRITERIA_STALE = "criteria_stale"
CRITERIA_CHANGED_AFTER_RUNS = "criteria_changed_after_runs"
DERIVATION_RULE = "ingest_baseline_overall_recall_at_10_mean_minus_band"
FLOAT_TOLERANCE = 1e-9

Mode = Literal["prechunked", "ingest"]
Direction = Literal["higher", "lower"]
MetricName = Literal["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]
CriterionId = Literal["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]
Status = Literal["pass", "fail", "skipped", "not_gated"]
FloorName = Literal["legacy_rule", "similarity"]
FallbackName = Literal["local_bm25", "none"]

REGISTERED_CRITERIA: tuple[CriterionId, ...] = ("G1", "G2", "G3", "G4", "G5", "G6", "G8")
CONFIG_CRITERIA: tuple[CriterionId, ...] = ("G1", "G2", "G3", "G4", "G5")


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# ---------- criteria file


class SliceMetric(_Model):
    slice: str = Field(min_length=1)
    metric: MetricName


class DirectedSliceMetric(SliceMetric):
    direction: Direction


class Derivation(_Model):
    rule: Literal["ingest_baseline_overall_recall_at_10_mean_minus_band"]
    baseline_path: str = Field(min_length=1)
    baseline_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    baseline_mean: float
    baseline_spread: float = Field(ge=0)
    noise_k: float = Field(ge=0)
    noise_floor: float = Field(ge=0)
    band: float = Field(ge=0)
    noise_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class AbsoluteFloor(_Model):
    recall_at_10_min: float
    derivation: Derivation


class AbsoluteMode(_Model):
    overall: AbsoluteFloor


class AbsoluteBlock(_Model):
    ingest: AbsoluteMode


class FloorCandidates(_Model):
    legacy_rule: list[str] = Field(min_length=1)
    similarity: list[str] = Field(min_length=1)


class FallbackCandidates(_Model):
    local_bm25: list[str] = Field(min_length=1)
    none: list[str] = Field(min_length=1)
    hosted_not_applicable: str = Field(min_length=1)


class Candidates(_Model):
    floor: FloorCandidates
    fallback: FallbackCandidates


class FloorRule(_Model):
    rule: str = Field(min_length=1)
    requires_pass_on_all_configurations: Literal[True]
    prefer: DirectedSliceMetric
    prefer_aggregate: Literal["mean_over_configurations_and_modes"]
    tie_goes_to: Literal["legacy_rule"]


class FallbackRule(_Model):
    rule: str = Field(min_length=1)
    requires_pass_on_all_configurations: Literal[True]
    prefer: Literal["local_bm25"]
    within_band_of_none: list[SliceMetric] = Field(min_length=1)
    otherwise: Literal["none"]


class SelectionRules(_Model):
    floor: FloorRule
    fallback: FallbackRule


class LatencyRule(_Model):
    profile: str = Field(min_length=1)
    total_key: str = Field(min_length=1)
    stage: str = Field(min_length=1)


class DefaultsGateCriteria(_Model):
    """The pre-registered gate (CONTEXT D-12). It names no RAG mode: refusal is judged on the single-threshold behaviour (D-26)."""

    schema_version: Literal[1] = 1
    description: str = ""
    refusal_basis: Literal["single_threshold"]
    criteria: dict[CriterionId, str]
    pass_rule: str = Field(min_length=1)
    configurations_required: list[str] = Field(min_length=1)
    candidates: Candidates
    selection_rules: SelectionRules
    modes: list[Mode] = Field(min_length=1)
    baselines: dict[Mode, str]
    noise_path: str = Field(min_length=1)
    gated_metrics: dict[MetricName, Direction]
    category_min_n: int = Field(ge=1)
    category_metrics: list[MetricName] = Field(min_length=1)
    refusal_metrics: list[DirectedSliceMetric] = Field(min_length=1)
    latency_budgets_path: str = Field(min_length=1)
    latency: LatencyRule
    legacy_run_config: str = Field(min_length=1)
    legacy_requires_all_zero: Literal[True]
    absolute: AbsoluteBlock | None = None

    @model_validator(mode="after")
    def _consistent(self) -> "DefaultsGateCriteria":
        missing = [gid for gid in REGISTERED_CRITERIA if gid not in self.criteria]
        if missing:
            raise ValueError(f"criteria lacks {', '.join(missing)}")
        if sorted(set(self.modes)) != sorted(self.modes) or set(self.modes) != {"prechunked", "ingest"}:
            raise ValueError("modes must be prechunked and ingest, once each")
        if set(self.baselines) != set(self.modes):
            raise ValueError("baselines must name one file per mode")
        floor = self.candidates.floor
        if sorted(floor.legacy_rule) != sorted(self.configurations_required):
            raise ValueError("configurations_required must be the legacy_rule floor's configurations")
        if len(floor.legacy_rule) != len(floor.similarity):
            raise ValueError("each floor needs the same number of configurations")
        fallback = self.candidates.fallback
        if len(fallback.local_bm25) != len(fallback.none):
            raise ValueError("each no-key fallback needs the same number of configurations (paired by position)")
        if not set(fallback.local_bm25) <= set(self.configurations_required):
            raise ValueError("the local_bm25 fallback configurations must be required configurations")
        names = self.configuration_names()
        if self.legacy_run_config in names:
            raise ValueError("the legacy run config may not be a candidate")
        if len(names) != len(set(names)):
            raise ValueError("a configuration appears twice in the candidate lists")
        return self

    def configuration_names(self) -> list[str]:
        ordered: list[str] = []
        floor, fallback = self.candidates.floor, self.candidates.fallback
        for name in [*self.configurations_required, *floor.similarity, *fallback.none]:
            if name not in ordered:
                ordered.append(name)
        extra = [name for name in [*floor.legacy_rule, *fallback.local_bm25] if name not in ordered]
        return [*ordered, *extra]


# ---------- result


class SourceFile(_Model):
    role: str
    path: str
    sha256: str


class CheckResult(_Model):
    name: str
    slice: str | None = None
    metric: str | None = None
    direction: Direction | None = None
    observed: float | None = None
    n: int | None = None
    bound: float | None = None
    baseline_mean: float | None = None
    band: float | None = None
    upper_95: float | None = None
    status: Status
    reason: str | None = None


class CriterionResult(_Model):
    id: CriterionId
    status: Literal["pass", "fail", "skipped"]
    checks: list[CheckResult]
    notes: list[str] = Field(default_factory=list)


class ConfigModeResult(_Model):
    config: str
    mode: Mode
    report_path: str
    report_sha256: str
    run_id: str
    run_config_hash: str
    created_at: str
    passed: bool
    criteria: list[CriterionResult]


class ConfigResult(_Model):
    name: str
    role: Literal["required", "candidate", "legacy"]
    passed: bool
    modes: list[ConfigModeResult]


class G8Matrix(_Model):
    single_tenant: bool
    multi_tenant: bool


class G8Negatives(_Model):
    drop_top_candidate_fails: bool
    max_results_1_fails: bool


class G8Input(_Model):
    two_tenant_matrix: G8Matrix
    negative_checks: G8Negatives
    notes: list[str] = Field(default_factory=list)


class G8Result(_Model):
    status: Literal["pass", "fail", "skipped"]
    two_tenant_matrix: G8Matrix | None = None
    negative_checks: G8Negatives | None = None
    notes: list[str] = Field(default_factory=list)


class CandidateOutcome(_Model):
    name: str
    configurations: list[str]
    passed: bool
    score: float | None = None
    comparisons: list[CheckResult] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)


class FloorSelection(_Model):
    chosen: FloorName | None
    candidates: list[CandidateOutcome]
    reason: str


class FallbackSelection(_Model):
    chosen: FallbackName | None
    candidates: list[CandidateOutcome]
    reason: str


class Selections(_Model):
    floor: FloorName | None
    no_key_fallback: FallbackName | None


class SelectionDetails(_Model):
    floor: FloorSelection
    no_key_fallback: FallbackSelection


class DefaultsGateResult(_Model):
    """No field names a RAG mode; refusal_basis is copied from the criteria (D-26). `live` is filled by plan 04.1-07 (G7)."""

    schema_version: Literal[1] = 1
    refusal_basis: Literal["single_threshold"]
    criteria_path: str
    criteria_sha256: str
    criteria_changed_at: str
    absolute_ingest_recall_at_10_min: float
    noise: dict[str, float]
    sources: list[SourceFile]
    configurations: list[ConfigResult]
    g8: G8Result
    selections: Selections
    selection_details: SelectionDetails
    passed: bool
    failures: list[str]
    live: dict[str, Any] | None = None


# ---------- helpers


class CriteriaStaleError(Exception):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def band_for(stat: BaselineMetricStat, noise: NoiseConfig) -> float:
    """The noise band of rag_eval.gate: max(k * spread, floor)."""
    return max(noise.k * stat.spread, noise.floor)


def _report_slices(report: EvalReport) -> dict[str, SliceMetrics]:
    slices: dict[str, SliceMetrics] = {"overall": report.overall}
    for language, metrics in report.by_language.items():
        slices[f"language:{language}"] = metrics
    for category, metrics in report.by_category.items():
        slices[f"category:{category}"] = metrics
    for pair, metrics in report.by_language_pair.items():
        slices[f"pair:{pair}"] = metrics
    return slices


def _metric(report: EvalReport, slice_name: str, metric: str) -> MetricValue | None:
    found = _report_slices(report).get(slice_name)
    return getattr(found, metric) if found is not None else None


def _stat(baseline: Baseline, slice_name: str, metric: str) -> BaselineMetricStat | None:
    stat = baseline.slices.get(slice_name, {}).get(metric)
    return stat if stat is not None and stat.mean is not None else None


def _criterion(gid: CriterionId, checks: list[CheckResult], notes: list[str] | None = None) -> CriterionResult:
    statuses = {check.status for check in checks}
    if "fail" in statuses:
        status: Literal["pass", "fail", "skipped"] = "fail"
    elif "skipped" in statuses or not any(check.status == "pass" for check in checks):
        status = "skipped"
    else:
        status = "pass"
    return CriterionResult(id=gid, status=status, checks=checks, notes=notes or [])


def _banded_check(
    name: str, report: EvalReport, baseline: Baseline, noise: NoiseConfig, slice_name: str, metric: str, direction: Direction
) -> CheckResult:
    observed = _metric(report, slice_name, metric)
    stat = _stat(baseline, slice_name, metric)
    base = {"name": name, "slice": slice_name, "metric": metric, "direction": direction}
    if observed is None or observed.value is None or stat is None:
        return CheckResult(**base, n=observed.n if observed else None, status="skipped", reason="no_value_to_compare")
    band = band_for(stat, noise)
    bound = stat.mean - band if direction == "higher" else stat.mean + band
    ok = observed.value >= bound if direction == "higher" else observed.value <= bound
    return CheckResult(
        **base,
        observed=observed.value,
        n=observed.n,
        bound=bound,
        baseline_mean=stat.mean,
        band=band,
        status="pass" if ok else "fail",
    )


def _false_refusal_upper(value: MetricValue | None) -> float | None:
    if value is None or value.value is None or value.n == 0:
        return None
    return upper_bound(round(value.value * value.n), value.n)


# ---------- derive and check


def derive_absolute_floor(
    criteria_raw: dict[str, Any], ingest_baseline: Path, noise_path: Path, *, baseline_label: str | None = None
) -> dict[str, Any]:
    """Return the criteria dict with only its `absolute` block (re)written from the ingest baseline and noise files."""
    baseline = Baseline.model_validate_json(Path(ingest_baseline).read_text(encoding="utf-8"))
    noise = NoiseConfig.model_validate_json(Path(noise_path).read_text(encoding="utf-8"))
    stat = _stat(baseline, "overall", "recall_at_10")
    if stat is None:
        raise ValueError("the ingest baseline has no overall recall_at_10 mean")
    band = band_for(stat, noise)
    absolute = {
        "ingest": {
            "overall": {
                "recall_at_10_min": stat.mean - band,
                "derivation": {
                    "rule": DERIVATION_RULE,
                    "baseline_path": baseline_label or repo_relative(ingest_baseline),
                    "baseline_sha256": sha256_file(ingest_baseline),
                    "baseline_mean": stat.mean,
                    "baseline_spread": stat.spread,
                    "noise_k": noise.k,
                    "noise_floor": noise.floor,
                    "band": band,
                    "noise_sha256": sha256_file(noise_path),
                },
            }
        }
    }
    updated = dict(criteria_raw)
    updated["absolute"] = absolute
    DefaultsGateCriteria.model_validate(updated)
    return updated


def criteria_problems(criteria: DefaultsGateCriteria, ingest_baseline: Path, noise_path: Path) -> list[str]:
    """Empty when the recorded derivation matches the files given; otherwise the reasons the criteria are stale."""
    if criteria.absolute is None:
        return ["absolute.ingest.overall is missing: run the derive command"]
    floor = criteria.absolute.ingest.overall
    derivation = floor.derivation
    problems: list[str] = []
    baseline_sha = sha256_file(ingest_baseline)
    if derivation.baseline_sha256 != baseline_sha:
        problems.append(
            f"recorded ingest baseline sha256 {derivation.baseline_sha256} is not {baseline_sha} ({repo_relative(ingest_baseline)})"
        )
    noise_sha = sha256_file(noise_path)
    if derivation.noise_sha256 != noise_sha:
        problems.append(f"recorded noise sha256 {derivation.noise_sha256} is not {noise_sha} ({repo_relative(noise_path)})")
    expected_band = max(derivation.noise_k * derivation.baseline_spread, derivation.noise_floor)
    if not math.isclose(derivation.band, expected_band, abs_tol=FLOAT_TOLERANCE):
        problems.append(f"recorded band {derivation.band} is not max(k * spread, floor) = {expected_band}")
    if not math.isclose(floor.recall_at_10_min, derivation.baseline_mean - derivation.band, abs_tol=FLOAT_TOLERANCE):
        problems.append(
            f"recall_at_10_min {floor.recall_at_10_min} is not the recorded mean minus the recorded band "
            f"({derivation.baseline_mean} - {derivation.band})"
        )
    if not problems:
        baseline = Baseline.model_validate_json(Path(ingest_baseline).read_text(encoding="utf-8"))
        noise = NoiseConfig.model_validate_json(Path(noise_path).read_text(encoding="utf-8"))
        stat = _stat(baseline, "overall", "recall_at_10")
        if stat is None or not math.isclose(stat.mean, derivation.baseline_mean, abs_tol=FLOAT_TOLERANCE):
            problems.append("recorded baseline_mean is not the ingest baseline's overall recall_at_10 mean")
        elif not math.isclose(band_for(stat, noise), derivation.band, abs_tol=FLOAT_TOLERANCE):
            problems.append("recorded band is not the band of the files given")
    return problems


# ---------- per-configuration criteria


def _aligned_baseline(report: EvalReport, baseline: Baseline) -> Baseline:
    """Retrieval overrides (the fake rerank model of the hosted path) are a run-config setting, not different data."""
    options = baseline.request_options.model_copy(update={"retrieval_overrides": report.request_options.retrieval_overrides})
    return baseline.model_copy(update={"request_options": options})


def _g1(gate: GateResult) -> CriterionResult:
    if gate.mismatches:
        return _criterion("G1", [CheckResult(name="noise_gate", status="fail", reason="; ".join(gate.mismatches))])
    checks = [
        CheckResult(
            name="noise_gate",
            slice=offender.slice,
            metric=offender.metric,
            direction=offender.direction,
            observed=offender.observed,
            bound=offender.threshold,
            baseline_mean=offender.baseline_mean,
            status="fail",
            reason=offender.reason or offender.kind,
        )
        for offender in gate.offenders
    ]
    if not checks:
        checks.append(CheckResult(name="noise_gate", status="pass", reason=f"no offender; {len(gate.skipped)} skipped"))
    return _criterion("G1", checks, [f"skipped {entry}" for entry in gate.skipped])


def _g2(report: EvalReport, baseline: Baseline, noise: NoiseConfig, mode: Mode, criteria: DefaultsGateCriteria) -> CriterionResult:
    checks = [_banded_check("recall_at_10_vs_baseline", report, baseline, noise, "overall", "recall_at_10", "higher")]
    if mode == "ingest":
        assert criteria.absolute is not None
        floor = criteria.absolute.ingest.overall.recall_at_10_min
        observed = report.overall.recall_at_10
        ok = observed.value is not None and observed.value >= floor
        checks.append(
            CheckResult(
                name="recall_at_10_absolute_floor",
                slice="overall",
                metric="recall_at_10",
                direction="higher",
                observed=observed.value,
                n=observed.n,
                bound=floor,
                baseline_mean=criteria.absolute.ingest.overall.derivation.baseline_mean,
                band=criteria.absolute.ingest.overall.derivation.band,
                status=("pass" if ok else "fail") if observed.value is not None else "skipped",
            )
        )
    return _criterion("G2", checks)


def _g3(report: EvalReport, baseline: Baseline, noise: NoiseConfig, criteria: DefaultsGateCriteria) -> CriterionResult:
    checks: list[CheckResult] = []
    for rule in criteria.refusal_metrics:
        check = _banded_check("refusal", report, baseline, noise, rule.slice, rule.metric, rule.direction)
        if rule.metric == "false_refusal_rate":
            check = check.model_copy(update={"upper_95": _false_refusal_upper(_metric(report, rule.slice, rule.metric))})
        checks.append(check)
    return _criterion("G3", checks, [f"refusal_basis {criteria.refusal_basis}"])


def _g4(report: EvalReport, baseline: Baseline, noise: NoiseConfig, criteria: DefaultsGateCriteria) -> CriterionResult:
    checks: list[CheckResult] = []
    for slice_name in sorted(_report_slices(report)):
        if not slice_name.startswith("category:"):
            continue
        for metric in criteria.category_metrics:
            check = _banded_check("category", report, baseline, noise, slice_name, metric, "higher")
            if check.status == "skipped" and _stat(baseline, slice_name, metric) is None:
                check = check.model_copy(update={"status": "not_gated", "reason": "no_baseline_slice"})
            elif check.n is not None and check.n < criteria.category_min_n:
                check = check.model_copy(update={"status": "not_gated", "reason": f"n_below_{criteria.category_min_n}"})
            checks.append(check)
    if not any(check.status != "not_gated" for check in checks):
        checks.append(CheckResult(name="category", status="pass", reason=f"no category with n >= {criteria.category_min_n}"))
    return _criterion("G4", checks)


def _g5(report: EvalReport, budgets: LatencyBudgets, criteria: DefaultsGateCriteria) -> CriterionResult:
    rule = criteria.latency
    profile = budgets.profiles.get(rule.profile)  # type: ignore[call-overload]
    if profile is None:
        return _criterion("G5", [CheckResult(name="latency", status="skipped", reason=f"no {rule.profile} budget")])
    latency = report.latency or {}
    checks: list[CheckResult] = []
    for name, key, budget in (
        ("total_p95", rule.total_key, profile.total_p95_ms),
        (f"{rule.stage}_p95", rule.stage, profile.stages.get(rule.stage)),
    ):
        stat = latency.get(key)
        if stat is None or budget is None:
            checks.append(CheckResult(name=name, slice=key, status="skipped", bound=budget, reason="no_latency_data"))
            continue
        checks.append(
            CheckResult(
                name=name,
                slice=key,
                direction="lower",
                observed=stat.p95_ms,
                n=stat.n,
                bound=budget,
                status="pass" if stat.p95_ms <= budget else "fail",
            )
        )
    return _criterion("G5", checks, [f"profile {rule.profile} budgets"])


def _g6(gate: GateResult) -> CriterionResult:
    if gate.mismatches:
        return _criterion("G6", [CheckResult(name="paired_all_zero", status="fail", reason="; ".join(gate.mismatches))])
    if gate.paired is None:
        return _criterion("G6", [CheckResult(name="paired_all_zero", status="skipped", reason="no_paired_rows")])
    checks = [
        CheckResult(name="paired_all_zero", slice=slice_name, metric=metric, n=stat.n, observed=stat.mean_d, status="fail")
        for slice_name, stats in sorted(gate.paired.slices.items())
        for metric, stat in stats.items()
        if stat.n_nonzero
    ]
    if not checks and not gate.paired.all_zero:
        checks.append(CheckResult(name="paired_all_zero", status="fail", reason="paired.all_zero is false"))
    if not checks:
        checks.append(CheckResult(name="paired_all_zero", status="pass"))
    return _criterion("G6", checks)


class RunInput(_Model):
    config: str
    mode: Mode
    report: EvalReport
    manifest: RunManifest
    report_path: str
    report_sha256: str


def evaluate_config_mode(
    run: RunInput,
    baseline: Baseline,
    noise: NoiseConfig,
    budgets: LatencyBudgets,
    criteria: DefaultsGateCriteria,
    *,
    legacy: bool = False,
) -> ConfigModeResult:
    if legacy:
        results = [_g6(evaluate_gate(run.report, baseline, noise))]
    else:
        gate = evaluate_gate(run.report, _aligned_baseline(run.report, baseline), noise)
        results = [
            _g1(gate),
            _g2(run.report, baseline, noise, run.mode, criteria),
            _g3(run.report, baseline, noise, criteria),
            _g4(run.report, baseline, noise, criteria),
            _g5(run.report, budgets, criteria),
        ]
    return ConfigModeResult(
        config=run.config,
        mode=run.mode,
        report_path=run.report_path,
        report_sha256=run.report_sha256,
        run_id=run.report.run_id,
        run_config_hash=run.report.run_config_hash,
        created_at=run.manifest.created_at,
        passed=all(result.status == "pass" for result in results),
        criteria=results,
    )


# ---------- selections


def _by_name(results: list[ConfigResult]) -> dict[str, ConfigResult]:
    return {result.name: result for result in results}


def _overall_value(mode_result: ConfigModeResult, runs: dict[tuple[str, str], RunInput], metric: str) -> float | None:
    run = runs.get((mode_result.config, mode_result.mode))
    if run is None:
        return None
    return getattr(run.report.overall, metric).value


def choose_floor(
    criteria: DefaultsGateCriteria, results: list[ConfigResult], runs: dict[tuple[str, str], RunInput]
) -> FloorSelection:
    """D-04: a floor passes only if all its configurations pass in every mode; both pass: the higher mean overall correct
    refusal over its configurations and modes wins, a tie goes to legacy_rule; neither passes: None."""
    rule = criteria.selection_rules.floor
    found = _by_name(results)
    outcomes: list[CandidateOutcome] = []
    for name in ("legacy_rule", "similarity"):
        configs: list[str] = getattr(criteria.candidates.floor, name)
        reasons = [f"{config} has no result" for config in configs if config not in found]
        reasons += [f"{config} failed" for config in configs if config in found and not found[config].passed]
        values = [
            _overall_value(mode_result, runs, rule.prefer.metric)
            for config in configs
            if config in found
            for mode_result in found[config].modes
        ]
        present = [value for value in values if value is not None]
        score = math.fsum(present) / len(present) if present and len(present) == len(values) else None
        outcomes.append(CandidateOutcome(name=name, configurations=configs, passed=not reasons, score=score, reasons=reasons))
    legacy_rule, similarity = outcomes
    if legacy_rule.passed and similarity.passed:
        if similarity.score is not None and legacy_rule.score is not None and similarity.score > legacy_rule.score + FLOAT_TOLERANCE:
            return FloorSelection(chosen="similarity", candidates=outcomes, reason="both pass; similarity has the higher correct refusal")
        return FloorSelection(
            chosen=rule.tie_goes_to, candidates=outcomes, reason="both pass; legacy_rule has the higher or tied correct refusal"
        )
    if legacy_rule.passed:
        return FloorSelection(chosen="legacy_rule", candidates=outcomes, reason="only legacy_rule passes")
    if similarity.passed:
        return FloorSelection(chosen="similarity", candidates=outcomes, reason="only similarity passes")
    return FloorSelection(chosen=None, candidates=outcomes, reason="neither floor passes: no flip (D-13)")


def choose_no_key_fallback(
    criteria: DefaultsGateCriteria,
    results: list[ConfigResult],
    runs: dict[tuple[str, str], RunInput],
    baselines: dict[str, Baseline],
    noise: NoiseConfig,
) -> FallbackSelection:
    """D-06: local_bm25 only if its keyless configurations pass and, in every mode and configuration pair, each registered
    metric is at or above the none run's value minus the band; otherwise none if it passes; otherwise None."""
    rule = criteria.selection_rules.fallback
    fallback = criteria.candidates.fallback
    found = _by_name(results)

    def passes(configs: list[str]) -> list[str]:
        return [f"{config} has no result" for config in configs if config not in found] + [
            f"{config} failed" for config in configs if config in found and not found[config].passed
        ]

    bm25_reasons = passes(fallback.local_bm25)
    comparisons: list[CheckResult] = []
    for bm25_config, none_config in zip(fallback.local_bm25, fallback.none):
        for mode in criteria.modes:
            bm25_run, none_run = runs.get((bm25_config, mode)), runs.get((none_config, mode))
            for target in rule.within_band_of_none:
                name = f"{bm25_config} vs {none_config} ({mode})"
                observed = _metric(bm25_run.report, target.slice, target.metric) if bm25_run else None
                reference = _metric(none_run.report, target.slice, target.metric) if none_run else None
                stat = _stat(baselines[mode], target.slice, target.metric)
                if observed is None or observed.value is None or reference is None or reference.value is None or stat is None:
                    comparisons.append(
                        CheckResult(name=name, slice=target.slice, metric=target.metric, status="skipped", reason="no_value_to_compare")
                    )
                    continue
                band = band_for(stat, noise)
                bound = reference.value - band
                comparisons.append(
                    CheckResult(
                        name=name,
                        slice=target.slice,
                        metric=target.metric,
                        direction="higher",
                        observed=observed.value,
                        n=observed.n,
                        bound=bound,
                        baseline_mean=reference.value,
                        band=band,
                        status="pass" if observed.value >= bound else "fail",
                    )
                )
    bm25_reasons += [
        f"{check.name} {check.slice} {check.metric} {check.status}" for check in comparisons if check.status != "pass"
    ]
    none_reasons = passes(fallback.none)
    outcomes = [
        CandidateOutcome(
            name="local_bm25", configurations=fallback.local_bm25, passed=not bm25_reasons, comparisons=comparisons, reasons=bm25_reasons
        ),
        CandidateOutcome(name="none", configurations=fallback.none, passed=not none_reasons, reasons=none_reasons),
    ]
    if not bm25_reasons:
        return FallbackSelection(chosen="local_bm25", candidates=outcomes, reason="local_bm25 passes and is within the band of none")
    if not none_reasons:
        return FallbackSelection(chosen=rule.otherwise, candidates=outcomes, reason="local_bm25 does not qualify; none passes")
    return FallbackSelection(chosen=None, candidates=outcomes, reason="neither fallback passes: no flip (D-13)")


# ---------- inputs and evaluation


class InputError(Exception):
    pass


def load_runs(reports_dir: Path, names: list[str], modes: list[Mode]) -> dict[tuple[str, str], RunInput]:
    """One directory per configuration and mode, `<reports>/<config>-<mode>/` with report.json and run.json."""
    runs: dict[tuple[str, str], RunInput] = {}
    for name in names:
        for mode in modes:
            directory = reports_dir / f"{name}-{mode}"
            report_path, run_path = directory / "report.json", directory / "run.json"
            if not report_path.is_file() or not run_path.is_file():
                raise InputError(f"missing report.json or run.json in {repo_relative(directory)}")
            report = EvalReport.model_validate_json(report_path.read_text(encoding="utf-8"))
            manifest = RunManifest.model_validate_json(run_path.read_text(encoding="utf-8"))
            if manifest.run_id != report.run_id or manifest.run_config_hash != report.run_config_hash:
                raise InputError(f"{repo_relative(directory)}: run.json and report.json describe different runs")
            recorded = manifest.run_config.name if manifest.run_config else None
            if recorded != name:
                raise InputError(f"{repo_relative(directory)}: run config {recorded!r} is not {name!r}")
            runs[(name, mode)] = RunInput(
                config=name,
                mode=mode,
                report=report,
                manifest=manifest,
                report_path=repo_relative(report_path),
                report_sha256=sha256_file(report_path),
            )
    return runs


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def evaluate_defaults_gate(
    criteria: DefaultsGateCriteria,
    *,
    criteria_sha256: str,
    criteria_path: str,
    criteria_changed_at: datetime,
    runs: dict[tuple[str, str], RunInput],
    baselines: dict[str, Baseline],
    noise: NoiseConfig,
    budgets: LatencyBudgets,
    sources: list[SourceFile],
    g8: G8Input | None,
) -> DefaultsGateResult:
    if criteria.absolute is None:
        raise CriteriaStaleError(["absolute.ingest.overall is missing: run the derive command"])
    late = sorted(
        f"{run.config}-{run.mode} created {run.manifest.created_at}"
        for run in runs.values()
        if _parse_time(run.manifest.created_at) < criteria_changed_at
    )
    if late:
        raise CriteriaStaleError([f"{CRITERIA_CHANGED_AFTER_RUNS}: the criteria changed at {criteria_changed_at.isoformat()}, after {', '.join(late)}"])

    required = set(criteria.configurations_required)
    configurations: list[ConfigResult] = []
    for name in criteria.configuration_names():
        modes = [evaluate_config_mode(runs[(name, mode)], baselines[mode], noise, budgets, criteria) for mode in criteria.modes]
        configurations.append(
            ConfigResult(name=name, role="required" if name in required else "candidate", passed=all(m.passed for m in modes), modes=modes)
        )
    legacy_modes = [
        evaluate_config_mode(runs[(criteria.legacy_run_config, mode)], baselines[mode], noise, budgets, criteria, legacy=True)
        for mode in criteria.modes
    ]
    legacy = ConfigResult(name=criteria.legacy_run_config, role="legacy", passed=all(m.passed for m in legacy_modes), modes=legacy_modes)

    if g8 is None:
        g8_result = G8Result(status="skipped", notes=["no G8 input given (--g8)"])
    else:
        ok = all(g8.two_tenant_matrix.model_dump().values()) and all(g8.negative_checks.model_dump().values())
        g8_result = G8Result(
            status="pass" if ok else "fail",
            two_tenant_matrix=g8.two_tenant_matrix,
            negative_checks=g8.negative_checks,
            notes=list(g8.notes),
        )

    floor = choose_floor(criteria, configurations, runs)
    fallback = choose_no_key_fallback(criteria, configurations, runs, baselines, noise)
    failures: list[str] = []
    found = _by_name(configurations)
    chosen_floor_configs: list[str] = getattr(criteria.candidates.floor, floor.chosen) if floor.chosen else criteria.configurations_required
    for name in chosen_floor_configs:
        if not found[name].passed:
            failures.append(f"{name} failed")
    if floor.chosen is None:
        failures.append(f"floor: {floor.reason}")
    if fallback.chosen is None:
        failures.append(f"no-key fallback: {fallback.reason}")
    if not legacy.passed:
        failures.append(f"{legacy.name} (G6) failed")
    if g8_result.status != "pass":
        failures.append(f"G8 {g8_result.status}")

    return DefaultsGateResult(
        refusal_basis=criteria.refusal_basis,
        criteria_path=criteria_path,
        criteria_sha256=criteria_sha256,
        criteria_changed_at=criteria_changed_at.isoformat(),
        absolute_ingest_recall_at_10_min=criteria.absolute.ingest.overall.recall_at_10_min,
        noise={"k": noise.k, "floor": noise.floor},
        sources=sources,
        configurations=[*configurations, legacy],
        g8=g8_result,
        selections=Selections(floor=floor.chosen, no_key_fallback=fallback.chosen),
        selection_details=SelectionDetails(floor=floor, no_key_fallback=fallback),
        passed=not failures,
        failures=failures,
    )


# ---------- Markdown


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def render_markdown(result: DefaultsGateResult) -> str:
    lines = ["# Phase 4.1 defaults gate", ""]
    lines.append(f"Result: {'PASS' if result.passed else 'FAIL'}")
    lines.append(f"Refusal basis: {result.refusal_basis}")
    lines.append(f"Floor: {result.selections.floor or 'none chosen'}; no-key fallback: {result.selections.no_key_fallback or 'none chosen'}")
    lines.append(f"Noise band: max({result.noise['k']} x spread, {result.noise['floor']})")
    lines.append(f"G2 absolute ingest Recall@10 floor (derived): {result.absolute_ingest_recall_at_10_min:.6f}")
    lines.append("")
    if result.failures:
        lines += ["## Failures", "", *[f"- {failure}" for failure in result.failures], ""]
    lines += ["## Sources", "", "| Role | Path | sha256 |", "| --- | --- | --- |"]
    lines += [f"| {source.role} | {source.path} | {source.sha256} |" for source in result.sources]
    lines.append(f"| criteria | {result.criteria_path} | {result.criteria_sha256} |")
    lines.append("")
    for config in result.configurations:
        lines.append(f"## {config.name} ({config.role}): {'pass' if config.passed else 'fail'}")
        lines.append("")
        for mode in config.modes:
            lines.append(f"### {mode.mode}: run {mode.run_id}, run_config_hash {mode.run_config_hash}, report sha256 {mode.report_sha256}")
            lines.append("")
            lines.append("| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |")
            lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
            for criterion in mode.criteria:
                for check in criterion.checks:
                    lines.append(
                        f"| {criterion.id} ({criterion.status}) | {check.name} | {check.slice or ''} | {check.metric or ''} | "
                        f"{_fmt(check.observed)} | {'' if check.n is None else check.n} | {_fmt(check.bound)} | "
                        f"{_fmt(check.baseline_mean)} | {_fmt(check.band)} | {_fmt(check.upper_95)} | "
                        f"{check.status}{' (' + check.reason + ')' if check.reason else ''} |"
                    )
            lines.append("")
    lines += ["## G8", "", f"Status: {result.g8.status}"]
    if result.g8.two_tenant_matrix:
        lines.append(f"- two-tenant matrix: single-tenant {result.g8.two_tenant_matrix.single_tenant}, multi-tenant {result.g8.two_tenant_matrix.multi_tenant}")
    if result.g8.negative_checks:
        lines.append(
            f"- negative checks fail as designed: drop_top_candidate {result.g8.negative_checks.drop_top_candidate_fails}, "
            f"max_results 1 {result.g8.negative_checks.max_results_1_fails}"
        )
    lines += [*[f"- {note}" for note in result.g8.notes], ""]
    for title, selection in (("Floor (D-04)", result.selection_details.floor), ("No-key fallback (D-06)", result.selection_details.no_key_fallback)):
        lines += [f"## {title}", "", f"Chosen: {selection.chosen or 'none'} ({selection.reason})", ""]
        for candidate in selection.candidates:
            lines.append(
                f"- {candidate.name}: {'pass' if candidate.passed else 'fail'}, score {_fmt(candidate.score)}, "
                f"configurations {', '.join(candidate.configurations)}"
            )
            lines += [f"  - {reason}" for reason in candidate.reasons]
            lines += [
                f"  - {check.name} {check.slice} {check.metric}: {_fmt(check.observed)} vs {_fmt(check.bound)} "
                f"(none {_fmt(check.baseline_mean)} - band {_fmt(check.band)}) {check.status}"
                for check in candidate.comparisons
            ]
        lines.append("")
    lines += ["## G7", "", "Live, report-only: filled from plan 04.1-08's result by plan 04.1-07.", ""]
    return "\n".join(lines)


# ---------- CLI


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def dump_criteria(raw: dict[str, Any]) -> str:
    return json.dumps(raw, indent=2, ensure_ascii=False) + "\n"


def git_changed_at(path: Path) -> datetime:
    """The last commit time of a clean tracked file; the file's modification time when it is untracked or modified."""
    try:
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--", str(path)], capture_output=True, text=True, check=True, cwd=path.parent
        ).stdout.strip()
        stamp = subprocess.run(
            ["git", "log", "-1", "--format=%cI", "--", str(path)], capture_output=True, text=True, check=True, cwd=path.parent
        ).stdout.strip()
        if not dirty and stamp:
            return _parse_time(stamp)
    except (OSError, subprocess.CalledProcessError):
        pass
    return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)


def _load_criteria(path: Path) -> tuple[dict[str, Any], DefaultsGateCriteria]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("the criteria file must hold a JSON object")
    return raw, DefaultsGateCriteria.model_validate(raw)


def _stale(problems: list[str]) -> int:
    print(f"{CRITERIA_STALE}:", file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    return EXIT_INVALID


def _cmd_derive(args: argparse.Namespace) -> int:
    criteria_path = resolve_cli_path(args.criteria)
    raw, _ = _load_criteria(criteria_path)
    baseline_path = resolve_cli_path(args.ingest_baseline)
    updated = derive_absolute_floor(raw, baseline_path, resolve_cli_path(args.noise))
    text = dump_criteria(updated)
    if criteria_path.read_text(encoding="utf-8") != text:
        _write_text(criteria_path, text)
    floor = updated["absolute"]["ingest"]["overall"]
    print(f"defaults_gate: recall_at_10_min {floor['recall_at_10_min']} (baseline sha256 {floor['derivation']['baseline_sha256']})")
    return EXIT_PASS


def _cmd_check(args: argparse.Namespace) -> int:
    _, criteria = _load_criteria(resolve_cli_path(args.criteria))
    problems = criteria_problems(criteria, resolve_cli_path(args.ingest_baseline), resolve_cli_path(args.noise))
    if problems:
        return _stale(problems)
    print("defaults_gate: criteria current")
    return EXIT_PASS


def _cmd_evaluate(args: argparse.Namespace) -> int:
    criteria_path = resolve_cli_path(args.criteria)
    _, criteria = _load_criteria(criteria_path)
    noise_path = resolve_cli_path(criteria.noise_path)
    baseline_paths = {mode: resolve_cli_path(path) for mode, path in criteria.baselines.items()}
    problems = criteria_problems(criteria, baseline_paths["ingest"], noise_path)
    if problems:
        return _stale(problems)
    noise = NoiseConfig.model_validate_json(noise_path.read_text(encoding="utf-8"))
    if dict(noise.metrics) != dict(criteria.gated_metrics):
        return _stale([f"gated_metrics {dict(criteria.gated_metrics)} differ from the noise config's {dict(noise.metrics)}"])
    baselines = {mode: Baseline.model_validate_json(path.read_text(encoding="utf-8")) for mode, path in baseline_paths.items()}
    budgets_path = resolve_cli_path(criteria.latency_budgets_path)
    budgets = LatencyBudgets.model_validate_json(budgets_path.read_text(encoding="utf-8"))
    names = [*criteria.configuration_names(), criteria.legacy_run_config]
    runs = load_runs(resolve_cli_path(args.reports), names, list(criteria.modes))
    sources = [
        *[SourceFile(role=f"baseline:{mode}", path=repo_relative(path), sha256=sha256_file(path)) for mode, path in baseline_paths.items()],
        SourceFile(role="noise", path=repo_relative(noise_path), sha256=sha256_file(noise_path)),
        SourceFile(role="latency_budgets", path=repo_relative(budgets_path), sha256=sha256_file(budgets_path)),
    ]
    g8: G8Input | None = None
    if args.g8 is not None:
        g8_path = resolve_cli_path(args.g8)
        g8 = G8Input.model_validate_json(g8_path.read_text(encoding="utf-8"))
        sources.append(SourceFile(role="g8", path=repo_relative(g8_path), sha256=sha256_file(g8_path)))
    sources += [
        SourceFile(role=f"report:{run.config}:{run.mode}", path=run.report_path, sha256=run.report_sha256)
        for run in runs.values()
    ]
    try:
        result = evaluate_defaults_gate(
            criteria,
            criteria_sha256=sha256_file(criteria_path),
            criteria_path=repo_relative(criteria_path),
            criteria_changed_at=git_changed_at(criteria_path),
            runs=runs,
            baselines=baselines,
            noise=noise,
            budgets=budgets,
            sources=sources,
            g8=g8,
        )
    except CriteriaStaleError as exc:
        return _stale(exc.problems)
    out_dir = resolve_cli_path(args.out)
    _write_text(out_dir / "defaults-gate.json", result.model_dump_json(indent=2) + "\n")
    _write_text(out_dir / "defaults-gate.md", render_markdown(result))
    if not result.passed:
        print("defaults_gate: FAIL", file=sys.stderr)
        for failure in result.failures:
            print(f"  {failure}", file=sys.stderr)
        return EXIT_FAIL
    print(f"defaults_gate: PASS (floor {result.selections.floor}, no-key fallback {result.selections.no_key_fallback})")
    return EXIT_PASS


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.defaults_gate", description="Phase 4.1 pre-registered defaults gate")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("derive", "check-criteria"):
        command = commands.add_parser(name)
        command.add_argument("--criteria", required=True, type=Path)
        command.add_argument("--ingest-baseline", required=True, type=Path)
        command.add_argument("--noise", required=True, type=Path)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--criteria", required=True, type=Path)
    evaluate.add_argument("--reports", required=True, type=Path)
    evaluate.add_argument("--out", required=True, type=Path)
    evaluate.add_argument("--g8", type=Path, default=None)
    args = parser.parse_args(argv)
    try:
        if args.command == "derive":
            return _cmd_derive(args)
        if args.command == "check-criteria":
            return _cmd_check(args)
        return _cmd_evaluate(args)
    except (OSError, ValidationError, ValueError, InputError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - a crash must not look like a verdict
        print(f"defaults_gate: INTERNAL ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
