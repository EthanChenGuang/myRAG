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
from rag_sidecar.contracts.baseline import Baseline, GateOffender, GateResult, NoiseConfig
from rag_sidecar.contracts.cache import CachePairsRun
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport, InjectionReport, ItemResult, SliceMetrics
from rag_sidecar.contracts.retrieval import ChunkingDecision, ChunkingSweepReport

from rag_eval.calibrate.cache import DEFAULT_MAX_DISTANCE, NEAR_MISS, CalibrationError, effective_threshold, hits_at, load_pairs, read_config
from rag_eval.calibrate.refusal import IMAGE_FLOOR, CalibrationResult, CrossComparison, _best_dense, _gate_decided, fit_threshold
from rag_eval.gate import evaluate_gate
from rag_eval.golden_io import load_golden
from rag_eval.harness_runner import HARNESS_SCRIPT, TAIL_LINES, HarnessError, Spawner, _tail, default_spawner
from rag_eval.metrics import CLAUSE_TAG, CROSS_LINGUAL
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.profile_compare import baseline_from_report
from rag_eval.report import _latency_stat, _retrieval_total, cache_outcome
from rag_eval.sweep.chunking import CLAUSE_SLICE, GENERAL_DOC_TYPE, LEGACY_ID, _profiles_for, ingest_doc_types, parse_presets
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


def _spawn_harness(request: RunRequest, spawner: Spawner | None) -> Path:
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
    return out_dir


def default_runner(request: RunRequest, spawner: Spawner | None = None) -> RunOutput:
    """One in-process smoke run over the default golden files of its fixture mode; scoring only, the gate runs here."""
    out_dir = _spawn_harness(request, spawner)
    try:
        report = EvalReport.model_validate_json((out_dir / "report.json").read_text(encoding="utf-8"))
        traces = load_traces(out_dir / "traces.jsonl")
        golden = load_golden(resolve_cli_path(load_manifest(out_dir / "run.json").golden_path))
    except (OSError, ValidationError, ValueError) as exc:
        raise HarnessError(f"run {request.name}: harness output in {out_dir} is unreadable: {exc}", exit_code=0) from exc
    return RunOutput(report=report, traces=traces, golden=golden)


def default_pairs_runner(request: RunRequest, spawner: Spawner | None = None) -> CachePairsOutput:
    """D-37 cache-pair run (--cache-pairs): fresh fixture database, anchors stored, candidates checked at the probe distance."""
    out_dir = _spawn_harness(request, spawner)
    try:
        pairs = load_pairs(out_dir / "cache-pairs.json")
        traces = load_traces(out_dir / "traces.jsonl")
        manifest = load_manifest(out_dir / "run.json")
    except (OSError, ValidationError, ValueError, CalibrationError) as exc:
        raise HarnessError(f"run {request.name}: cache-pair output in {out_dir} is unreadable: {exc}", exit_code=0) from exc
    return CachePairsOutput(pairs=pairs, traces=traces, run_config_hash=manifest.run_config_hash)


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


SLICE_NAME = re.compile(r"^(overall|language:[a-z][a-zA-Z-]*|category:[a-z][a-z0-9_]*)$")
HOLD_METRICS = (*RETRIEVAL_METRICS, "correct_refusal_rate", "false_refusal_rate")
CACHE_PAIRS_FLAG = "--cache-pairs"
CACHE_CALIBRATION = "eval/config/semantic-cache.json"


class EqualRunsSpec(_Model):
    """D-42 a, e: item by item, this run's outputs equal those of an earlier item run on the same data."""

    kind: Literal["equal_runs"]
    reference: str

    @property
    def name(self) -> str:
        return f"equal_runs:{self.reference}"


class SliceHoldSpec(_Model):
    """D-42 b: the named slices hold or improve against an earlier item run, and no overall, language or category slice moves
    beyond the noise band on Recall@5, Recall@10, MRR, correct refusal or false refusal."""

    kind: Literal["slice_hold"]
    reference: str
    slices: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _slices(self) -> SliceHoldSpec:
        for name in self.slices:
            if not SLICE_NAME.match(name):
                raise ValueError(f"slice_hold: {name!r} is not an overall, language: or category: slice")
        if len(set(self.slices)) != len(self.slices):
            raise ValueError("slice_hold: slices must be unique")
        return self

    @property
    def name(self) -> str:
        return f"slice_hold:{self.reference}"


class CacheLatencySpec(_Model):
    """D-42 e: on a cache-pair run, hit p95 retrieval latency is at most max_ratio of miss p95."""

    kind: Literal["cache_latency"]
    max_ratio: float = Field(default=0.5, gt=0, le=1)

    @property
    def name(self) -> str:
        return "cache_latency"


class NearMissZeroSpec(_Model):
    """D-42 e: on a cache-pair run, no near-miss pair hits at the distance the app uses for the run's embedding profile."""

    kind: Literal["near_miss_zero"]
    calibration: str = CACHE_CALIBRATION
    default_distance: float = Field(default=DEFAULT_MAX_DISTANCE, gt=0, le=2)

    @property
    def name(self) -> str:
        return "near_miss_zero"


ITEM_RUN_SPECS = (AbsoluteZeroSpec, CategoryNoiseSpec, RetrievalUnchangedSpec, EqualRunsSpec, SliceHoldSpec)
CACHE_PAIR_SPECS = (CacheLatencySpec, NearMissZeroSpec)
CheckSpec = Annotated[
    AbsoluteZeroSpec | CategoryNoiseSpec | RetrievalUnchangedSpec | EqualRunsSpec | SliceHoldSpec | CacheLatencySpec | NearMissZeroSpec,
    Field(discriminator="kind"),
]
AnyCheckSpec = AbsoluteZeroSpec | CategoryNoiseSpec | RetrievalUnchangedSpec | EqualRunsSpec | SliceHoldSpec | CacheLatencySpec | NearMissZeroSpec


def check_name(check: str | AnyCheckSpec) -> str:
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
    cache_pairs: bool = False
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
        specs = [check for check in self.checks if not isinstance(check, str)]
        if self.cache_pairs:
            if self.harness_flags:
                raise ValueError(f"run {self.name}: a cache-pair run takes no harness flags")
            if self.base is None:
                raise ValueError(f"run {self.name}: a cache-pair run needs a base run config with the query layer on")
            misplaced = [check.name for check in specs if not isinstance(check, CACHE_PAIR_SPECS)]
            builtin = [check for check in self.checks if isinstance(check, str) and check in BUILTIN_CHECKS and check != "report_only"]
            if misplaced or builtin:
                raise ValueError(f"run {self.name}: {', '.join(misplaced + builtin)} need(s) an item run, not a cache-pair run")
        else:
            misplaced = [check.name for check in specs if isinstance(check, CACHE_PAIR_SPECS)]
            if misplaced:
                raise ValueError(f"run {self.name}: {', '.join(misplaced)} need(s) a cache-pair run")
        return self


class VerdictSpec(_Model):
    """One row of the verdict table: passes when every named `run/check` passed."""

    label: str = Field(pattern=r"^[a-z0-9]{1,8}$")
    title: str = Field(min_length=1, max_length=200)
    checks: list[str] = Field(min_length=1)


class SwitchComparisonSpec(_Model):
    schema_version: Literal[2]
    phase: str = Field(pattern=r"^\d{2}(\.\d+)*$")
    noise: str
    baselines: dict[FixtureMode, str]
    runs: list[SwitchRun] = Field(min_length=1)
    commands: dict[str, list[str]] = Field(default_factory=dict)
    fixture_note: str | None = None
    notes: list[str] = Field(default_factory=list)
    verdicts: list[VerdictSpec] = Field(default_factory=list)

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
        earlier: dict[str, SwitchRun] = {}
        for run in self.runs:
            for check in run.checks:
                if isinstance(check, (EqualRunsSpec, SliceHoldSpec)):
                    reference = earlier.get(check.reference)
                    if reference is None:
                        raise ValueError(f"run {run.name}: {check.name} must name an earlier run")
                    if reference.cache_pairs or reference.fixture_mode != run.fixture_mode:
                        raise ValueError(f"run {run.name}: {check.name} must name an item run of fixture mode {run.fixture_mode}")
            earlier[run.name] = run
        labels = [verdict.label for verdict in self.verdicts]
        if len(set(labels)) != len(labels):
            raise ValueError("verdict labels must be unique")
        checks_by_run = {run.name: {check_name(check) for check in run.checks} for run in self.runs}
        for verdict in self.verdicts:
            for ref in verdict.checks:
                run_name, _, check = ref.partition("/")
                if not check or check not in checks_by_run.get(run_name, set()):
                    raise ValueError(f"verdict {verdict.label}: {ref!r} is not a run/check of this spec")
        return self


class CheckResult(_Model):
    name: str
    passed: bool
    detail: list[str] = Field(default_factory=list)
    measures: dict[str, float | None] = Field(default_factory=dict)


class CachePairsSummary(_Model):
    pairs: int = Field(ge=0)
    probe_max_distance: float
    embedding_profile_id: str | None
    traces: int = Field(ge=0)


class SwitchRunResult(_Model):
    name: str
    fixture_mode: FixtureMode
    switches: dict[str, str]
    harness_flags: list[str]
    run_config_hash: str
    overall: SliceMetrics | None = None
    invalid_citation_rate: float | None
    citation_coverage: float | None
    run_config_env: dict[str, str] | None = None
    injection: InjectionReport | None = None
    cache_pairs: CachePairsSummary | None = None
    passed: bool
    checks: list[CheckResult]


class VerdictResult(_Model):
    label: str
    title: str
    passed: bool
    checks: list[str]
    failed: list[str]


class SwitchComparison(_Model):
    schema_version: Literal[2] = 2
    phase: str
    passed: bool
    noise_floor: float
    noise_k: float
    runs: list[SwitchRunResult]
    notes: list[str]
    verdicts: list[VerdictResult] = Field(default_factory=list)


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


def gate_check(output: RunOutput, baseline: Baseline, noise: NoiseConfig) -> CheckResult:
    """The CI gate as it runs on this report: the noise band on the gated slices plus the absolute-zero offenders (D-14, A-13)."""
    gate = evaluate_gate(output.report, baseline, noise)
    detail = [*gate.mismatches] + [
        f"{o.slice}:{o.metric} {o.observed:.4f} vs threshold {o.threshold:.4f} ({o.kind}{', ' + o.reason if o.reason else ''})"
        for o in gate.offenders
    ]
    return CheckResult(name="gate", passed=gate.passed, detail=detail)


# ---------- Phase 6 (D-42): run equality, slice holds, cache latency and near-miss hits

EQUAL_DATA_FIELDS = (
    "golden_sha256",
    "corpus_sha256",
    "embedder_id",
    "embedder_version",
    "embedder_source_sha256",
    "deployment_mode",
    "tier",
    "golden_filter",
)


@dataclass(frozen=True)
class CachePairsOutput:
    pairs: CachePairsRun
    traces: list[RagTrace]
    run_config_hash: str


PairsRunner = Callable[[RunRequest], CachePairsOutput]


def _item_signature(item: ItemResult, trace: RagTrace | None) -> dict[str, Any]:
    signature: dict[str, Any] = {"result": item.model_dump(mode="json")}
    if trace is not None:
        signature["kept"] = [(chunk.rank, chunk.chunk_id, chunk.document_id, chunk.kept_by) for chunk in trace.kept]
        signature["refused"] = trace.refused
        signature["refusal_reason"] = trace.refusal_reason
        signature["refusal"] = trace.refusal.model_dump(mode="json") if trace.refusal is not None else None
        signature["answer"] = trace.answer
    return signature


def _traces_by_item(traces: list[RagTrace]) -> tuple[dict[str, RagTrace], list[str]]:
    by_item: dict[str, RagTrace] = {}
    repeated: list[str] = []
    for trace in traces:
        if trace.item_id is None:
            continue
        if trace.item_id in by_item:
            repeated.append(trace.item_id)
        by_item[trace.item_id] = trace
    return by_item, sorted(set(repeated))


def equal_runs_check(output: RunOutput, reference_output: RunOutput, *, reference: str) -> CheckResult:
    """D-42: every item's scored result, kept chunks (rank, id, document, keep reason), refusal and answer equal the reference
    run's. Fails naming the first differing item in report order; a run on other data or another item set never passes."""
    name = f"equal_runs:{reference}"
    observed, recorded = output.report, reference_output.report
    detail = [
        f"{field} differs from {reference}"
        for field in EQUAL_DATA_FIELDS
        if getattr(observed, field) != getattr(recorded, field)
    ]
    if detail:
        return CheckResult(name=name, passed=False, detail=detail)
    ours, repeated = _traces_by_item(output.traces)
    theirs, repeated_ref = _traces_by_item(reference_output.traces)
    if repeated or repeated_ref:
        return CheckResult(name=name, passed=False, detail=[f"item(s) with more than one trace: {', '.join(repeated or repeated_ref)}"])
    observed_items = {item.item_id: item for item in observed.items}
    recorded_items = {item.item_id: item for item in recorded.items}
    only_ours = sorted(set(observed_items) - set(recorded_items))
    only_theirs = sorted(set(recorded_items) - set(observed_items))
    if only_ours or only_theirs:
        detail = []
        if only_theirs:
            detail.append(f"item(s) missing from this run: {', '.join(only_theirs)}")
        if only_ours:
            detail.append(f"item(s) missing from {reference}: {', '.join(only_ours)}")
        return CheckResult(name=name, passed=False, detail=detail)
    differing: list[str] = []
    first: str | None = None
    for item in observed.items:
        mine = _item_signature(item, ours.get(item.item_id))
        other = _item_signature(recorded_items[item.item_id], theirs.get(item.item_id))
        if mine == other:
            continue
        differing.append(item.item_id)
        if first is None:
            fields = sorted(key for key in set(mine) | set(other) if mine.get(key) != other.get(key))
            if "result" in fields:
                result_fields = sorted(
                    key for key, value in mine["result"].items() if other["result"].get(key) != value
                ) or ["result"]
                fields = [*(f"result.{key}" for key in result_fields), *(f for f in fields if f != "result")]
            first = f"first differing item {item.item_id}: {', '.join(fields)}"
    detail = [first] if first is not None else []
    return CheckResult(
        name=name,
        passed=not differing,
        detail=detail,
        measures={"items_compared": float(len(observed.items)), "items_differing": float(len(differing))},
    )


def _hold_noise(noise: NoiseConfig) -> NoiseConfig:
    defaults = {"correct_refusal_rate": "higher", "false_refusal_rate": "lower"}
    return noise.model_copy(
        update={
            "gated_slice_prefixes": list(SLICE_PREFIXES),
            "metrics": {metric: noise.metrics.get(metric, defaults.get(metric, "higher")) for metric in HOLD_METRICS},
        }
    )


def slice_hold_check(
    output: RunOutput, reference_output: RunOutput, noise: NoiseConfig, *, slices: list[str], reference: str
) -> CheckResult:
    """D-42 b: the gate's band arithmetic against the reference run's report (one run, so the band is the noise floor), over the
    overall, every language and every category slice on Recall@5, Recall@10, MRR, correct and false refusal. The named slices
    must be measured in both runs; their retrieval deltas are recorded."""
    name = f"slice_hold:{reference}"
    baseline = baseline_from_report(reference_output.report, tag=reference)
    aligned = baseline.model_copy(update={"request_options": output.report.request_options})
    gate = evaluate_gate(output.report, aligned, _hold_noise(noise))
    if gate.mismatches:
        return CheckResult(name=name, passed=False, detail=list(gate.mismatches))
    offenders = [o for o in gate.offenders if o.kind == "noise_band"]
    detail = [
        f"{o.slice}:{o.metric} {o.observed:.4f} {'<' if o.direction == 'higher' else '>'} {o.threshold:.4f} ({reference} {o.baseline_mean:.4f})"
        for o in offenders
    ]
    measures: dict[str, float | None] = {}
    for slice_name in slices:
        ours = _slice(output.report, slice_name)
        theirs = _slice(reference_output.report, slice_name)
        if ours is None or theirs is None:
            where = "this run" if ours is None else reference
            detail.append(f"{slice_name} is missing from {where}")
            continue
        measured = [m for m in RETRIEVAL_METRICS if getattr(ours, m).value is not None and getattr(theirs, m).value is not None]
        if not measured:
            detail.append(f"{slice_name} has no retrieval metric measured in both runs")
            continue
        for metric in measured:
            measures[f"{slice_name}:{metric}_delta"] = _delta(getattr(ours, metric).value, getattr(theirs, metric).value)
    return CheckResult(name=name, passed=not detail, detail=detail, measures=measures)


def cache_latency_check(output: CachePairsOutput, *, max_ratio: float) -> CheckResult:
    """D-42 e: the retrieval total of the pair run's cache hits against its misses (fail-open failures count as misses, bypasses
    are left out), read like the eval report's semantic_cache block. Nothing passes without both hits and misses."""
    hits: list[float] = []
    misses: list[float] = []
    for trace in output.traces:
        outcome = cache_outcome(trace)
        if outcome is None or outcome[0] == "bypass":
            continue
        total = _retrieval_total(trace)
        if total is None:
            continue
        (hits if outcome[0] == "hit" else misses).append(total)
    hit, miss = _latency_stat(hits), _latency_stat(misses)
    measures: dict[str, float | None] = {
        "hit_p50_ms": hit.p50_ms if hit else None,
        "hit_p95_ms": hit.p95_ms if hit else None,
        "hits": float(len(hits)),
        "miss_p50_ms": miss.p50_ms if miss else None,
        "miss_p95_ms": miss.p95_ms if miss else None,
        "misses": float(len(misses)),
        "max_ratio": max_ratio,
    }
    if hit is None or miss is None:
        return CheckResult(name="cache_latency", passed=False, detail=["the run measured no cache hit or no cache miss"], measures=measures)
    measures["ratio"] = hit.p95_ms / miss.p95_ms if miss.p95_ms > 0 else None
    passed = hit.p95_ms <= max_ratio * miss.p95_ms
    detail = [] if passed else [f"hit p95 {hit.p95_ms:.1f} ms > {max_ratio:g} x miss p95 {miss.p95_ms:.1f} ms"]
    return CheckResult(name="cache_latency", passed=passed, detail=detail, measures=measures)


def near_miss_zero_check(output: CachePairsOutput, spec: NearMissZeroSpec) -> CheckResult:
    """D-42 e: no near-miss pair hits at the effective distance (a calibrated entry for the run's profile, else the default),
    the distance the app checks at (src/lib/rag/cache/threshold.ts). Needs at least one near-miss pair."""
    run = output.pairs
    if run.embedding_profile_id is None:
        return CheckResult(name="near_miss_zero", passed=False, detail=["the pair run names no embedding profile"])
    try:
        config = read_config(resolve_cli_path(Path(spec.calibration)))
    except CalibrationError as exc:
        return CheckResult(name="near_miss_zero", passed=False, detail=[str(exc)])
    threshold = effective_threshold(config, run.embedding_profile_id, spec.default_distance)
    near = [pair for pair in run.pairs if pair.category == NEAR_MISS]
    wrong = [pair.pair_id for pair in near if hits_at(pair, threshold)]
    measures: dict[str, float | None] = {
        "max_distance": threshold,
        "near_miss_pairs": float(len(near)),
        "near_miss_wrong_hits": float(len(wrong)),
        "near_miss_wrong_hit_rate": len(wrong) / len(near) if near else None,
    }
    detail: list[str] = []
    if wrong:
        detail.append(f"near-miss wrong hit(s) at {threshold:g}: {', '.join(wrong)}")
    if not near:
        detail.append("the pair run has no near-miss pair")
    if run.probe_max_distance < threshold:
        detail.append(f"probe distance {run.probe_max_distance:g} is below the effective distance {threshold:g}")
    return CheckResult(name="near_miss_zero", passed=not detail, detail=detail, measures=measures)


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
    pairs_runner: PairsRunner = default_pairs_runner,
) -> SwitchComparison:
    if not isinstance(spec, SwitchComparisonSpec):
        spec = _read_model(SwitchComparisonSpec, str(spec), "comparison spec")
    noise = _read_model(NoiseConfig, spec.noise, "noise config")
    baselines = {mode: _read_model(Baseline, path, f"{mode} baseline") for mode, path in spec.baselines.items()}
    out_dir = Path(out)
    harness_dir = out_dir / HARNESS_DIR
    command_cache: dict[tuple[str, tuple[tuple[str, str], ...]], int] = {}
    results: list[SwitchRunResult] = []
    item_outputs: dict[str, RunOutput] = {}

    def command_check(run: SwitchRun, check: str) -> CheckResult:
        argv = list(spec.commands[check])
        key = (check, tuple(sorted(run.switches.items())))
        if key not in command_cache:
            command_cache[key] = commands(argv, dict(run.switches))
        code = command_cache[key]
        return CheckResult(name=check, passed=code == 0, detail=[] if code == 0 else [f"{' '.join(argv)} exited {code}"])

    for run in spec.runs:
        print(f"[Phase Compare] run {run.name} ({run.fixture_mode}{', cache pairs' if run.cache_pairs else ''})", file=sys.stderr)
        run_config = _switch_run_config(run)
        request = RunRequest(
            name=run.name,
            run_config=run_config,
            fixture_mode=run.fixture_mode,
            out_dir=harness_dir / run.name,
            process_env=dict(run.switches),
            harness_flags=(CACHE_PAIRS_FLAG,) if run.cache_pairs else tuple(run.harness_flags),
        )
        if run.cache_pairs:
            pairs_output = pairs_runner(request)
            pair_checks: list[CheckResult] = []
            for check in run.checks:
                if isinstance(check, CacheLatencySpec):
                    pair_checks.append(cache_latency_check(pairs_output, max_ratio=check.max_ratio))
                elif isinstance(check, NearMissZeroSpec):
                    pair_checks.append(near_miss_zero_check(pairs_output, check))
                elif check == "report_only":
                    pair_checks.append(CheckResult(name="report_only", passed=True, detail=["reported, not gated"]))
                else:
                    pair_checks.append(command_check(run, str(check)))
            results.append(
                SwitchRunResult(
                    name=run.name,
                    fixture_mode=run.fixture_mode,
                    switches=dict(run.switches),
                    harness_flags=list(request.harness_flags),
                    run_config_hash=pairs_output.run_config_hash,
                    invalid_citation_rate=None,
                    citation_coverage=None,
                    run_config_env=dict(run_config["env"]),
                    cache_pairs=CachePairsSummary(
                        pairs=len(pairs_output.pairs.pairs),
                        probe_max_distance=pairs_output.pairs.probe_max_distance,
                        embedding_profile_id=pairs_output.pairs.embedding_profile_id,
                        traces=len(pairs_output.traces),
                    ),
                    passed=all(check.passed for check in pair_checks),
                    checks=pair_checks,
                )
            )
            continue
        output = runner(request)
        item_outputs[run.name] = output
        baseline = baselines[run.fixture_mode]
        checks: list[CheckResult] = []
        for check in run.checks:
            if isinstance(check, EqualRunsSpec):
                checks.append(equal_runs_check(output, item_outputs[check.reference], reference=check.reference))
            elif isinstance(check, SliceHoldSpec):
                checks.append(
                    slice_hold_check(output, item_outputs[check.reference], noise, slices=list(check.slices), reference=check.reference)
                )
            elif isinstance(check, AbsoluteZeroSpec):
                checks.append(absolute_zero_check(output, check.path))
            elif isinstance(check, CategoryNoiseSpec):
                checks.append(category_noise_check(output, baseline, noise, exclude=list(check.exclude)))
            elif isinstance(check, RetrievalUnchangedSpec):
                checks.append(retrieval_unchanged_check(output, baseline, noise, exclude_categories=list(check.exclude_categories)))
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
            elif isinstance(check, str):
                checks.append(command_check(run, check))
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
    outcomes = {f"{result.name}/{check.name}": check.passed for result in results for check in result.checks}
    verdicts = [
        VerdictResult(
            label=verdict.label,
            title=verdict.title,
            passed=all(outcomes.get(ref, False) for ref in verdict.checks),
            checks=list(verdict.checks),
            failed=[ref for ref in verdict.checks if not outcomes.get(ref, False)],
        )
        for verdict in spec.verdicts
    ]
    comparison = SwitchComparison(
        phase=spec.phase,
        passed=bool(results) and all(result.passed for result in results) and all(v.passed for v in verdicts),
        noise_floor=noise.floor,
        noise_k=noise.k,
        runs=results,
        notes=[spec.fixture_note or SWITCH_FIXTURE_NOTE, SWITCH_DEFAULTS_NOTE, *spec.notes],
        verdicts=verdicts,
    )
    payload = comparison.model_dump(mode="json")
    if not payload["verdicts"]:
        payload.pop("verdicts")
    for run_payload in payload["runs"]:
        for optional in ("run_config_env", "injection", "overall", "cache_pairs"):
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


def _run_summary_line(r: SwitchRunResult) -> str:
    if r.cache_pairs is not None:
        p = r.cache_pairs
        return (
            f"Cache-pair run: {p.pairs} golden pair(s), {p.traces} trace(s), probe distance {p.probe_max_distance:g}, "
            f"embedding profile {p.embedding_profile_id or 'n/a'}."
        )
    o = r.overall
    if o is None:
        return "No item metrics."
    return (
        f"Recall@5 {_num(o.recall_at_5.value)}, Recall@10 {_num(o.recall_at_10.value)}, MRR {_num(o.mrr.value)}, "
        f"correct refusal {_num(o.correct_refusal_rate.value)}, false refusal {_num(o.false_refusal_rate.value)}, "
        f"invalid citation rate {_num(r.invalid_citation_rate)}, citation coverage {_num(r.citation_coverage)}."
    )


def _measure_lines(r: SwitchRunResult) -> list[str]:
    rows = [(check.name, key, value) for check in r.checks for key, value in sorted(check.measures.items())]
    if not rows:
        return []
    lines = ["", "| Check | Measure | Value |", "|---|---|---|"]
    lines += [f"| {name} | {key} | {_num(value)} |" for name, key, value in rows]
    return lines


def _verdict_lines(verdicts: list[VerdictResult]) -> list[str]:
    if not verdicts:
        return []
    lines = ["## Verdicts", "", "| Check | Verdict | Evidence |", "|---|---|---|"]
    for v in verdicts:
        evidence = ", ".join(f"{ref} (FAIL)" if ref in v.failed else ref for ref in v.checks)
        lines.append(f"| ({v.label}) {v.title} | {_verdict(v.passed)} | {evidence} |")
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
        *_verdict_lines(c.verdicts),
        "## Runs",
    ]
    for r in c.runs:
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
            _run_summary_line(r),
            "",
            "| Check | Result | Detail |",
            "|---|---|---|",
        ]
        for check in r.checks:
            detail = "; ".join(check.detail) or "-"
            lines.append(f"| {check.name} | {_verdict(check.passed)} | {detail} |")
        lines += _measure_lines(r)
    return "\n".join(lines) + "\n"


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
        prog="rag_eval.phase_compare", description="Phase comparison against the baseline (schema 1: Phase 4 D-28; schema 2: switch runs)"
    )
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        spec_path = resolve_cli_path(args.spec)
        if _schema_version(spec_path) == 2:
            result = run_switch_comparison(
                spec_path,
                resolve_cli_path(args.out),
                runner=default_runner,
                commands=default_env_command_runner,
                pairs_runner=default_pairs_runner,
            )
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
