from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from rag_sidecar.contracts.baseline import (
    Baseline,
    GateOffender,
    GateResult,
    NoiseConfig,
    PairedStat,
)
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.latency import Profile as LatencyProfile
from rag_sidecar.contracts.report import (
    EvalReport,
    InjectionReport,
    ItemResult,
    SliceMetrics,
)
from rag_sidecar.contracts.retrieval import ChunkingDecision, ChunkingSweepReport

from rag_eval.calibrate.refusal import (
    IMAGE_FLOOR,
    CalibrationResult,
    CrossComparison,
    _best_dense,
    _gate_decided,
    fit_threshold,
)
from rag_eval.gate import evaluate_gate
from rag_eval.golden_io import load_golden
from rag_eval.harness_runner import (
    HARNESS_SCRIPT,
    TAIL_LINES,
    HarnessError,
    Spawner,
    _tail,
    default_spawner,
)
from rag_eval.metrics import CLAUSE_TAG, CROSS_LINGUAL, language_pair_key
from rag_eval.native_review import counts_in_gated_slices
from rag_eval.paired import _stat, is_gated_slice, item_metrics
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.profile_compare import baseline_from_report
from rag_eval.report import RETRIEVAL_TOTAL
from rag_eval.sweep.chunking import (
    CLAUSE_SLICE,
    GENERAL_DOC_TYPE,
    LEGACY_ID,
    _profiles_for,
    ingest_doc_types,
    parse_presets,
)
from rag_eval.traces import load_manifest, load_traces

FixtureMode = Literal["prechunked", "ingest"]

RETRIEVAL_METRICS = ("recall_at_5", "recall_at_10", "mrr")
SLICE_PREFIXES = ("overall", "language:", "category:")
CLAUSE_METRIC = "recall_at_10"
CROSS_LINGUAL_SLICE = f"category:{CROSS_LINGUAL}"
THRESHOLD_BASIS = "rerank_threshold"
RECORDED_PROFILE = "recorded"
ITERATIVE_RECALL_FLOOR = 0.9
SELECTIVE_MODES = ("off", "relaxed_order", "strict_order", "exact")
PRESET_SLUG = re.compile(r"^p(\d+)-(\d+)$")
HARNESS_DIR = "harness"
SELECTIVE_REPORT = "selective-filter.json"
JSON_NAME = "comparison.json"
MARKDOWN_NAME = "comparison.md"

CATEGORY_PREFIX = "category:"
FLOOR_REASONS = ("above_similarity_floor", "below_similarity_floor")
RATE_TOLERANCE = 1e-9
LIVE_PLAN = "04-43"
STRICT_OPEN_NOTE = (
    "the fixture shows no strict correct-refusal gain at the matched false-refusal point; whether correct refusal strictly "
    f"improves is decided by the live calibration ({LIVE_PLAN})"
)
STRICT_DONE_NOTE = "correct refusal is strictly higher at the matched false-refusal point against both references"

EXIT_PASS = 0
EXIT_USAGE = 2
EXIT_HARNESS = 3
EXIT_FAIL = 10

FIXTURE_NOTE = (
    "Fixture corpus only. Fixture gains mostly reflect the lexical fixture embedder (hashed n-grams, research F-9) and, "
    "against the legacy baseline, dropping the legacy 0.65 post-filter; live verification decides real gains."
)
DEFAULTS_NOTE = "The shipped defaults stay off (D-28): every switch compared here is off in src/lib/env.ts until the Phase 7 regression."
ALIGNED_NOTE = (
    "Slice comparisons of v2 runs align request_options with the observed run: a named run differs from its reference "
    "by design (for example rerank_model or chunking_profile_by_doc_type). Golden, corpus, embedder, tier and mode must still match."
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RunSpec(_Model):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    base: str
    fixture_mode: FixtureMode
    env: dict[str, str] = Field(default_factory=dict)
    drop_overrides: list[str] = Field(default_factory=list)
    chunking_profile: Literal["recorded"] | None = None


class SwitchPair(_Model):
    on: str
    off: str


class RecommendedRule(_Model):
    run: str
    reference: str


class IterativeScanRule(_Model):
    on: str
    off: str
    fixture_slice: str


class ComparisonRules(_Model):
    legacy_parity: list[str] = Field(min_length=1)
    recommended: RecommendedRule
    parent_child: SwitchPair
    compression: SwitchPair
    translation: SwitchPair
    iterative_scan: IterativeScanRule
    local_bm25_refusal: str


class ComparisonCommands(_Model):
    selective_filter: list[str] = Field(min_length=1)
    conformance: list[str] = Field(min_length=1)
    voice_budget: list[str] = Field(min_length=1)


class ComparisonSpec(_Model):
    schema_version: Literal[1] = 1
    noise: str
    baselines: dict[FixtureMode, str]
    calibration_result: str
    calibration_outcome: str
    chunking_decision: str
    chunking_sweep: str
    runs: list[RunSpec] = Field(min_length=1)
    rules: ComparisonRules
    commands: ComparisonCommands

    @model_validator(mode="after")
    def _references(self) -> "ComparisonSpec":
        names = [run.name for run in self.runs]
        if len(names) != len(set(names)):
            raise ValueError("run names must be unique")
        rules = self.rules
        referenced = [
            *rules.legacy_parity,
            rules.recommended.run,
            rules.recommended.reference,
            rules.parent_child.on,
            rules.parent_child.off,
            rules.compression.on,
            rules.compression.off,
            rules.translation.on,
            rules.translation.off,
            rules.iterative_scan.on,
            rules.iterative_scan.off,
            rules.local_bm25_refusal,
        ]
        missing = sorted({name for name in referenced if name not in names})
        if missing:
            raise ValueError(f"rules name unknown runs: {', '.join(missing)}")
        modes = {run.fixture_mode for run in self.runs}
        if not modes <= set(self.baselines):
            raise ValueError("every fixture mode used by a run needs a baseline")
        if "{out}" not in self.commands.selective_filter:
            raise ValueError("the selective_filter command needs an {out} placeholder")
        return self


class LegacyRunCheck(_Model):
    run: str
    all_zero: bool
    gate_passed: bool
    mismatches: list[str]
    nonzero_cells: list[str]


class LegacyParityResult(_Model):
    passed: bool
    runs: list[LegacyRunCheck]


class MatchedRefusal(_Model):
    source: str
    target_false_refusal: float
    threshold: float | None
    false_refusal: float
    correct_refusal: float
    answerable_n: int
    no_answer_n: int
    excluded_no_similarity: int
    reference_refused: int | None
    covers_reference: bool | None
    missing: list[str]


class RefusalComparison(_Model):
    method: Literal["point", "matched_false_refusal"]
    correct_refusal: float | None
    correct_refusal_n: int
    reference_correct_refusal: float | None
    false_refusal: float | None
    false_refusal_n: int
    false_refusal_upper_95: float | None
    reference_false_refusal: float | None
    matched: MatchedRefusal | None
    passed: bool
    strictly_improved: bool
    failures: list[str]


class ReportOnlyMove(_Model):
    drop: GateOffender
    n: int
    n_nonzero: int
    ci_low: float | None
    ci_high: float | None


class RecommendedCheck(_Model):
    against: str
    passed: bool
    mismatches: list[str]
    drops: list[GateOffender]
    report_only: list[ReportOnlyMove]
    refusal: RefusalComparison


class StrictImprovement(_Model):
    verdict: Literal["improved", "open"]
    note: str


class GateBelowFloor(_Model):
    item_id: str
    split: str
    cell_key: str | None
    gate_threshold: float | None
    best_dense: float
    floor: float


class RecommendedResult(_Model):
    run: str
    passed: bool
    baseline: RecommendedCheck
    reference: RecommendedCheck
    strict_improvement: StrictImprovement
    gate_below_floor: list[GateBelowFloor]


class SwitchResult(_Model):
    on: str
    off: str
    passed: bool
    failures: list[str]
    drops: list[GateOffender]
    measures: dict[str, float | None]


class SelectiveModeMetrics(_Model):
    rows: int = Field(ge=0)
    recall_at_k: float = Field(ge=0, le=1)
    k: int = Field(ge=1)


class IterativeScanResult(_Model):
    on: str
    off: str
    passed: bool
    failures: list[str]
    fixture_slice: str
    fixture: dict[str, float | None]
    fixture_equal: bool
    synthetic: dict[str, dict[str, SelectiveModeMetrics]]


class CommandResult(_Model):
    command: list[str]
    exit_code: int
    passed: bool


class CrossLingualVerdict(_Model):
    verdict: Literal["pass", "fail", "not_comparable"]
    comparable_cells: int
    exceeding: list[str]
    comparisons: list[CrossComparison]
    note: str


class LocalBm25RefusalResult(_Model):
    run: str
    passed: bool
    threshold_decisions: int
    refusal_bases: dict[str, int]
    overall: SliceMetrics


class ChunkingChoice(_Model):
    profile_id: str
    source: Literal["decision", "sweep_candidate"]
    decision_profile_id: str
    doc_type: str


class RunRecord(_Model):
    name: str
    fixture_mode: FixtureMode
    env: dict[str, str]
    overrides: dict[str, Any] | None
    chunking_profiles: list[str]
    run_config_hash: str
    overall: SliceMetrics
    lexical_leg_hit_rate_at_10: float | None
    context_tokens_mean: float | None


class PhaseComparison(_Model):
    schema_version: Literal[1] = 1
    passed: bool
    noise_floor: float
    noise_k: float
    legacy_parity: LegacyParityResult
    recommended: RecommendedResult
    parent_child: SwitchResult
    compression: SwitchResult
    translation: SwitchResult
    iterative_scan: IterativeScanResult
    conformance: CommandResult
    voice_budget: CommandResult
    xlg03: CrossLingualVerdict
    local_bm25_refusal: LocalBm25RefusalResult
    calibration_outcome: dict[str, Any]
    chunking_profile: ChunkingChoice
    runs: list[RunRecord]
    notes: list[str]


@dataclass(frozen=True)
class RunRequest:
    name: str
    run_config: dict[str, Any]
    fixture_mode: str
    out_dir: Path
    process_env: dict[str, str] = field(default_factory=dict)
    harness_flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class RunOutput:
    report: EvalReport
    traces: list[RagTrace]
    golden: list[GoldenItem]


Runner = Callable[[RunRequest], RunOutput]
CommandRunner = Callable[[list[str]], int]


class ComparisonError(RuntimeError):
    pass


# ---------- helpers over one run


def _gated_items(output: RunOutput) -> list[ItemResult]:
    split = output.report.golden_filter.gate_split
    return [item for item in output.report.items if item.split == split]


def _mean(values: list[float]) -> float | None:
    return math.fsum(values) / len(values) if values else None


def clause_recall(output: RunOutput) -> float | None:
    clause_ids = {item.id for item in output.golden if CLAUSE_TAG in item.tags}
    return _mean(
        [
            item.spans_hit_at_10 / item.span_count
            for item in _gated_items(output)
            if item.item_id in clause_ids and item.answerable and item.span_count
        ]
    )


def context_tokens_mean(output: RunOutput) -> float | None:
    ids = {item.item_id for item in _gated_items(output)}
    return _mean(
        [
            float(trace.context_tokens) if trace.context_tokens is not None else len(trace.context) / 4
            for trace in output.traces
            if trace.item_id in ids
        ]
    )


def _slice(report: EvalReport, slice_name: str) -> SliceMetrics | None:
    if slice_name == "overall":
        return report.overall
    kind, _, name = slice_name.partition(":")
    groups = {"language": report.by_language, "category": report.by_category, "pair": report.by_language_pair}
    return groups.get(kind, {}).get(name)


def _metric(report: EvalReport, slice_name: str, metric: str) -> float | None:
    metrics = _slice(report, slice_name)
    return getattr(metrics, metric).value if metrics is not None else None


def _lexical_rate(report: EvalReport) -> float | None:
    return report.lexical_leg_hit_rate_at_10.value if report.lexical_leg_hit_rate_at_10 is not None else None


def _cross_lingual_lexical_rate(output: RunOutput) -> float | None:
    return _mean(
        [
            1.0 if item.lexical_hit_at_10 else 0.0
            for item in _gated_items(output)
            if item.category == CROSS_LINGUAL and item.lexical_hit_at_10 is not None
        ]
    )


def _delta(on: float | None, off: float | None) -> float | None:
    return None if on is None or off is None else on - off


# ---------- slice comparisons (gate.py and paired.py do the arithmetic)


def _slice_noise(noise: NoiseConfig) -> NoiseConfig:
    """Overall, every language and every category slice, on Recall@5, Recall@10 and MRR; the CI gate checks fewer slices."""
    return noise.model_copy(
        update={
            "gated_slice_prefixes": list(SLICE_PREFIXES),
            "metrics": {metric: noise.metrics.get(metric, "higher") for metric in RETRIEVAL_METRICS},
        }
    )


def slice_drops(observed: EvalReport, reference: Baseline, noise: NoiseConfig) -> GateResult:
    aligned = reference.model_copy(update={"request_options": observed.request_options})
    return evaluate_gate(observed, aligned, _slice_noise(noise))


# ---------- rule (a)


def legacy_parity_rule(runs: Mapping[str, tuple[RunOutput, Baseline]], noise: NoiseConfig) -> LegacyParityResult:
    checks: list[LegacyRunCheck] = []
    for name, (output, baseline) in runs.items():
        gate = evaluate_gate(output.report, baseline, noise)
        nonzero = []
        if gate.paired is not None:
            nonzero = [
                f"{slice_name}:{metric}"
                for slice_name, stats in sorted(gate.paired.slices.items())
                for metric, stat in stats.items()
                if stat.n_nonzero
            ]
        checks.append(
            LegacyRunCheck(
                run=name,
                all_zero=bool(gate.paired is not None and gate.paired.all_zero and not gate.mismatches),
                gate_passed=gate.passed,
                mismatches=list(gate.mismatches),
                nonzero_cells=nonzero,
            )
        )
    return LegacyParityResult(passed=bool(checks) and all(check.all_zero for check in checks), runs=checks)


# ---------- rule (b)


def _recorded(reference: Baseline, metric: str) -> float | None:
    stat = reference.slices.get("overall", {}).get(metric)
    return stat.mean if stat is not None else None


def _refusal_fields(report: EvalReport, reference: Baseline) -> dict[str, Any]:
    correct = report.overall.correct_refusal_rate
    false = report.overall.false_refusal_rate
    return {
        "correct_refusal": correct.value,
        "correct_refusal_n": correct.n,
        "reference_correct_refusal": _recorded(reference, "correct_refusal_rate"),
        "false_refusal": false.value,
        "false_refusal_n": false.n,
        "false_refusal_upper_95": report.overall.false_refusal_upper_95,
        "reference_false_refusal": _recorded(reference, "false_refusal_rate"),
    }


def point_refusal(report: EvalReport, reference: Baseline) -> RefusalComparison:
    """Against the all-off v2 run: correct refusal not lower and the false-refusal point estimate not higher."""
    fields = _refusal_fields(report, reference)
    correct, ref_correct = fields["correct_refusal"], fields["reference_correct_refusal"]
    false, ref_false = fields["false_refusal"], fields["reference_false_refusal"]
    failures: list[str] = []
    if correct is None or ref_correct is None:
        failures.append("correct refusal not measured")
    elif correct < ref_correct - RATE_TOLERANCE:
        failures.append(f"correct refusal {correct:.4f} below the reference {ref_correct:.4f}")
    if false is None or ref_false is None:
        failures.append("false refusal not measured")
    elif false > ref_false + RATE_TOLERANCE:
        failures.append(f"false refusal {false:.4f} above the reference {ref_false:.4f}")
    strictly = not failures and correct > ref_correct + RATE_TOLERANCE
    return RefusalComparison(method="point", **fields, matched=None, passed=not failures, strictly_improved=strictly, failures=failures)


def _dense_scores(output: RunOutput) -> tuple[dict[str, float], dict[str, float], int]:
    traces = {trace.item_id: trace for trace in output.traces}
    answerable: dict[str, float] = {}
    no_answer: dict[str, float] = {}
    excluded = 0
    for item in _gated_items(output):
        trace = traces.get(item.item_id)
        best = _best_dense(trace, IMAGE_FLOOR) if trace is not None else None
        if best is None:
            excluded += 1
            continue
        (answerable if item.answerable else no_answer)[item.item_id] = best
    return answerable, no_answer, excluded


def _refused_in_baseline(reference: Baseline, item_ids: set[str]) -> set[str] | None:
    """Gated no-answer items the baseline refused in every recorded run."""
    if reference.items is None:
        return None
    refused: set[str] = set()
    for item_id in item_ids:
        present = [value for value in reference.items.get(item_id, {}).get("correct_refusal_rate") or [] if value is not None]
        if present and all(value == 1.0 for value in present):
            refused.add(item_id)
    return refused


def matched_refusal(report: EvalReport, reference: Baseline, source: RunOutput, *, source_name: str) -> RefusalComparison:
    """Against the committed baseline: a threshold fitted on the source run's dense scores at the baseline's false-refusal
    rate (calibrate.refusal.fit_threshold) must reach the baseline's correct refusal (research D-28 row)."""
    fields = _refusal_fields(report, reference)
    ref_correct, target = fields["reference_correct_refusal"], fields["reference_false_refusal"]
    if ref_correct is None or target is None:
        return RefusalComparison(
            method="matched_false_refusal",
            **fields,
            matched=None,
            passed=False,
            strictly_improved=False,
            failures=["the baseline records no overall correct- or false-refusal rate"],
        )
    answerable, no_answer, excluded = _dense_scores(source)
    if not answerable or not no_answer:
        return RefusalComparison(
            method="matched_false_refusal",
            **fields,
            matched=None,
            passed=False,
            strictly_improved=False,
            failures=[f"run {source_name} has no dense score for its answerable or no-answer items"],
        )
    fit = fit_threshold(list(answerable.values()), list(no_answer.values()), target + RATE_TOLERANCE)
    refused = {item_id for item_id, score in no_answer.items() if score < fit.threshold}
    no_answer_ids = {item.item_id for item in _gated_items(source) if not item.answerable}
    baseline_refused = _refused_in_baseline(reference, no_answer_ids)
    missing = sorted(baseline_refused - refused) if baseline_refused is not None else []
    matched = MatchedRefusal(
        source=source_name,
        target_false_refusal=target,
        threshold=fit.threshold if math.isfinite(fit.threshold) else None,
        false_refusal=fit.false_refusal,
        correct_refusal=fit.correct_refusal,
        answerable_n=len(answerable),
        no_answer_n=len(no_answer),
        excluded_no_similarity=excluded,
        reference_refused=len(baseline_refused) if baseline_refused is not None else None,
        covers_reference=None if baseline_refused is None else not missing,
        missing=missing,
    )
    failures: list[str] = []
    if fit.correct_refusal < ref_correct - RATE_TOLERANCE:
        failures.append(
            f"correct refusal {fit.correct_refusal:.4f} at the matched false refusal {fit.false_refusal:.4f} "
            f"(target {target:.4f}) below the baseline {ref_correct:.4f}"
        )
    strictly = not failures and fit.correct_refusal > ref_correct + RATE_TOLERANCE
    return RefusalComparison(
        method="matched_false_refusal", **fields, matched=matched, passed=not failures, strictly_improved=strictly, failures=failures
    )


def split_category_moves(gate: GateResult) -> tuple[list[GateOffender], list[ReportOnlyMove]]:
    """Overall and language offenders are drops. A category offender is a drop only with paired support (interval upper
    end below 0, or at least two items moved); otherwise it is a report-only move."""
    drops: list[GateOffender] = []
    moves: list[ReportOnlyMove] = []
    for drop in gate.offenders:
        stat = gate.paired.slices.get(drop.slice, {}).get(drop.metric) if gate.paired is not None else None
        supported = stat is None or (stat.ci_high is not None and stat.ci_high < 0) or stat.n_nonzero >= 2
        if not drop.slice.startswith(CATEGORY_PREFIX) or supported:
            drops.append(drop)
        else:
            moves.append(ReportOnlyMove(drop=drop, n=stat.n, n_nonzero=stat.n_nonzero, ci_low=stat.ci_low, ci_high=stat.ci_high))
    return drops, moves


def _recommended_check(output: RunOutput, reference: Baseline, noise: NoiseConfig, against: str, refusal: RefusalComparison) -> RecommendedCheck:
    gate = slice_drops(output.report, reference, noise)
    drops, moves = split_category_moves(gate)
    return RecommendedCheck(
        against=against,
        passed=not gate.mismatches and not drops and refusal.passed,
        mismatches=list(gate.mismatches),
        drops=drops,
        report_only=moves,
        refusal=refusal,
    )


def gate_answers_below_floor(output: RunOutput, reference: RunOutput) -> list[GateBelowFloor]:
    """No-answer items the rerank gate answered although their best dense score is below the similarity floor (the gate
    supersedes the floor, D-30). The floor is the one the reference run's floor decisions used."""
    floors = {
        trace.refusal.threshold
        for trace in reference.traces
        if trace.refusal is not None and trace.refusal.reason in FLOOR_REASONS and trace.refusal.threshold is not None
    }
    if len(floors) != 1:
        return []
    floor = floors.pop()
    items = {item.item_id: item for item in output.report.items}
    rows: list[GateBelowFloor] = []
    for trace in output.traces:
        item = items.get(trace.item_id) if trace.item_id else None
        refusal = trace.refusal
        if item is None or item.answerable or item.refused or refusal is None:
            continue
        if refusal.decision != "answer" or not _gate_decided(refusal):
            continue
        best = _best_dense(trace, IMAGE_FLOOR)
        if best is None or best >= floor:
            continue
        rows.append(
            GateBelowFloor(
                item_id=item.item_id, split=item.split, cell_key=refusal.cell_key, gate_threshold=refusal.threshold, best_dense=best, floor=floor
            )
        )
    return sorted(rows, key=lambda row: (row.split, row.item_id))


def recommended_rule(
    output: RunOutput,
    baseline: Baseline,
    reference: RunOutput,
    noise: NoiseConfig,
    *,
    run: str,
    reference_name: str,
) -> RecommendedResult:
    """D-28 (b), read at the target false-refusal point (research D-28 row; decision 2026-11-25): against the all-off v2
    run by point estimates, against the committed baseline at a matched false-refusal rate on the all-off run's dense scores."""
    reference_baseline = baseline_from_report(reference.report, tag=reference_name)
    against_baseline = _recommended_check(
        output, baseline, noise, "baseline", matched_refusal(output.report, baseline, reference, source_name=reference_name)
    )
    against_reference = _recommended_check(
        output, reference_baseline, noise, reference_name, point_refusal(output.report, reference_baseline)
    )
    strict = against_baseline.refusal.strictly_improved and against_reference.refusal.strictly_improved
    return RecommendedResult(
        run=run,
        passed=against_baseline.passed and against_reference.passed,
        baseline=against_baseline,
        reference=against_reference,
        strict_improvement=StrictImprovement(verdict="improved" if strict else "open", note=STRICT_DONE_NOTE if strict else STRICT_OPEN_NOTE),
        gate_below_floor=gate_answers_below_floor(output, reference),
    )


# ---------- rule (c)


def _switch(on: str, off: str, failures: list[str], drops: list[GateOffender], measures: dict[str, float | None]) -> SwitchResult:
    return SwitchResult(on=on, off=off, passed=not failures, failures=failures, drops=drops, measures=measures)


def _drop_failures(gate: GateResult) -> list[str]:
    failures = [f"report and reference differ: {problem}" for problem in gate.mismatches]
    failures += [
        f"{drop.slice} {drop.metric} dropped beyond the noise band ({drop.observed:.4f} < {drop.threshold:.4f})" for drop in gate.offenders
    ]
    return failures


def parent_child_rule(on_run: RunOutput, off_run: RunOutput, noise: NoiseConfig, *, on_name: str, off_name: str) -> SwitchResult:
    """Success criterion 6: a clause-slice Recall gain and no slice dropping beyond the noise band."""
    gate = slice_drops(on_run.report, baseline_from_report(off_run.report, tag=off_name), noise)
    failures = _drop_failures(gate)
    clause_on, clause_off = clause_recall(on_run), clause_recall(off_run)
    clause_delta = _delta(clause_on, clause_off)
    if clause_delta is None:
        failures.append(f"no {CLAUSE_SLICE} items scored in one of the runs")
    elif clause_delta <= 0:
        failures.append(f"no {CLAUSE_SLICE}-slice Recall@10 gain ({clause_on:.4f} on vs {clause_off:.4f} off)")
    measures = {
        "clause_recall_at_10_on": clause_on,
        "clause_recall_at_10_off": clause_off,
        "clause_recall_at_10_delta": clause_delta,
        "overall_recall_at_10_delta": _delta(_metric(on_run.report, "overall", CLAUSE_METRIC), _metric(off_run.report, "overall", CLAUSE_METRIC)),
        "context_tokens_on": context_tokens_mean(on_run),
        "context_tokens_off": context_tokens_mean(off_run),
    }
    return _switch(on_name, off_name, failures, list(gate.offenders), measures)


def compression_rule(on_run: RunOutput, off_run: RunOutput, noise: NoiseConfig, *, on_name: str, off_name: str) -> SwitchResult:
    """No slice dropping beyond the noise band, with fewer context tokens than the off run."""
    gate = slice_drops(on_run.report, baseline_from_report(off_run.report, tag=off_name), noise)
    failures = _drop_failures(gate)
    tokens_on, tokens_off = context_tokens_mean(on_run), context_tokens_mean(off_run)
    if tokens_on is None or tokens_off is None:
        failures.append("context tokens not measured")
    elif tokens_on >= tokens_off:
        failures.append(f"context tokens not reduced ({tokens_on:.1f} on vs {tokens_off:.1f} off)")
    measures = {
        "context_tokens_on": tokens_on,
        "context_tokens_off": tokens_off,
        "context_tokens_delta": _delta(tokens_on, tokens_off),
        "overall_recall_at_10_delta": _delta(_metric(on_run.report, "overall", "recall_at_10"), _metric(off_run.report, "overall", "recall_at_10")),
        "overall_mrr_delta": _delta(_metric(on_run.report, "overall", "mrr"), _metric(off_run.report, "overall", "mrr")),
    }
    return _switch(on_name, off_name, failures, list(gate.offenders), measures)


def translation_rule(on_run: RunOutput, off_run: RunOutput, *, on_name: str, off_name: str) -> SwitchResult:
    """Success criterion 8: cross_lingual Recall@k and the lexical-leg hit rate at or above the off run."""
    failures: list[str] = []
    measures: dict[str, float | None] = {}
    pairs = [
        (f"cross_lingual_{metric}", _metric(on_run.report, CROSS_LINGUAL_SLICE, metric), _metric(off_run.report, CROSS_LINGUAL_SLICE, metric))
        for metric in ("recall_at_5", "recall_at_10")
    ]
    pairs.append(("lexical_leg_hit_rate_at_10", _lexical_rate(on_run.report), _lexical_rate(off_run.report)))
    pairs.append(("cross_lingual_lexical_leg_hit_rate_at_10", _cross_lingual_lexical_rate(on_run), _cross_lingual_lexical_rate(off_run)))
    for name, value_on, value_off in pairs:
        measures[f"{name}_on"] = value_on
        measures[f"{name}_off"] = value_off
        if value_on is None or value_off is None:
            failures.append(f"{name} not measured")
        elif value_on < value_off:
            failures.append(f"{name} below the off run ({value_on:.4f} on vs {value_off:.4f} off)")
    return _switch(on_name, off_name, failures, [], measures)


def _parse_selective(report: Mapping[str, Any] | None) -> tuple[dict[str, dict[str, SelectiveModeMetrics]], list[str]]:
    if not report:
        return {}, ["the synthetic selective-filter report is missing"]
    parsed: dict[str, dict[str, SelectiveModeMetrics]] = {}
    failures: list[str] = []
    for slice_name, modes in sorted(report.items()):
        try:
            parsed[slice_name] = {mode: SelectiveModeMetrics.model_validate(modes[mode]) for mode in SELECTIVE_MODES}
        except (KeyError, TypeError, ValidationError) as exc:
            failures.append(f"synthetic slice {slice_name} is incomplete: {exc}")
    return parsed, failures


def iterative_scan_rule(
    on_run: RunOutput,
    off_run: RunOutput,
    synthetic: Mapping[str, Any] | None,
    *,
    fixture_slice: str,
    on_name: str,
    off_name: str,
) -> IterativeScanResult:
    """Success criterion 10 on the synthetic indexed database (research F-6); the fixture slice is reported, not judged."""
    parsed, failures = _parse_selective(synthetic)
    if synthetic and not parsed:
        failures.append("the synthetic selective-filter report has no slice")
    for slice_name, modes in parsed.items():
        off = modes["off"]
        if off.rows >= off.k:
            failures.append(f"{slice_name}: iterative scan off returned {off.rows} rows, expected fewer than k={off.k}")
        for mode in ("relaxed_order", "strict_order"):
            if modes[mode].recall_at_k < ITERATIVE_RECALL_FLOOR:
                failures.append(f"{slice_name}: {mode} recall {modes[mode].recall_at_k:.2f} below {ITERATIVE_RECALL_FLOOR}")
        if modes["exact"].recall_at_k != 1.0:
            failures.append(f"{slice_name}: the exact path differs from exact search (recall {modes['exact'].recall_at_k:.2f})")
    fixture: dict[str, float | None] = {}
    for metric in RETRIEVAL_METRICS:
        fixture[f"{metric}_on"] = _metric(on_run.report, fixture_slice, metric)
        fixture[f"{metric}_off"] = _metric(off_run.report, fixture_slice, metric)
    equal = all(fixture[f"{metric}_on"] == fixture[f"{metric}_off"] for metric in RETRIEVAL_METRICS)
    return IterativeScanResult(
        on=on_name,
        off=off_name,
        passed=not failures,
        failures=failures,
        fixture_slice=fixture_slice,
        fixture=fixture,
        fixture_equal=equal,
        synthetic=parsed,
    )


# ---------- rule (d), XLG-03 and local_bm25


def command_result(command: list[str], exit_code: int) -> CommandResult:
    return CommandResult(command=list(command), exit_code=exit_code, passed=exit_code == 0)


def xlg03_verdict(result: CalibrationResult) -> CrossLingualVerdict:
    comparable = [row for row in result.cross_vs_same if row.comparable]
    exceeding = [row.cross_key or f"{row.provider}|{row.model}|{row.query_language}|cross" for row in comparable if row.exceeds_noise_band]
    if exceeding:
        verdict, note = "fail", "cross-language false refusal is above same-language beyond the noise band"
    elif comparable:
        verdict, note = "pass", "cross-language false refusal is not above same-language beyond the noise band"
    else:
        verdict, note = "not_comparable", "no cross cell has a threshold on the fixture; XLG-03 is decided by the live calibration (04-43)"
    return CrossLingualVerdict(
        verdict=verdict, comparable_cells=len(comparable), exceeding=exceeding, comparisons=list(result.cross_vs_same), note=note
    )


def local_bm25_refusal_rule(output: RunOutput, *, run: str) -> LocalBm25RefusalResult:
    """Research F-3: local_bm25 scores are relative, so no refusal may rest on a rerank threshold."""
    ids = {item.item_id for item in _gated_items(output)}
    traces = [trace for trace in output.traces if trace.item_id in ids]
    bases = Counter(
        f"{trace.refusal.basis}/{trace.refusal.decision}" if trace.refusal is not None else "none" for trace in traces
    )
    threshold = sum(1 for trace in traces if trace.refusal is not None and trace.refusal.basis == THRESHOLD_BASIS)
    return LocalBm25RefusalResult(
        run=run, passed=threshold == 0, threshold_decisions=threshold, refusal_bases=dict(sorted(bases.items())), overall=output.report.overall
    )


# ---------- chunking profile


def _slug(profile_id: str, doc_type: str) -> str:
    suffix = f"-{doc_type}"
    return profile_id[: -len(suffix)] if profile_id.endswith(suffix) else profile_id


def resolve_chunking_profile(decision: ChunkingDecision, sweep: ChunkingSweepReport) -> ChunkingChoice:
    """The recorded decision, or, when it is legacy, the best gated candidate of the sweep (gate passed first, then fewest
    regressions, then clause Recall@k, clause MRR and overall Recall@k; ties keep report order)."""
    if decision.profile_id != LEGACY_ID:
        return ChunkingChoice(
            profile_id=_slug(decision.profile_id, decision.doc_type),
            source="decision",
            decision_profile_id=decision.profile_id,
            doc_type=decision.doc_type,
        )
    candidates = [entry for entry in sweep.profiles if entry.gate is not None]
    if not candidates:
        return ChunkingChoice(profile_id=LEGACY_ID, source="decision", decision_profile_id=decision.profile_id, doc_type=decision.doc_type)

    def key(entry) -> tuple:
        clause = entry.metrics.by_question_kind.get(CLAUSE_SLICE)
        clause_recall = clause.recall_at_k.value if clause is not None and clause.recall_at_k.value is not None else -1.0
        clause_mrr = clause.mrr.value if clause is not None and clause.mrr.value is not None else -1.0
        overall = entry.metrics.overall.recall_at_k.value if entry.metrics.overall.recall_at_k.value is not None else -1.0
        return (not entry.gate.passed, len(entry.gate.regressions), -clause_recall, -clause_mrr, -overall)

    best = min(candidates, key=key)
    return ChunkingChoice(
        profile_id=best.profile_id, source="sweep_candidate", decision_profile_id=decision.profile_id, doc_type=decision.doc_type
    )


def chunking_profiles(slug: str, doc_types: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
    if slug == LEGACY_ID:
        return []
    match = PRESET_SLUG.match(slug)
    if match is None:
        raise ComparisonError(f"chunking profile {slug!r} is not a sweep preset id (p<child>-<parent>)")
    preset = parse_presets(f"{match.group(1)}/{match.group(2)}")[0]
    types = sorted(set((doc_types if doc_types is not None else ingest_doc_types()).values()) | {GENERAL_DOC_TYPE})
    return [profile.model_dump(mode="json") for profile in _profiles_for(preset, types)]


# ---------- runs


def materialise_run_config(run: RunSpec, profiles: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        base = json.loads(resolve_cli_path(run.base).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ComparisonError(f"run {run.name}: base run-config {run.base} is unreadable: {exc}") from exc
    if not isinstance(base, dict):
        raise ComparisonError(f"run {run.name}: base run-config {run.base} must be a JSON object")
    overrides = dict(base.get("overrides") or {})
    for key in run.drop_overrides:
        overrides.pop(key, None)
    config: dict[str, Any] = {"name": run.name, "env": {**(base.get("env") or {}), **run.env}}
    if run.chunking_profile == RECORDED_PROFILE and profiles:
        overrides["chunking_profile_by_doc_type"] = {profile["doc_type"]: profile["id"] for profile in profiles}
        config["chunking_profiles"] = [dict(profile) for profile in profiles]
    config["overrides"] = overrides or None
    return config


def default_runner(request: RunRequest, spawner: Spawner | None = None) -> RunOutput:
    """One in-process smoke run over the default golden files of its fixture mode; scoring only, the gate runs here."""
    out_dir = Path(request.out_dir)
    inputs = out_dir / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    config_path = inputs / "run-config.json"
    config_path.write_text(json.dumps(request.run_config, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    argv = [
        "npx",
        "tsx",
        HARNESS_SCRIPT,
        "--run-config",
        str(config_path),
        "--fixture-mode",
        request.fixture_mode,
        "--no-gate",
        "--out",
        str(out_dir),
        *request.harness_flags,
    ]
    if request.process_env:
        env = {**os.environ, **request.process_env}
        if spawner is not None:
            result = spawner(argv, REPO_ROOT, env=env)
        else:
            result = subprocess.run(argv, cwd=REPO_ROOT, capture_output=True, text=True, check=False, env=env)
    else:
        result = (spawner or default_spawner)(argv, REPO_ROOT)
    if result.returncode != 0:
        tail = _tail(result.stderr) or _tail(result.stdout)
        raise HarnessError(
            f"run {request.name}: harness exited with exit code {result.returncode}\n--- last {TAIL_LINES} lines ---\n{tail}",
            exit_code=result.returncode,
        )
    try:
        report = EvalReport.model_validate_json((out_dir / "report.json").read_text(encoding="utf-8"))
        traces = load_traces(out_dir / "traces.jsonl")
        golden = load_golden(resolve_cli_path(load_manifest(out_dir / "run.json").golden_path))
    except (OSError, ValidationError, ValueError) as exc:
        raise HarnessError(f"run {request.name}: harness output in {out_dir} is unreadable: {exc}", exit_code=0) from exc
    return RunOutput(report=report, traces=traces, golden=golden)


def default_command_runner(argv: list[str]) -> int:
    result = subprocess.run(argv, cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"[Phase Compare] {' '.join(argv)} exited {result.returncode}", file=sys.stderr)
        print(_tail(result.stdout + "\n" + result.stderr), file=sys.stderr)
    return result.returncode


def _record(name: str, mode: str, config: dict[str, Any], output: RunOutput) -> RunRecord:
    return RunRecord(
        name=name,
        fixture_mode=mode,
        env=dict(config["env"]),
        overrides=config["overrides"],
        chunking_profiles=[profile["id"] for profile in config.get("chunking_profiles", [])],
        run_config_hash=output.report.run_config_hash,
        overall=output.report.overall,
        lexical_leg_hit_rate_at_10=_lexical_rate(output.report),
        context_tokens_mean=context_tokens_mean(output),
    )


def _read_model(model, path: str, what: str):
    try:
        return model.model_validate_json(resolve_cli_path(path).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise ComparisonError(f"{what} {path} is unreadable: {exc}") from exc


def _read_json(path: str, what: str) -> dict[str, Any]:
    try:
        payload = json.loads(resolve_cli_path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ComparisonError(f"{what} {path} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise ComparisonError(f"{what} {path} must be a JSON object")
    return payload


def run_phase_comparison(
    spec: ComparisonSpec | Path,
    out: Path,
    runner: Runner = default_runner,
    commands: CommandRunner = default_command_runner,
) -> PhaseComparison:
    if not isinstance(spec, ComparisonSpec):
        spec = _read_model(ComparisonSpec, str(spec), "comparison spec")
    noise = _read_model(NoiseConfig, spec.noise, "noise config")
    baselines = {mode: _read_model(Baseline, path, f"{mode} baseline") for mode, path in spec.baselines.items()}
    decision = _read_model(ChunkingDecision, spec.chunking_decision, "chunking decision")
    sweep = _read_model(ChunkingSweepReport, spec.chunking_sweep, "chunking sweep")
    calibration = _read_model(CalibrationResult, spec.calibration_result, "calibration result")
    outcome = _read_json(spec.calibration_outcome, "calibration outcome")

    out_dir = Path(out)
    harness_dir = out_dir / HARNESS_DIR
    choice = resolve_chunking_profile(decision, sweep)
    profiles = chunking_profiles(choice.profile_id)

    outputs: dict[str, RunOutput] = {}
    records: list[RunRecord] = []
    for run in spec.runs:
        config = materialise_run_config(run, profiles)
        print(f"[Phase Compare] run {run.name} ({run.fixture_mode})", file=sys.stderr)
        output = runner(RunRequest(name=run.name, run_config=config, fixture_mode=run.fixture_mode, out_dir=harness_dir / run.name))
        outputs[run.name] = output
        records.append(_record(run.name, run.fixture_mode, config, output))
    modes = {run.name: run.fixture_mode for run in spec.runs}
    rules = spec.rules

    legacy = legacy_parity_rule({name: (outputs[name], baselines[modes[name]]) for name in rules.legacy_parity}, noise)
    recommended = recommended_rule(
        outputs[rules.recommended.run],
        baselines[modes[rules.recommended.run]],
        outputs[rules.recommended.reference],
        noise,
        run=rules.recommended.run,
        reference_name=rules.recommended.reference,
    )
    pc, comp, tr, it = rules.parent_child, rules.compression, rules.translation, rules.iterative_scan
    parent_child = parent_child_rule(outputs[pc.on], outputs[pc.off], noise, on_name=pc.on, off_name=pc.off)
    compression = compression_rule(outputs[comp.on], outputs[comp.off], noise, on_name=comp.on, off_name=comp.off)
    translation = translation_rule(outputs[tr.on], outputs[tr.off], on_name=tr.on, off_name=tr.off)

    selective_path = harness_dir / SELECTIVE_REPORT
    selective_path.parent.mkdir(parents=True, exist_ok=True)
    selective_path.unlink(missing_ok=True)
    selective_argv = [str(selective_path) if part == "{out}" else part for part in spec.commands.selective_filter]
    synthetic: dict[str, Any] | None = None
    if commands(selective_argv) == 0 and selective_path.is_file():
        try:
            loaded = json.loads(selective_path.read_text(encoding="utf-8"))
            synthetic = loaded if isinstance(loaded, dict) else None
        except json.JSONDecodeError:
            synthetic = None
    iterative = iterative_scan_rule(
        outputs[it.on], outputs[it.off], synthetic, fixture_slice=it.fixture_slice, on_name=it.on, off_name=it.off
    )
    conformance = command_result(spec.commands.conformance, commands(list(spec.commands.conformance)))
    voice_budget = command_result(spec.commands.voice_budget, commands(list(spec.commands.voice_budget)))
    xlg03 = xlg03_verdict(calibration)
    bm25 = local_bm25_refusal_rule(outputs[rules.local_bm25_refusal], run=rules.local_bm25_refusal)

    notes = [FIXTURE_NOTE, DEFAULTS_NOTE, ALIGNED_NOTE]
    if choice.source == "sweep_candidate":
        notes.append(
            f"Parent-child runs use sweep candidate {choice.profile_id}: the recorded {choice.doc_type} decision is "
            f"{choice.decision_profile_id}."
        )
    if xlg03.verdict == "not_comparable":
        notes.append(f"XLG-03: {xlg03.note}.")
    if recommended.strict_improvement.verdict == "open":
        notes.append(f"Success criterion 4 (correct refusal strictly improves): open; {recommended.strict_improvement.note}.")
    notes += [_below_floor_note(row) for row in recommended.gate_below_floor]
    passed = all(
        (
            legacy.passed,
            recommended.passed,
            parent_child.passed,
            compression.passed,
            translation.passed,
            iterative.passed,
            conformance.passed,
            voice_budget.passed,
            bm25.passed,
            xlg03.verdict != "fail",
        )
    )
    comparison = PhaseComparison(
        passed=passed,
        noise_floor=noise.floor,
        noise_k=noise.k,
        legacy_parity=legacy,
        recommended=recommended,
        parent_child=parent_child,
        compression=compression,
        translation=translation,
        iterative_scan=iterative,
        conformance=conformance,
        voice_budget=voice_budget,
        xlg03=xlg03,
        local_bm25_refusal=bm25,
        calibration_outcome=dict(outcome.get("comparison") or {}),
        chunking_profile=choice,
        runs=records,
        notes=notes,
    )
    _write_text(out_dir / JSON_NAME, json.dumps(comparison.model_dump(mode="json"), sort_keys=True, indent=2) + "\n")
    _write_text(out_dir / MARKDOWN_NAME, render_markdown(comparison))
    return comparison


# ---------- report


def _verdict(passed: bool) -> str:
    return "PASS" if passed else "FAIL"


def _num(value: float | None, digits: int = 4) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _drops_table(drops: list[GateOffender]) -> list[str]:
    if not drops:
        return ["No slice dropped beyond the noise band."]
    lines = ["| Slice | Metric | Reference | Threshold | Observed |", "| --- | --- | --- | --- | --- |"]
    lines += [f"| {d.slice} | {d.metric} | {_num(d.baseline_mean)} | {_num(d.threshold)} | {_num(d.observed)} |" for d in drops]
    return lines


def _failures(failures: list[str]) -> list[str]:
    return [f"- {failure}" for failure in failures] if failures else ["- none"]


def _switch_section(title: str, result: SwitchResult) -> list[str]:
    lines = [f"### {title}: {_verdict(result.passed)}", "", f"On `{result.on}` vs off `{result.off}`.", "", "| Measure | Value |", "| --- | --- |"]
    lines += [f"| {name} | {_num(value)} |" for name, value in result.measures.items()]
    lines += ["", "Failures:", *_failures(result.failures), "", *_drops_table(result.drops), ""]
    return lines


def _below_floor_note(row: GateBelowFloor) -> str:
    cell = row.cell_key or "unknown cell"
    return (
        f"Observation ({row.split} split): no-answer item {row.item_id} is answered by the rerank gate ({cell}, threshold "
        f"{_num(row.gate_threshold)}) with best dense {_num(row.best_dense)}, below the similarity floor {_num(row.floor)}; "
        "the gate supersedes the floor (D-30). Report only."
    )


def _refusal_lines(r: RefusalComparison) -> list[str]:
    lines = [
        f"- Correct refusal: {_num(r.correct_refusal)} (n={r.correct_refusal_n}) vs {_num(r.reference_correct_refusal)}",
        f"- False refusal: {_num(r.false_refusal)} (n={r.false_refusal_n}, 95% upper {_num(r.false_refusal_upper_95)}) "
        f"vs {_num(r.reference_false_refusal)}",
    ]
    if r.method == "point":
        lines.append("- Refusal check (point estimates): correct refusal not lower and false refusal not higher")
    else:
        lines.append("- Refusal check (matched false refusal): a threshold fitted on the reference dense scores at the baseline's false-refusal rate")
    m = r.matched
    if m is not None:
        coverage = "n/a" if m.covers_reference is None else ("yes" if m.covers_reference else "no")
        lines += [
            f"  - fitted on `{m.source}` dense scores (n={m.answerable_n} answerable, {m.no_answer_n} no-answer, "
            f"{m.excluded_no_similarity} without a score), target false refusal {_num(m.target_false_refusal)}",
            f"  - threshold {_num(m.threshold)}: false refusal {_num(m.false_refusal)}, correct refusal {_num(m.correct_refusal)} "
            f"vs the baseline {_num(r.reference_correct_refusal)}",
            f"  - refused set contains every no-answer item the baseline refused ({m.reference_refused if m.reference_refused is not None else 'n/a'}): "
            f"{coverage}" + (f"; missing {', '.join(m.missing)}" if m.missing else ""),
        ]
    lines.append(f"- Refusal: {_verdict(r.passed)}; strictly higher: {'yes' if r.strictly_improved else 'no'}")
    lines += [f"- Refusal failure: {failure}" for failure in r.failures]
    return lines


def _report_only_table(moves: list[ReportOnlyMove]) -> list[str]:
    if not moves:
        return []
    lines = [
        "Report-only category moves (beyond the band, but the paired interval reaches 0 and fewer than two items moved):",
        "",
        "| Slice | Metric | Reference | Threshold | Observed | n | n_nonzero | Paired 95% interval |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    lines += [
        f"| {m.drop.slice} | {m.drop.metric} | {_num(m.drop.baseline_mean)} | {_num(m.drop.threshold)} | {_num(m.drop.observed)} | "
        f"{m.n} | {m.n_nonzero} | [{_num(m.ci_low)}, {_num(m.ci_high)}] |"
        for m in moves
    ]
    return [*lines, ""]


def _recommended_section(check: RecommendedCheck, label: str) -> list[str]:
    return [
        f"#### Against {label}: {_verdict(check.passed)}",
        "",
        *_refusal_lines(check.refusal),
        *([f"- Data mismatch: {m}" for m in check.mismatches]),
        "",
        *_drops_table(check.drops),
        "",
        *_report_only_table(check.report_only),
    ]


def render_markdown(c: PhaseComparison) -> str:
    rec = c.recommended
    lines = [
        "# Phase 4 comparison (D-28)",
        "",
        f"Result: {_verdict(c.passed)}",
        "",
        f"Noise band: a slice drops beyond the noise band when it falls more than max({c.noise_k:g} x baseline spread, "
        f"{c.noise_floor:g}) below its reference. Rules (b) and (c) check the overall, every language and every category "
        "slice on Recall@5, Recall@10 and MRR (the CI gate checks fewer slices).",
        "",
        "Rule (b) reading (decision 2026-11-25, research D-28 row): correct refusal is compared at matched false refusal. "
        "Against the all-off v2 run, correct refusal must not be lower and the false-refusal point estimate not higher. "
        "Against the committed baseline, a threshold fitted with calibrate.refusal.fit_threshold on the all-off run's dense "
        "scores at the baseline's false-refusal rate must reach the baseline's correct refusal. Overall and language slices "
        "keep the band; a category slice counts as a drop only when it is beyond the band and its paired interval ends "
        "below 0 or at least two items moved.",
        "",
        *[f"- {note}" for note in c.notes],
        "",
        "## Verdicts",
        "",
        "| Rule | Verdict |",
        "| --- | --- |",
        f"| (a) legacy parity | {_verdict(c.legacy_parity.passed)} |",
        f"| (b) v2-recommended vs baseline and v2-all-off | {_verdict(rec.passed)} |",
        f"| (c) parent-child | {_verdict(c.parent_child.passed)} |",
        f"| (c) compression | {_verdict(c.compression.passed)} |",
        f"| (c) translation (local_bm25) | {_verdict(c.translation.passed)} |",
        f"| (c) iterative scan (synthetic database) | {_verdict(c.iterative_scan.passed)} |",
        f"| (d) conformance suite | {_verdict(c.conformance.passed)} (exit {c.conformance.exit_code}) |",
        f"| (d) voice budget | {_verdict(c.voice_budget.passed)} (exit {c.voice_budget.exit_code}) |",
        f"| local_bm25 refusal not threshold-based (F-3) | {_verdict(c.local_bm25_refusal.passed)} |",
        f"| XLG-03 cross vs same false refusal | {c.xlg03.verdict} |",
        "",
        "## (a) Legacy parity",
        "",
        "| Run | All paired differences zero | Gate passed | Non-zero cells |",
        "| --- | --- | --- | --- |",
    ]
    for run in c.legacy_parity.runs:
        cells = ", ".join(run.nonzero_cells) or "none"
        lines.append(f"| {run.run} | {'yes' if run.all_zero else 'no'} | {'yes' if run.gate_passed else 'no'} | {cells} |")
        lines += [f"| {run.run} mismatch | {m} | | |" for m in run.mismatches]
    lines += [
        "",
        f"## (b) {rec.run}",
        "",
        *_recommended_section(rec.baseline, "the committed baseline"),
        *_recommended_section(rec.reference, f"`{rec.reference.against}`"),
        f"Correct refusal strictly improves: {rec.strict_improvement.verdict} ({rec.strict_improvement.note}).",
        "",
        *[f"- {_below_floor_note(row)}" for row in rec.gate_below_floor],
        *([""] if rec.gate_below_floor else []),
        f"Calibration outcome (plan 04-39): {json.dumps(c.calibration_outcome, sort_keys=True)}",
        "",
        "## (c) Switches on and off",
        "",
        f"Chunking profile for the parent-child pair: `{c.chunking_profile.profile_id}` ({c.chunking_profile.source}; "
        f"recorded {c.chunking_profile.doc_type} decision `{c.chunking_profile.decision_profile_id}`).",
        "",
        *_switch_section("Parent-child (ingest mode)", c.parent_child),
        *_switch_section("Compression", c.compression),
        *_switch_section("Translation with local_bm25", c.translation),
        f"### Iterative scan: {_verdict(c.iterative_scan.passed)}",
        "",
        f"Fixture slice `{c.iterative_scan.fixture_slice}` ({c.iterative_scan.on} vs {c.iterative_scan.off}), report only "
        f"(the fixture never uses the HNSW index, research F-6): equal {'yes' if c.iterative_scan.fixture_equal else 'no'}.",
        "",
        "| Measure | Value |",
        "| --- | --- |",
        *[f"| {name} | {_num(value)} |" for name, value in c.iterative_scan.fixture.items()],
        "",
        "Synthetic database (index forced):",
        "",
        "| Slice | Mode | Rows | Recall@k | k |",
        "| --- | --- | --- | --- | --- |",
    ]
    for slice_name, modes in c.iterative_scan.synthetic.items():
        lines += [f"| {slice_name} | {mode} | {m.rows} | {_num(m.recall_at_k, 2)} | {m.k} |" for mode, m in modes.items()]
    lines += ["", "Failures:", *_failures(c.iterative_scan.failures), ""]
    bm = c.local_bm25_refusal
    lines += [
        "## (d) Commands",
        "",
        f"- Conformance: `{' '.join(c.conformance.command)}` exit {c.conformance.exit_code}",
        f"- Voice budget: `{' '.join(c.voice_budget.command)}` exit {c.voice_budget.exit_code}",
        "",
        "## local_bm25 with threshold refusal not applied (F-3)",
        "",
        f"Run `{bm.run}`: rerank-threshold decisions {bm.threshold_decisions}; refusal bases "
        f"{json.dumps(bm.refusal_bases, sort_keys=True)}; correct refusal {_num(bm.overall.correct_refusal_rate.value)}, "
        f"false refusal {_num(bm.overall.false_refusal_rate.value)}.",
        "",
        "## XLG-03",
        "",
        f"Verdict: {c.xlg03.verdict} ({c.xlg03.comparable_cells} comparable cells). {c.xlg03.note}.",
        "",
        "## Runs",
        "",
        "| Run | Mode | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal (95% upper) | Lexical hit@10 | Context tokens |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in c.runs:
        o = r.overall
        lines.append(
            f"| {r.name} | {r.fixture_mode} | {_num(o.recall_at_5.value)} | {_num(o.recall_at_10.value)} | {_num(o.mrr.value)} | "
            f"{_num(o.correct_refusal_rate.value)} | {_num(o.false_refusal_rate.value)} ({_num(o.false_refusal_upper_95)}) | "
            f"{_num(r.lexical_leg_hit_rate_at_10)} | {_num(r.context_tokens_mean, 1)} |"
        )
    return "\n".join(lines) + "\n"


# ---------- schema 2: switch comparison (Phase 5 D-25 and later phases)
#
# A schema-2 spec names runs by the switches they set for the app under test (process environment of the harness, not the run-config
# overlay, whose allowlist stays the Phase 4 retrieval switches) and the harness flags they pass, and lists the checks each run must pass.

SWITCH_NAME = re.compile(r"^(NEXT_PUBLIC_)?RAG_[A-Z0-9_]+$")
SECRET_PART = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?(_|$)")
HarnessFlag = Literal["--citations", "--groundedness"]
BuiltinCheck = Literal["paired_all_zero", "retrieval_unchanged", "no_slice_drop", "citation_validity", "gate", "report_only"]
BUILTIN_CHECKS: tuple[str, ...] = ("paired_all_zero", "retrieval_unchanged", "no_slice_drop", "citation_validity", "gate", "report_only")
REPORT_PATH_TOKEN = re.compile(r'(?:^|\.)([A-Za-z_][A-Za-z0-9_]*)|\["([^"\]]+)"\]')
CATEGORY_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
COMMAND_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SWITCH_DEFAULTS_NOTE = "Every switch compared here defaults to off in src/lib/env.ts; the on runs set them for the app under test only."
SWITCH_FIXTURE_NOTE = (
    "Fixture corpus only: answers come from the deterministic fake citation generator and groundedness from the fake sidecar; "
    "the live Anthropic, Vectara and HHEM checks are operator actions."
)

EnvCommandRunner = Callable[[list[str], dict[str, str]], int]


def parse_report_path(path: str) -> list[str]:
    """`injection.attack_success_rate["category:injection"]` -> ["injection", "attack_success_rate", "category:injection"]."""
    keys: list[str] = []
    position = 0
    while position < len(path):
        match = REPORT_PATH_TOKEN.match(path, position)
        if match is None or match.end() == position or (position == 0 and path.startswith(".")):
            raise ValueError(f"report path {path!r} is malformed at position {position}")
        keys.append(match.group(1) or match.group(2))
        position = match.end()
    if not keys:
        raise ValueError("report path is empty")
    return keys


def _categories(values: list[str], what: str) -> list[str]:
    for value in values:
        if not CATEGORY_NAME.match(value):
            raise ValueError(f"{what}: {value!r} is not a category name")
    if len(set(values)) != len(values):
        raise ValueError(f"{what}: categories must be unique")
    return values


class AbsoluteZeroSpec(_Model):
    """D-14: the report value at `path` is measured and exactly 0; a missing or unmeasured value fails."""

    kind: Literal["absolute_zero"]
    path: str = Field(min_length=1)

    @model_validator(mode="after")
    def _path(self) -> AbsoluteZeroSpec:
        parse_report_path(self.path)
        return self

    @property
    def name(self) -> str:
        return f"absolute_zero:{self.path}"


class CategoryNoiseSpec(_Model):
    """D-14: every by_category slice except `exclude` stays within the noise band against the baseline."""

    kind: Literal["category_noise"]
    exclude: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _exclude(self) -> CategoryNoiseSpec:
        _categories(self.exclude, "category_noise exclude")
        return self

    @property
    def name(self) -> str:
        return "category_noise"


class RetrievalUnchangedSpec(_Model):
    """retrieval_unchanged over the items outside `exclude_categories`."""

    kind: Literal["retrieval_unchanged"]
    exclude_categories: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _exclude(self) -> RetrievalUnchangedSpec:
        _categories(self.exclude_categories, "retrieval_unchanged exclude_categories")
        return self

    @property
    def name(self) -> str:
        return "retrieval_unchanged"


class LatencyBudgetSpec(_Model):
    """Stage latency p95 within the profile's budgets; with `against`, also within the latency noise band of that earlier run."""

    kind: Literal["latency_budget"]
    profile: LatencyProfile = "chat"
    budgets: str = "eval/config/latency-budgets.json"
    against: str | None = None
    tolerance_ms: float = Field(default=5.0, ge=0)
    tolerance_ratio: float = Field(default=0.5, ge=0)

    @property
    def name(self) -> str:
        return "latency_budget"


CheckSpec = Annotated[AbsoluteZeroSpec | CategoryNoiseSpec | RetrievalUnchangedSpec | LatencyBudgetSpec, Field(discriminator="kind")]


def check_name(check: str | AbsoluteZeroSpec | CategoryNoiseSpec | RetrievalUnchangedSpec | LatencyBudgetSpec) -> str:
    return check if isinstance(check, str) else check.name


def _validate_switches(run: str, switches: Mapping[str, str], what: str) -> None:
    for name in switches:
        if not SWITCH_NAME.match(name):
            raise ValueError(f"run {run}: {what} {name} is not a RAG_* switch")
        if SECRET_PART.search(name):
            raise ValueError(f"run {run}: {name} looks like a credential; a comparison spec never carries one")


class SwitchRun(_Model):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    fixture_mode: FixtureMode
    base: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    switches: dict[str, str] = Field(default_factory=dict)
    harness_flags: list[HarnessFlag] = Field(default_factory=list)
    checks: list[str | CheckSpec] = Field(min_length=1)

    @model_validator(mode="after")
    def _switch_names(self) -> SwitchRun:
        _validate_switches(self.name, self.switches, "switch")
        _validate_switches(self.name, self.env, "run-config env")
        if self.env and self.base is None:
            raise ValueError(f"run {self.name}: env overlays a base run config; name one")
        if len(set(self.harness_flags)) != len(self.harness_flags):
            raise ValueError(f"run {self.name}: harness flags must be unique")
        names = [check_name(check) for check in self.checks]
        if len(set(names)) != len(names):
            raise ValueError(f"run {self.name}: checks must be unique")
        if "report_only" in names and len(names) > 1:
            raise ValueError(f"run {self.name}: report_only is the only check of a reported run")
        return self


class SwitchComparisonSpec(_Model):
    schema_version: Literal[2]
    phase: str = Field(pattern=r"^\d{2}(\.\d+)*$")
    noise: str
    baselines: dict[FixtureMode, str]
    runs: list[SwitchRun] = Field(min_length=1)
    commands: dict[str, list[str]] = Field(default_factory=dict)
    fixture_note: str | None = None
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _references(self) -> SwitchComparisonSpec:
        names = [run.name for run in self.runs]
        if len(names) != len(set(names)):
            raise ValueError("run names must be unique")
        for name, argv in self.commands.items():
            if not COMMAND_NAME.match(name) or name in BUILTIN_CHECKS:
                raise ValueError(f"command name {name!r} must be lowercase and differ from the built-in checks")
            if not argv:
                raise ValueError(f"command {name} is empty")
        known = set(BUILTIN_CHECKS) | set(self.commands)
        for run in self.runs:
            unknown = sorted({check for check in run.checks if isinstance(check, str)} - known)
            if unknown:
                raise ValueError(f"run {run.name} names unknown checks: {', '.join(unknown)}")
        if not {run.fixture_mode for run in self.runs} <= set(self.baselines):
            raise ValueError("every fixture mode used by a run needs a baseline")
        earlier: dict[str, str] = {}
        for run in self.runs:
            for check in run.checks:
                if isinstance(check, LatencyBudgetSpec) and check.against is not None and earlier.get(check.against) != run.fixture_mode:
                    raise ValueError(f"run {run.name}: latency reference {check.against} must be an earlier run with fixture mode {run.fixture_mode}")
            earlier[run.name] = run.fixture_mode
        return self


class CheckResult(_Model):
    name: str
    passed: bool
    detail: list[str] = Field(default_factory=list)
    measures: dict[str, float | None] = Field(default_factory=dict)


class SwitchRunResult(_Model):
    name: str
    fixture_mode: FixtureMode
    switches: dict[str, str]
    harness_flags: list[str]
    run_config_hash: str
    overall: SliceMetrics
    invalid_citation_rate: float | None
    citation_coverage: float | None
    run_config_env: dict[str, str] | None = None
    injection: InjectionReport | None = None
    passed: bool
    checks: list[CheckResult]


class SwitchComparison(_Model):
    schema_version: Literal[2] = 2
    phase: str
    passed: bool
    noise_floor: float
    noise_k: float
    runs: list[SwitchRunResult]
    notes: list[str]


def _paired_cells(gate: GateResult, metrics: tuple[str, ...] | None = None) -> list[str]:
    if gate.paired is None:
        return []
    return [
        f"{slice_name}:{metric} ({stat.n_nonzero} item(s) moved)"
        for slice_name, stats in sorted(gate.paired.slices.items())
        for metric, stat in sorted(stats.items())
        if stat.n_nonzero and (metrics is None or metric in metrics)
    ]


def paired_all_zero_check(output: RunOutput, baseline: Baseline, noise: NoiseConfig) -> CheckResult:
    """Every paired difference against the baseline is zero (retrieval and refusal), on the same data."""
    gate = evaluate_gate(output.report, baseline, noise)
    nonzero = _paired_cells(gate)
    passed = gate.paired is not None and gate.paired.all_zero and not gate.mismatches and not nonzero
    detail = [*gate.mismatches, *nonzero] or ([] if gate.paired is not None else ["no paired comparison"])
    return CheckResult(name="paired_all_zero", passed=passed, detail=detail)


def retrieval_unchanged_check(
    output: RunOutput, baseline: Baseline, noise: NoiseConfig, *, exclude_categories: list[str] | None = None
) -> CheckResult:
    """Every Recall@5, Recall@10 and MRR paired difference is zero; answer-only request options may differ (gate.ANSWER_ONLY_OPTIONS).

    exclude_categories leaves those items out of every paired cell (for example injection items whose attack documents a defense drops)."""
    report = output.report
    if exclude_categories:
        excluded = set(exclude_categories)
        report = report.model_copy(update={"items": [item for item in report.items if item.category not in excluded]})
    gate = evaluate_gate(report, baseline, noise)
    nonzero = _paired_cells(gate, RETRIEVAL_METRICS)
    passed = gate.paired is not None and not gate.mismatches and not nonzero
    detail = [*gate.mismatches, *nonzero] or ([] if gate.paired is not None else ["no paired comparison"])
    return CheckResult(name="retrieval_unchanged", passed=passed, detail=detail)


def no_slice_drop_check(output: RunOutput, baseline: Baseline, noise: NoiseConfig) -> CheckResult:
    """No overall, language or category slice falls beyond the noise band on a retrieval metric."""
    gate = slice_drops(output.report, baseline, noise)
    detail = [*gate.mismatches] + [
        f"{o.slice}:{o.metric} {o.observed:.4f} < {o.threshold:.4f} (baseline {o.baseline_mean:.4f})" for o in gate.offenders
    ]
    return CheckResult(name="no_slice_drop", passed=not gate.mismatches and not gate.offenders, detail=detail)


def citation_validity_check(output: RunOutput) -> CheckResult:
    """invalid_citation_rate is measured over at least one citation and is exactly 0."""
    rate = output.report.invalid_citation_rate
    value = rate.value if rate is not None else None
    n = rate.n if rate is not None else 0
    if value is None or n == 0:
        return CheckResult(
            name="citation_validity", passed=False, detail=["invalid_citation_rate was not measured"], measures={"invalid_citation_rate": value}
        )
    passed = value == 0
    detail = [] if passed else [f"invalid_citation_rate {value:.4f} over {n} citation(s)"]
    return CheckResult(name="citation_validity", passed=passed, detail=detail, measures={"invalid_citation_rate": value, "citations": float(n)})


def _report_value(report: EvalReport, path: str) -> tuple[float | None, str | None]:
    node: Any = report.model_dump(mode="json")
    walked: list[str] = []
    for key in parse_report_path(path):
        walked.append(key)
        if not isinstance(node, dict) or key not in node or node[key] is None:
            return None, f"{path}: {'.'.join(walked)} is missing from the report"
        node = node[key]
    if isinstance(node, dict) and set(node) == {"value", "n"}:
        if node["value"] is None or not node["n"]:
            return None, f"{path} was not measured (n={node['n']})"
        node = node["value"]
    if isinstance(node, bool) or not isinstance(node, (int, float)):
        return None, f"{path} is not a number"
    return float(node), None


def absolute_zero_check(output: RunOutput, path: str, name: str | None = None) -> CheckResult:
    """D-14: the value at a report path equals 0. A missing path or an unmeasured metric fails; nothing passes vacuously."""
    label = name or f"absolute_zero:{path}"
    value, problem = _report_value(output.report, path)
    if problem is not None:
        return CheckResult(name=label, passed=False, detail=[problem], measures={path: None})
    passed = value == 0
    detail = [] if passed else [f"{path} = {value:.4f}, expected 0"]
    return CheckResult(name=label, passed=passed, detail=detail, measures={path: value})


def category_noise_check(
    output: RunOutput, baseline: Baseline, noise: NoiseConfig, *, exclude: list[str], name: str = "category_noise"
) -> CheckResult:
    """D-14: no category slice outside `exclude` drops beyond the noise band on Recall@5, Recall@10 or MRR.

    The gate's own band arithmetic (slice_drops), restricted to category slices; overall and language slices stay with the gate check.
    A category the baseline measured but the run did not is a failure, and so is a check that compared no slice."""
    excluded = {f"{CATEGORY_PREFIX}{category}" for category in exclude}

    def counted(slice_name: str) -> bool:
        return slice_name.startswith(CATEGORY_PREFIX) and slice_name not in excluded

    gate = slice_drops(output.report, baseline, noise)
    if gate.mismatches:
        return CheckResult(name=name, passed=False, detail=list(gate.mismatches))
    offenders = [o for o in gate.offenders if o.kind == "noise_band" and counted(o.slice)]
    observed = {f"{CATEGORY_PREFIX}{category}": metrics for category, metrics in output.report.by_category.items()}
    compared: set[str] = set()
    missing: list[str] = []
    for slice_name in sorted(baseline.slices):
        if not counted(slice_name):
            continue
        for metric in RETRIEVAL_METRICS:
            stat = baseline.slices[slice_name].get(metric)
            if stat is None or stat.mean is None:
                continue
            metrics = observed.get(slice_name)
            if metrics is None or getattr(metrics, metric).value is None:
                missing.append(f"{slice_name}:{metric} missing from the run (baseline {stat.mean:.4f})")
            else:
                compared.add(slice_name)
    detail = [
        f"{o.slice}:{o.metric} {o.observed:.4f} < {o.threshold:.4f} (baseline {o.baseline_mean:.4f})" for o in offenders
    ] + missing
    if not compared:
        detail.append("no category slice was compared")
    return CheckResult(
        name=name,
        passed=not offenders and not missing and bool(compared),
        detail=detail,
        measures={"categories_compared": float(len(compared))},
    )


def latency_budget_check(output: RunOutput, budgets: LatencyBudgets, check: LatencyBudgetSpec, reference: RunOutput | None = None) -> CheckResult:
    """Every stage p95 with a budget in the profile, and the retrieval total p95, stay within budget; with a reference run every stage
    p95 also stays within that run's latency noise band (reference p95 x (1 + tolerance_ratio) + tolerance_ms). Unmeasured latency fails."""
    latency = output.report.latency or {}
    if RETRIEVAL_TOTAL not in latency:
        return CheckResult(name=check.name, passed=False, detail=["stage latency was not measured"])
    profile = budgets.profiles.get(check.profile)
    if profile is None:
        return CheckResult(name=check.name, passed=False, detail=[f"no {check.profile} profile in {check.budgets}"])
    detail: list[str] = []
    measures: dict[str, float | None] = {}
    for stage, stat in sorted(latency.items()):
        measures[f"{stage}.p95_ms"] = stat.p95_ms
        budget = profile.total_p95_ms if stage == RETRIEVAL_TOTAL else profile.stages.get(stage)
        if budget is not None and stat.p95_ms > budget:
            detail.append(f"{stage} p95 {stat.p95_ms:.1f} ms > {check.profile} budget {budget:.1f} ms")
    if check.against is not None:
        if reference is None:
            detail.append(f"reference run {check.against} has no output")
        else:
            before = reference.report.latency or {}
            if RETRIEVAL_TOTAL not in before:
                detail.append(f"stage latency of {check.against} was not measured")
            for stage in sorted(set(before) | set(latency)):
                if stage not in latency or stage not in before:
                    detail.append(f"{stage} is measured in only one of this run and {check.against}")
                    continue
                allowed = before[stage].p95_ms * (1 + check.tolerance_ratio) + check.tolerance_ms
                if latency[stage].p95_ms > allowed:
                    detail.append(
                        f"{stage} p95 {latency[stage].p95_ms:.1f} ms > {allowed:.1f} ms ({check.against} p95 {before[stage].p95_ms:.1f} ms)"
                    )
    return CheckResult(name=check.name, passed=not detail, detail=detail, measures=measures)


def gate_check(output: RunOutput, baseline: Baseline, noise: NoiseConfig) -> CheckResult:
    """The CI gate as it runs on this report: the noise band on the gated slices plus the absolute-zero offenders (D-14, A-13)."""
    gate = evaluate_gate(output.report, baseline, noise)
    detail = [*gate.mismatches] + [
        f"{o.slice}:{o.metric} {o.observed:.4f} vs threshold {o.threshold:.4f} ({o.kind}{', ' + o.reason if o.reason else ''})"
        for o in gate.offenders
    ]
    return CheckResult(name="gate", passed=gate.passed, detail=detail)


def default_env_command_runner(argv: list[str], env: dict[str, str]) -> int:
    result = subprocess.run(argv, cwd=REPO_ROOT, capture_output=True, text=True, check=False, env={**os.environ, **env})
    if result.returncode != 0:
        print(f"[Phase Compare] {' '.join(argv)} exited {result.returncode}", file=sys.stderr)
        print(_tail(result.stdout + "\n" + result.stderr), file=sys.stderr)
    return result.returncode


def _switch_run_config(run: SwitchRun) -> dict[str, Any]:
    if run.base is None:
        return {"name": run.name, "env": {}, "overrides": None}
    return materialise_run_config(RunSpec(name=run.name, base=run.base, fixture_mode=run.fixture_mode, env=dict(run.env)), [])


def run_switch_comparison(
    spec: SwitchComparisonSpec | Path,
    out: Path,
    runner: Runner = default_runner,
    commands: EnvCommandRunner = default_env_command_runner,
) -> SwitchComparison:
    if not isinstance(spec, SwitchComparisonSpec):
        spec = _read_model(SwitchComparisonSpec, str(spec), "comparison spec")
    noise = _read_model(NoiseConfig, spec.noise, "noise config")
    baselines = {mode: _read_model(Baseline, path, f"{mode} baseline") for mode, path in spec.baselines.items()}
    out_dir = Path(out)
    harness_dir = out_dir / HARNESS_DIR
    command_cache: dict[tuple[str, tuple[tuple[str, str], ...]], int] = {}
    results: list[SwitchRunResult] = []
    outputs_by_name: dict[str, RunOutput] = {}
    for run in spec.runs:
        print(f"[Phase Compare] run {run.name} ({run.fixture_mode})", file=sys.stderr)
        run_config = _switch_run_config(run)
        output = runner(
            RunRequest(
                name=run.name,
                run_config=run_config,
                fixture_mode=run.fixture_mode,
                out_dir=harness_dir / run.name,
                process_env=dict(run.switches),
                harness_flags=tuple(run.harness_flags),
            )
        )
        outputs_by_name[run.name] = output
        baseline = baselines[run.fixture_mode]
        checks: list[CheckResult] = []
        for check in run.checks:
            if isinstance(check, AbsoluteZeroSpec):
                checks.append(absolute_zero_check(output, check.path))
            elif isinstance(check, CategoryNoiseSpec):
                checks.append(category_noise_check(output, baseline, noise, exclude=list(check.exclude)))
            elif isinstance(check, RetrievalUnchangedSpec):
                checks.append(retrieval_unchanged_check(output, baseline, noise, exclude_categories=list(check.exclude_categories)))
            elif isinstance(check, LatencyBudgetSpec):
                budgets = _read_model(LatencyBudgets, check.budgets, "latency budgets")
                reference = outputs_by_name[check.against] if check.against is not None else None
                checks.append(latency_budget_check(output, budgets, check, reference))
            elif check == "gate":
                checks.append(gate_check(output, baseline, noise))
            elif check == "report_only":
                checks.append(CheckResult(name="report_only", passed=True, detail=["reported, not gated"]))
            elif check == "paired_all_zero":
                checks.append(paired_all_zero_check(output, baseline, noise))
            elif check == "retrieval_unchanged":
                checks.append(retrieval_unchanged_check(output, baseline, noise))
            elif check == "no_slice_drop":
                checks.append(no_slice_drop_check(output, baseline, noise))
            elif check == "citation_validity":
                checks.append(citation_validity_check(output))
            else:
                argv = list(spec.commands[check])
                key = (check, tuple(sorted(run.switches.items())))
                if key not in command_cache:
                    command_cache[key] = commands(argv, dict(run.switches))
                code = command_cache[key]
                checks.append(
                    CheckResult(name=check, passed=code == 0, detail=[] if code == 0 else [f"{' '.join(argv)} exited {code}"])
                )
        report = output.report
        results.append(
            SwitchRunResult(
                name=run.name,
                fixture_mode=run.fixture_mode,
                switches=dict(run.switches),
                harness_flags=list(run.harness_flags),
                run_config_hash=report.run_config_hash,
                overall=report.overall,
                invalid_citation_rate=report.invalid_citation_rate.value if report.invalid_citation_rate is not None else None,
                citation_coverage=report.citation_coverage.value if report.citation_coverage is not None else None,
                run_config_env=dict(run_config["env"]) if run.base is not None else None,
                injection=report.injection,
                passed=all(check.passed for check in checks),
                checks=checks,
            )
        )
    comparison = SwitchComparison(
        phase=spec.phase,
        passed=bool(results) and all(result.passed for result in results),
        noise_floor=noise.floor,
        noise_k=noise.k,
        runs=results,
        notes=[spec.fixture_note or SWITCH_FIXTURE_NOTE, SWITCH_DEFAULTS_NOTE, *spec.notes],
    )
    payload = comparison.model_dump(mode="json")
    for run_payload in payload["runs"]:
        for optional in ("run_config_env", "injection"):
            if run_payload.get(optional) is None:
                run_payload.pop(optional, None)
    _write_text(out_dir / JSON_NAME, json.dumps(payload, sort_keys=True, indent=2) + "\n")
    _write_text(out_dir / MARKDOWN_NAME, render_switch_markdown(comparison))
    return comparison


def _injection_lines(block: InjectionReport | None) -> list[str]:
    if block is None:
        return []
    lines = [
        (
            f"Injection ({block.config_label}, {block.gate}): {block.items} item(s), "
            f"rules false positives {block.rules_false_positive_count}."
        ),
        "",
        "| Slice | Exposure | Attack success | n |",
        "|---|---|---|---|",
    ]
    for key in sorted(set(block.exposure_rate) | set(block.attack_success_rate)):
        exposure = block.exposure_rate.get(key)
        success = block.attack_success_rate.get(key)
        n = (success or exposure).n if (success or exposure) is not None else 0
        lines.append(
            f"| {key} | {_num(exposure.value if exposure else None)} | {_num(success.value if success else None)} | {n} |"
        )
    return [*lines, ""]


def render_switch_markdown(c: SwitchComparison) -> str:
    lines = [
        f"# Phase {c.phase} comparison",
        "",
        f"Result: {_verdict(c.passed)}",
        "",
        (
            f"Noise band: max({c.noise_k:g} x baseline spread, {c.noise_floor:g}) on Recall@5, Recall@10 and MRR over the overall, "
            "every language and every category slice. Paired differences are against the committed baseline of the run's fixture mode."
        ),
        "",
        "## Notes",
        "",
        *[f"- {note}" for note in c.notes],
        "",
        "## Runs",
    ]
    for r in c.runs:
        o = r.overall
        switches = ", ".join(f"{k}={v}" for k, v in sorted(r.switches.items())) or "none"
        lines += [
            "",
            f"### {r.name}",
            "",
            f"Fixture mode: {r.fixture_mode}. Result: {_verdict(r.passed)}.",
            "",
            f"Switches: {switches}. Harness flags: {' '.join(r.harness_flags) or 'none'}.",
            "",
            *(
                [f"Run-config env: {', '.join(f'{k}={v}' for k, v in sorted(r.run_config_env.items())) or 'none'}.", ""]
                if r.run_config_env is not None
                else []
            ),
            *_injection_lines(r.injection),
            (
                f"Recall@5 {_num(o.recall_at_5.value)}, Recall@10 {_num(o.recall_at_10.value)}, MRR {_num(o.mrr.value)}, "
                f"correct refusal {_num(o.correct_refusal_rate.value)}, false refusal {_num(o.false_refusal_rate.value)}, "
                f"invalid citation rate {_num(r.invalid_citation_rate)}, citation coverage {_num(r.citation_coverage)}."
            ),
            "",
            "| Check | Result | Detail |",
            "|---|---|---|",
        ]
        for check in r.checks:
            detail = "; ".join(check.detail) or "-"
            lines.append(f"| {check.name} | {_verdict(check.passed)} | {detail} |")
    return "\n".join(lines) + "\n"


# ---------- schema 3: per-switch arms (Phase 3.2 D-46)
#
# Each arm is two runs over the same fixture that differ only in one switch (off and on). The arm is judged on the slices it is meant
# to move, by the paired difference on in against off, and fails when its on-run drops any gated slice beyond the noise band.

ARM_METRICS: tuple[str, ...] = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
ARM_JSON_NAME = "comparison.json"
ARM_MARKDOWN_NAME = "comparison.md"
ARM_SLICE_KINDS = ("overall", "language:", "category:", "pair:")
FIXTURE_EMBEDDER_PREFIX = "fixture"
ARM_WIRING_PROOF = (
    "wiring proof: fixture corpus, fixture embedder and fakes; the numbers prove each comparison runs end to end, not that a switch "
    "helps or hurts, so no recommendation is given"
)
ARM_NOT_RUN = "the arm has no off and on runs"
ArmStatus = Literal["passed", "failed", "not_run"]
ArmSide = Literal["ingestion", "query"]
ArmRunner = Literal["smoke", "translation"]
Direction = Literal["up", "down", "none", "no data"]


class ArmSpec(_Model):
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    switch: str
    off: str = Field(min_length=1)
    on: str = Field(min_length=1)
    side: ArmSide
    fixture_mode: FixtureMode = "ingest"
    runner: ArmRunner = "smoke"
    judged: list[str] = Field(min_length=1)
    optional: bool = False
    description: str = Field(min_length=1)

    @model_validator(mode="after")
    def _arm(self) -> ArmSpec:
        _validate_switches(self.name, {self.switch: self.on}, "switch")
        if self.off == self.on:
            raise ValueError(f"arm {self.name}: off and on are the same value")
        if len(set(self.judged)) != len(self.judged):
            raise ValueError(f"arm {self.name}: judged slices must be unique")
        return self


class ArmComparisonSpec(_Model):
    schema_version: Literal[3]
    phase: str = Field(pattern=r"^\d{2}(\.\d+)*$")
    noise: str
    live_checks: str = Field(pattern=r"^\d{2}(\.\d+)*-\d{2,3}$")
    item_groups: dict[str, str] = Field(default_factory=dict)
    arms: list[ArmSpec] = Field(min_length=1)
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _references(self) -> ArmComparisonSpec:
        names = [arm.name for arm in self.arms]
        if len(names) != len(set(names)):
            raise ValueError("arm names must be unique")
        for group, pattern in self.item_groups.items():
            if not CATEGORY_NAME.match(group) or f"{group}:" in ARM_SLICE_KINDS:
                raise ValueError(f"item group {group!r} must be a lowercase name that is not a slice kind")
            try:
                re.compile(pattern)
            except re.error as exc:
                raise ValueError(f"item group {group}: {exc}") from exc
        kinds = (*ARM_SLICE_KINDS, *(f"{group}:" for group in self.item_groups))
        for arm in self.arms:
            for judged in arm.judged:
                if judged != "overall" and not any(judged.startswith(kind) for kind in kinds if kind != "overall"):
                    raise ValueError(f"arm {arm.name}: judged slice {judged!r} is not one of {', '.join(kinds)}")
        return self


class ArmSliceRow(_Model):
    slice: str
    metric: str
    n: int = Field(ge=0)
    off: float | None
    on: float | None
    paired: PairedStat
    band: float
    beyond_band: bool
    direction: Direction


class ArmRunIds(_Model):
    off: str | None
    on: str | None


class ArmResult(_Model):
    name: str
    switch: str
    off_value: str
    on_value: str
    side: ArmSide
    fixture_mode: FixtureMode
    optional: bool
    status: ArmStatus
    judged_slices: list[str]
    rows: list[ArmSliceRow]
    failures: list[str]
    wiring_proof: bool
    recommendation: str | None
    notes: list[str] = Field(default_factory=list)
    runs: ArmRunIds | None = None
    gated_rows: list[ArmSliceRow] = Field(default_factory=list)


class ArmComparison(_Model):
    schema_version: Literal[3] = 3
    phase: str
    passed: bool
    wiring_proof: bool
    label: str | None
    band: float
    live_checks: str
    arms: list[ArmResult]
    notes: list[str]


@dataclass(frozen=True)
class ArmRun:
    """One run of an arm: its scored items and the embedder that produced them."""

    items: list[ItemResult]
    embedder_id: str | None = None
    run_id: str | None = None


def _arm_members(items: list[ItemResult], groups: Mapping[str, re.Pattern[str]]) -> dict[str, list[ItemResult]]:
    members: dict[str, list[ItemResult]] = {"overall": list(items)}
    for item in items:
        members.setdefault(f"language:{item.language}", []).append(item)
        members.setdefault(f"category:{item.category}", []).append(item)
        if item.category == CROSS_LINGUAL and item.evidence_language is not None:
            members.setdefault(f"pair:{language_pair_key(item.language, item.evidence_language)}", []).append(item)
        for group, pattern in groups.items():
            if pattern.search(item.item_id):
                members.setdefault(f"{group}:{item.language}", []).append(item)
    return members


def _judged(slice_name: str, judged: list[str]) -> bool:
    return any(slice_name == entry or (entry.endswith(":") and slice_name.startswith(entry)) for entry in judged)


def _arm_mean(values: list[float]) -> float | None:
    return round(math.fsum(values) / len(values), 6) if values else None


def _paired_cell(members: list[ItemResult], on_by_id: Mapping[str, ItemResult], metric: str) -> tuple[list[float], list[float], list[float]]:
    offs: list[float] = []
    ons: list[float] = []
    differences: list[float] = []
    for item in members:
        other = on_by_id.get(item.item_id)
        if other is None:
            continue
        off_value = item_metrics(item)[metric]
        on_value = item_metrics(other)[metric]
        if off_value is None or on_value is None:
            continue
        offs.append(off_value)
        ons.append(on_value)
        differences.append(on_value - off_value)
    return offs, ons, differences


def _direction(stat: PairedStat, higher_is_better: bool) -> Direction:
    if stat.n == 0 or stat.mean_d is None:
        return "no data"
    if stat.mean_d == 0:
        return "none"
    better = stat.mean_d > 0 if higher_is_better else stat.mean_d < 0
    return "up" if better else "down"


def _rounded(stat: PairedStat) -> PairedStat:
    return stat if stat.mean_d is None else stat.model_copy(update={"mean_d": round(stat.mean_d, 6)})


def _arm_recommendation(rows: list[ArmSliceRow], failures: list[str]) -> str:
    if failures:
        return "Keep the switch off: its on-run drops a gated slice beyond the noise band (" + "; ".join(failures) + ")."
    gains = sorted({f"{row.slice}:{row.metric}" for row in rows if row.beyond_band and row.direction == "up"})
    if gains:
        return "The on-run improves beyond the noise band on " + ", ".join(gains) + " with no gated slice dropping."
    return "No judged slice moves beyond the noise band; the switch shows no measurable effect on these items."


def compare_arm(
    arm: ArmSpec,
    off: ArmRun | None,
    on: ArmRun | None,
    noise: NoiseConfig,
    *,
    item_groups: Mapping[str, str] | None = None,
) -> ArmResult:
    """Paired on-minus-off differences on the arm's judged slices, and a failure for every gated slice the on-run drops beyond the band.

    Judged rows use every item of the slice (a report-only item is shown, never gated); the drop check uses only the items that count
    in gated slices (native_review) and the gated slice prefixes of the noise config. The band is the noise floor: an arm compares two
    single runs, so there is no run-to-run spread to widen it."""
    base = {
        "name": arm.name,
        "switch": arm.switch,
        "off_value": arm.off,
        "on_value": arm.on,
        "side": arm.side,
        "fixture_mode": arm.fixture_mode,
        "optional": arm.optional,
        "judged_slices": list(arm.judged),
    }
    if off is None or on is None:
        if arm.optional:
            return ArmResult(**base, status="not_run", rows=[], failures=[], wiring_proof=False, recommendation=None, notes=["not run"])
        return ArmResult(**base, status="failed", rows=[], failures=[ARM_NOT_RUN], wiring_proof=False, recommendation=None)
    band = noise.floor
    groups = {name: re.compile(pattern) for name, pattern in (item_groups or {}).items()}
    wiring_proof = any(
        run.embedder_id is not None and run.embedder_id.startswith(FIXTURE_EMBEDDER_PREFIX) for run in (off, on)
    )
    on_by_id = {item.item_id: item for item in on.items}
    off_ids = {item.item_id for item in off.items}
    notes: list[str] = []
    missing = sorted(off_ids - set(on_by_id))
    extra = sorted(set(on_by_id) - off_ids)
    if missing or extra:
        notes.append(f"{len(missing)} item(s) only in the off-run and {len(extra)} only in the on-run are left out of every pair")

    rows: list[ArmSliceRow] = []
    members = _arm_members(off.items, groups)
    for slice_name in sorted(members):
        if not _judged(slice_name, arm.judged):
            continue
        for metric in ARM_METRICS:
            offs, ons, differences = _paired_cell(members[slice_name], on_by_id, metric)
            if not differences:
                continue
            stat = _rounded(_stat(differences))
            higher = noise.metrics.get(metric, "higher") == "higher"
            rows.append(
                ArmSliceRow(
                    slice=slice_name,
                    metric=metric,
                    n=len(differences),
                    off=_arm_mean(offs),
                    on=_arm_mean(ons),
                    paired=stat,
                    band=band,
                    beyond_band=stat.mean_d is not None and abs(stat.mean_d) > band,
                    direction=_direction(stat, higher),
                )
            )
    judged_seen = {row.slice for row in rows}
    for judged in arm.judged:
        if not any(_judged(name, [judged]) for name in judged_seen):
            notes.append(f"judged slice {judged} has no paired item in these runs")

    failures: list[str] = []
    gated_rows: list[ArmSliceRow] = []
    counting = [item for item in off.items if counts_in_gated_slices(item)]
    counting_on = {item.item_id: item for item in on.items if counts_in_gated_slices(item)}
    for slice_name, slice_items in sorted(_arm_members(counting, {}).items()):
        if not is_gated_slice(slice_name, noise):
            continue
        for metric in ARM_METRICS:
            offs, ons, differences = _paired_cell(slice_items, counting_on, metric)
            if not differences:
                continue
            mean_d = math.fsum(differences) / len(differences)
            higher = noise.metrics.get(metric, "higher") == "higher"
            stat = _rounded(_stat(differences))
            gated_rows.append(
                ArmSliceRow(
                    slice=slice_name,
                    metric=metric,
                    n=len(differences),
                    off=_arm_mean(offs),
                    on=_arm_mean(ons),
                    paired=stat,
                    band=band,
                    beyond_band=abs(mean_d) > band + RATE_TOLERANCE,
                    direction=_direction(stat, higher),
                )
            )
            drop = -mean_d if higher else mean_d
            if drop > band + RATE_TOLERANCE:
                failures.append(f"{slice_name}:{metric} dropped by {drop:.4f} (band {band:g}, n={len(differences)})")
    return ArmResult(
        **base,
        status="failed" if failures else "passed",
        rows=rows,
        failures=failures,
        wiring_proof=wiring_proof,
        recommendation=None if wiring_proof else _arm_recommendation(rows, failures),
        notes=notes,
        runs=ArmRunIds(off=off.run_id, on=on.run_id),
        gated_rows=gated_rows,
    )


def build_arm_comparison(
    spec: ArmComparisonSpec, runs: Mapping[str, tuple[ArmRun, ArmRun]], noise: NoiseConfig
) -> ArmComparison:
    unknown = sorted(set(runs) - {arm.name for arm in spec.arms})
    if unknown:
        raise ComparisonError(f"runs name unknown arms: {', '.join(unknown)}")
    results = [
        compare_arm(arm, *(runs.get(arm.name) or (None, None)), noise, item_groups=spec.item_groups) for arm in spec.arms
    ]
    ran = [result for result in results if result.status != "not_run"]
    wiring_proof = any(result.wiring_proof for result in ran)
    notes = [
        f"Paired difference is the on-run minus the off-run, item by item; the band is the noise floor ({noise.floor:g}).",
        f"Real observations come from the live checks of plan {spec.live_checks}; a fixture comparison is never a reason to flip a default.",
        *spec.notes,
    ]
    return ArmComparison(
        phase=spec.phase,
        passed=all(result.status != "failed" for result in results),
        wiring_proof=wiring_proof,
        label=ARM_WIRING_PROOF if wiring_proof else None,
        band=noise.floor,
        live_checks=spec.live_checks,
        arms=results,
        notes=notes,
    )


def _arm_status(status: ArmStatus) -> str:
    return {"passed": "PASS", "failed": "FAIL", "not_run": "not run"}[status]


def render_arm_markdown(c: ArmComparison) -> str:
    lines = [f"# Phase {c.phase} per-switch comparison", ""]
    if c.label:
        lines += [f"> {c.label}", ""]
    lines += [f"Result: {_verdict(c.passed)}", "", "## Notes", "", *[f"- {note}" for note in c.notes], "", "## Arms"]
    for arm in c.arms:
        lines += [
            "",
            f"### {arm.name}",
            "",
            f"Switch: `{arm.switch}` {arm.off_value} (off) against {arm.on_value} (on); {arm.side}-side, fixture mode {arm.fixture_mode}"
            f"{', optional' if arm.optional else ''}. Result: {_arm_status(arm.status)}.",
            "",
            f"Judged on: {', '.join(arm.judged_slices)}.",
            "",
        ]
        if arm.status == "not_run":
            lines += ["This optional arm was not run.", ""]
            continue
        if arm.failures == [ARM_NOT_RUN]:
            lines += ["This required arm did not run, so it fails the comparison.", ""]
            continue
        if arm.wiring_proof:
            lines += ["Wiring proof only: no recommendation.", ""]
        if arm.rows:
            lines += ["| Slice | Metric | n | Off | On | Paired diff | 95% CI | Beyond band | Direction |", "|---|---|---:|---:|---:|---:|---|---|---|"]
            for row in arm.rows:
                interval = f"[{_num(row.paired.ci_low)}, {_num(row.paired.ci_high)}]"
                lines.append(
                    f"| {row.slice} | {row.metric} | {row.n} | {_num(row.off)} | {_num(row.on)} | {_num(row.paired.mean_d)} | {interval} | "
                    f"{'yes' if row.beyond_band else 'no'} | {row.direction} |"
                )
            lines.append("")
        else:
            lines += ["No judged slice had a paired item.", ""]
        if arm.failures:
            lines += ["Gated slices that dropped beyond the band (this arm fails its comparison):", "", *[f"- {failure}" for failure in arm.failures], ""]
        else:
            lines += ["No gated slice dropped beyond the band.", ""]
        if arm.recommendation:
            lines += [f"Recommendation: {arm.recommendation}", ""]
        lines += [f"- {note}" for note in arm.notes]
        if arm.notes:
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def load_arm_run(path: Path) -> ArmRun:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        raise ComparisonError(f"{path}: not an eval report (no items)")
    embedder = raw.get("embedder_id")
    run_id = raw.get("run_id")
    return ArmRun(
        items=[ItemResult.model_validate(item) for item in raw["items"]],
        embedder_id=embedder if isinstance(embedder, str) else None,
        run_id=run_id if isinstance(run_id, str) else None,
    )


def run_arm_comparison(spec: ArmComparisonSpec | Path, runs_manifest: Path, out: Path) -> ArmComparison:
    """runs_manifest: {"<arm>": {"off": "<report.json>", "on": "<report.json>"}}; an arm left out is not run."""
    if not isinstance(spec, ArmComparisonSpec):
        spec = _read_model(ArmComparisonSpec, str(spec), "comparison spec")
    noise = _read_model(NoiseConfig, spec.noise, "noise config")
    manifest = _read_json(str(runs_manifest), "arm runs")
    runs: dict[str, tuple[ArmRun, ArmRun]] = {}
    for name, entry in manifest.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("off"), str) or not isinstance(entry.get("on"), str):
            raise ComparisonError(f"arm runs: {name} needs off and on report paths")
        try:
            runs[name] = (load_arm_run(resolve_cli_path(entry["off"])), load_arm_run(resolve_cli_path(entry["on"])))
        except (OSError, ValueError, ValidationError) as exc:
            raise ComparisonError(f"arm runs: {name}: {exc}") from exc
    comparison = build_arm_comparison(spec, runs, noise)
    out_dir = Path(out)
    _write_text(out_dir / ARM_JSON_NAME, comparison.model_dump_json(indent=2) + "\n")
    _write_text(out_dir / ARM_MARKDOWN_NAME, render_arm_markdown(comparison))
    return comparison


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _schema_version(path: Path) -> int | None:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload.get("schema_version") if isinstance(payload, dict) else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rag_eval.phase_compare", description="Phase comparison against the baseline (schema 1: Phase 4 D-28; schema 2: switch runs; schema 3: per-switch arms)"
    )
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--runs", type=Path, help="schema 3 only: JSON mapping each arm to its off and on report.json")
    args = parser.parse_args(argv)
    try:
        spec_path = resolve_cli_path(args.spec)
        if _schema_version(spec_path) == 3:
            if args.runs is None:
                raise ComparisonError("a schema-3 spec needs --runs")
            result = run_arm_comparison(spec_path, resolve_cli_path(args.runs), resolve_cli_path(args.out))
        elif _schema_version(spec_path) == 2:
            result = run_switch_comparison(spec_path, resolve_cli_path(args.out), runner=default_runner, commands=default_env_command_runner)
        else:
            result = run_phase_comparison(spec_path, resolve_cli_path(args.out), runner=default_runner, commands=default_command_runner)
    except ComparisonError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_HARNESS
    out_dir = repo_relative(resolve_cli_path(args.out))
    print(f"[Phase Compare] {_verdict(result.passed)}: {out_dir}/{JSON_NAME}")
    return EXIT_PASS if result.passed else EXIT_FAIL


if __name__ == "__main__":
    raise SystemExit(main())
