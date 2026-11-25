from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from rag_sidecar.contracts.baseline import Baseline, GateOffender, GateResult, NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport, ItemResult, SliceMetrics
from rag_sidecar.contracts.retrieval import ChunkingDecision, ChunkingSweepReport

from rag_eval.calibrate.refusal import CalibrationResult, CrossComparison
from rag_eval.gate import evaluate_gate
from rag_eval.golden_io import load_golden
from rag_eval.harness_runner import HARNESS_SCRIPT, TAIL_LINES, HarnessError, _tail, default_spawner
from rag_eval.metrics import CLAUSE_TAG, CROSS_LINGUAL
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.profile_compare import baseline_from_report
from rag_eval.sweep.chunking import CLAUSE_SLICE, GENERAL_DOC_TYPE, LEGACY_ID, _profiles_for, ingest_doc_types, parse_presets
from rag_eval.traces import load_traces

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


class RefusalComparison(_Model):
    correct_refusal: float | None
    correct_refusal_n: int
    reference_correct_refusal: float | None
    improved: bool
    false_refusal: float | None
    false_refusal_n: int
    false_refusal_upper_95: float | None
    reference_false_refusal: float | None


class RecommendedCheck(_Model):
    against: str
    passed: bool
    mismatches: list[str]
    drops: list[GateOffender]
    refusal: RefusalComparison


class RecommendedResult(_Model):
    run: str
    passed: bool
    baseline: RecommendedCheck
    reference: RecommendedCheck


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


def legacy_parity_rule(runs, noise: NoiseConfig) -> LegacyParityResult:
    return LegacyParityResult(passed=False, runs=[])


def recommended_rule(output, baseline, reference, noise, *, run: str, reference_name: str) -> RecommendedResult:
    refusal = RefusalComparison(
        correct_refusal=None, correct_refusal_n=0, reference_correct_refusal=None, improved=False,
        false_refusal=None, false_refusal_n=0, false_refusal_upper_95=None, reference_false_refusal=None,
    )
    check = RecommendedCheck(against="", passed=False, mismatches=[], drops=[], refusal=refusal)
    return RecommendedResult(run=run, passed=False, baseline=check, reference=check)


def _stub_switch(on_name: str, off_name: str) -> SwitchResult:
    return SwitchResult(on=on_name, off=off_name, passed=False, failures=["not implemented"], drops=[], measures={})


def parent_child_rule(on_run: RunOutput, off_run: RunOutput, noise: NoiseConfig, *, on_name: str, off_name: str) -> SwitchResult:
    return _stub_switch(on_name, off_name)


def compression_rule(on_run: RunOutput, off_run: RunOutput, noise: NoiseConfig, *, on_name: str, off_name: str) -> SwitchResult:
    return _stub_switch(on_name, off_name)


def translation_rule(on_run: RunOutput, off_run: RunOutput, *, on_name: str, off_name: str) -> SwitchResult:
    return _stub_switch(on_name, off_name)


def iterative_scan_rule(on_run, off_run, synthetic, *, fixture_slice: str, on_name: str, off_name: str) -> IterativeScanResult:
    return IterativeScanResult(
        on=on_name, off=off_name, passed=False, failures=[], fixture_slice=fixture_slice, fixture={}, fixture_equal=False, synthetic={}
    )


def command_result(command: list[str], exit_code: int) -> CommandResult:
    return CommandResult(command=list(command), exit_code=exit_code, passed=False)


def xlg03_verdict(result: CalibrationResult) -> CrossLingualVerdict:
    return CrossLingualVerdict(verdict="fail", comparable_cells=0, exceeding=[], comparisons=[], note="")


def local_bm25_refusal_rule(output: RunOutput, *, run: str) -> LocalBm25RefusalResult:
    return LocalBm25RefusalResult(run=run, passed=False, threshold_decisions=0, refusal_bases={}, overall=output.report.overall)


def resolve_chunking_profile(decision: ChunkingDecision, sweep: ChunkingSweepReport) -> ChunkingChoice:
    return ChunkingChoice(profile_id=LEGACY_ID, source="decision", decision_profile_id=decision.profile_id, doc_type=decision.doc_type)


def default_runner(request: RunRequest) -> RunOutput:
    raise ComparisonError("not implemented")


def default_command_runner(argv: list[str]) -> int:
    return 1


def run_phase_comparison(spec, out: Path, runner: Runner = default_runner, commands: CommandRunner = default_command_runner) -> PhaseComparison:
    raise ComparisonError("not implemented")


def main(argv: list[str] | None = None) -> int:
    return EXIT_USAGE
