"""Phase 4.4 gates (D-36): every gate and threshold is read from the pre-registered spec eval/config/phase44-comparison.json.

(a) off identity: runs with the three lexical scoring variables at their defaults equal the committed fixture baselines (zero paired
    differences), the characterization command passes and stage latency stays within the chat budget, in both fixture modes.
(b) on: the BM25 run against the reference run (the same run config with ts_rank_cd) drops no overall, language or category slice beyond
    the noise band on Recall@5, Recall@10 and MRR, has zero paired refusal differences and stays within the chat latency budget.
(c) cap agreement: the mean overlap@k between the capped and the uncapped BM25 lexical top k over the fixture questions (the harness
    writes it to lexical-bm25-overlap.json next to each bm25 run) is at least the spec's minimum.
The paired, noise-band and latency checks are rag_eval.phase_compare's and rag_eval.phase42_gate's; this module adds the reference-run
refusal check and the overlap gate only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, ValidationError, model_validator
from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.latency import Profile as LatencyProfile
from rag_sidecar.contracts.report import ItemResult, SliceMetrics

from rag_eval.harness_runner import HarnessError
from rag_eval.paired import item_metrics
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.phase42_gate import drop_offenders, load_run
from rag_eval.phase_compare import (
    HARNESS_DIR,
    ComparisonError,
    LatencyBudgetSpec,
    RunOutput,
    RunRequest,
    SliceGateRule,
    _Model,
    _read_model,
    _write_text,
    default_command_runner,
    default_runner,
    is_below_min_n,
    latency_budget_check,
    materialise_run_config,
    paired_all_zero_check,
    with_min_gate_n,
)
from rag_eval.phase_compare import RunSpec as CompareRunSpec

FixtureMode = Literal["prechunked", "ingest"]
Runner = Callable[[RunRequest], RunOutput]
CommandRunner = Callable[[list[str]], int]

OFF_ENV: Mapping[str, str] = {"RAG_LEXICAL_SCORING": "ts_rank_cd", "RAG_LEXICAL_BM25_K1": "1.2", "RAG_LEXICAL_BM25_B": "0.75"}
BM25 = "bm25"
OVERLAP_FILE = "lexical-bm25-overlap.json"
REFUSAL_METRICS = ("correct_refusal_rate", "false_refusal_rate")
GATE_NAMES = ("off_identity", "on", "cap_agreement")
JSON_NAME = "gate.json"
MARKDOWN_NAME = "gate.md"

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_HARNESS = 3

FIXTURE_NOTE = (
    "Fixture corpus only: every gate and threshold here was committed before any on-run result was looked at (D-36, pre-registration). "
    "Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare. "
    "The default fixture reranker partly hides a change in lexical order, so the fixture shows the absence of a regression, not the "
    "size of an effect; the reranker-none pair is reported, not gated."
)


# ---------- spec


class RunEntry(_Model):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    base: str | None = None
    fixture_mode: FixtureMode
    env: dict[str, str] = Field(default_factory=dict)
    phase44_off: bool = False


class RunPair(_Model):
    run: str
    reference: str


class OffIdentityGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    runs: list[str] = Field(min_length=1)
    commands: list[str] = Field(default_factory=list)
    latency_profile: LatencyProfile = "chat"


class OnGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    pairs: list[RunPair] = Field(min_length=1)
    refusal_paired_zero: Literal[True] = True
    latency_profile: LatencyProfile = "chat"


class CapAgreementGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    runs: list[str] = Field(min_length=1)
    k: int = Field(ge=1, le=50)
    min_mean_overlap: float = Field(ge=0, le=1)


class GateSpecs(_Model):
    off_identity: OffIdentityGate
    on: OnGate
    cap_agreement: CapAgreementGate


class ReportOnlyPair(_Model):
    run: str
    reference: str
    note: str = Field(min_length=1)


class Phase44GateSpec(_Model):
    schema_version: Literal[1] = 1
    phase: Literal["04.4"]
    noise: str
    budgets: str = "eval/config/latency-budgets.json"
    baselines: dict[FixtureMode, str]
    off_env: dict[str, str]
    runs: list[RunEntry] = Field(min_length=1)
    gates: GateSpecs
    report_only: list[ReportOnlyPair] = Field(default_factory=list)
    commands: dict[str, list[str]] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)
    no_slice_drop_rule: SliceGateRule = Field(default_factory=SliceGateRule)

    @model_validator(mode="after")
    def _references(self) -> Phase44GateSpec:
        if dict(self.off_env) != dict(OFF_ENV):
            raise ValueError(f"off_env must set exactly the three lexical scoring variables at their defaults: {dict(OFF_ENV)}")
        names = [run.name for run in self.runs]
        if len(names) != len(set(names)):
            raise ValueError("run names must be unique")
        by_name = {run.name: run for run in self.runs}
        g = self.gates
        referenced = [
            *g.off_identity.runs,
            *(name for pair in g.on.pairs for name in (pair.run, pair.reference)),
            *g.cap_agreement.runs,
            *(name for pair in self.report_only for name in (pair.run, pair.reference)),
        ]
        missing = sorted({name for name in referenced if name not in by_name})
        if missing:
            raise ValueError(f"gates name unknown runs: {', '.join(missing)}")
        for name in g.off_identity.runs:
            if not by_name[name].phase44_off or by_name[name].base is not None:
                raise ValueError(f"off_identity run {name} must set phase44_off and use no base run config (the committed baselines are legacy runs)")
        for pair in [*g.on.pairs, *self.report_only]:
            if not by_name[pair.reference].phase44_off:
                raise ValueError(f"reference run {pair.reference} must set phase44_off (ts_rank_cd)")
            if by_name[pair.run].phase44_off:
                raise ValueError(f"run {pair.run} compared against {pair.reference} must not set phase44_off")
            if by_name[pair.run].fixture_mode != by_name[pair.reference].fixture_mode:
                raise ValueError(f"run {pair.run} and its reference {pair.reference} must use the same fixture mode")
        on_runs = {pair.run for pair in g.on.pairs}
        if not set(g.cap_agreement.runs) <= on_runs:
            raise ValueError("cap_agreement runs must be on runs of gate (b)")
        unknown = sorted(set(g.off_identity.commands) - set(self.commands))
        if unknown:
            raise ValueError(f"off_identity names unknown commands: {', '.join(unknown)}")
        for name, argv in self.commands.items():
            if not argv:
                raise ValueError(f"command {name} is empty")
        if not {run.fixture_mode for run in self.runs} <= set(self.baselines):
            raise ValueError("every fixture mode used by a run needs a baseline")
        return self


def runs_for(spec: Phase44GateSpec, gate: str) -> list[str]:
    g = spec.gates
    if gate == "off_identity":
        return list(g.off_identity.runs)
    if gate == "on":
        return [name for pair in g.on.pairs for name in (pair.run, pair.reference)]
    if gate == "cap_agreement":
        return list(g.cap_agreement.runs)
    raise ComparisonError(f"unknown gate {gate!r}; choose from {', '.join(GATE_NAMES)}")


def run_config_for(spec: Phase44GateSpec, run: RunEntry) -> dict[str, Any]:
    env = {**(spec.off_env if run.phase44_off else {}), **run.env}
    if run.base is None:
        return {"name": run.name, "env": env, "overrides": None}
    if not resolve_cli_path(run.base).is_file():
        raise ComparisonError(f"run {run.name}: run config {run.base} does not exist")
    return materialise_run_config(CompareRunSpec(name=run.name, base=run.base, fixture_mode=run.fixture_mode, env=env), [])


def _check_scoring(spec: Phase44GateSpec, configs: Mapping[str, dict[str, Any]]) -> None:
    """An on run must turn bm25 on, a phase44_off run must not (T-04.4-43: the right arm against the right reference)."""
    by_name = {run.name: run for run in spec.runs}
    for name, config in configs.items():
        scoring = (config.get("env") or {}).get("RAG_LEXICAL_SCORING", OFF_ENV["RAG_LEXICAL_SCORING"])
        if by_name[name].phase44_off and scoring != OFF_ENV["RAG_LEXICAL_SCORING"]:
            raise ComparisonError(f"run {name} sets phase44_off but its run config scores with {scoring}")
        if not by_name[name].phase44_off and scoring != BM25:
            raise ComparisonError(f"run {name} is compared as a bm25 run but its run config scores with {scoring}")


# ---------- overlap file (written by eval/harness/run-eval.mts for a bm25 run)


class OverlapRow(_Model):
    item_id: str
    overlap: float | None = Field(default=None, ge=0, le=1)
    uncapped: int = Field(ge=0)


class OverlapReport(_Model):
    schema_version: Literal[1] = 1
    #: plan 04.4-18: written only by a run whose effective DF mode is cluster; absent for raw runs.
    df_mode: Literal["cluster"] | None = None
    tenant_hash: str
    k: int = Field(ge=1)
    capped_candidate_limit: int = Field(ge=0)
    questions: int = Field(ge=0)
    measured: int = Field(ge=0)
    mean_overlap_at_k: float | None = Field(default=None, ge=0, le=1)
    min_overlap_at_k: float | None = Field(default=None, ge=0, le=1)
    items: list[OverlapRow]


def load_overlap(run_dir: Path, run: str) -> OverlapReport:
    path = run_dir / OVERLAP_FILE
    if not path.is_file():
        raise ComparisonError(f"run {run}: {repo_relative(path)} is missing; a bm25 run writes it")
    try:
        return OverlapReport.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError) as exc:
        raise ComparisonError(f"run {run}: {repo_relative(path)} is unreadable: {exc}") from exc


# ---------- results


Number = float | int | None


class GateOutcome(_Model):
    name: str
    decision: str
    passed: bool
    runs: list[str]
    numbers: dict[str, Number] = Field(default_factory=dict)
    offenders: list[str] = Field(default_factory=list)
    below_min_n: list[str] = Field(default_factory=list)


class ReportOnlyOutcome(_Model):
    run: str
    reference: str
    note: str
    numbers: dict[str, Number] = Field(default_factory=dict)
    moves: list[str] = Field(default_factory=list)


class RunSummary(_Model):
    name: str
    fixture_mode: str
    env: dict[str, str]
    run_config_hash: str
    overall: SliceMetrics


class Phase44Gates(_Model):
    schema_version: Literal[1] = 1
    phase: str
    passed: bool
    selected: list[str]
    noise_floor: float
    noise_k: float
    gates: list[GateOutcome]
    report_only: list[ReportOnlyOutcome]
    runs: list[RunSummary]
    notes: list[str]


# ---------- checks


def _gated(output: RunOutput) -> list[ItemResult]:
    split = output.report.golden_filter.gate_split
    return [item for item in output.report.items if item.split == split]


def refusal_differences(on: RunOutput, reference: RunOutput, *, reference_name: str) -> list[str]:
    """Item by item, correct and false refusal are equal between the run and its reference; an item scored in only one is an offender."""
    ours = {item.item_id: item for item in _gated(on)}
    theirs = {item.item_id: item for item in _gated(reference)}
    found = [f"item {item_id} is scored in only one of the run and {reference_name}" for item_id in sorted(set(ours) ^ set(theirs))]
    moved: dict[str, list[str]] = {metric: [] for metric in REFUSAL_METRICS}
    for item_id in sorted(set(ours) & set(theirs)):
        a, b = item_metrics(ours[item_id]), item_metrics(theirs[item_id])
        for metric in REFUSAL_METRICS:
            if a[metric] != b[metric]:
                moved[metric].append(item_id)
    found += [
        f"{metric}: {len(ids)} item(s) moved against {reference_name} ({', '.join(ids[:5])}{', ...' if len(ids) > 5 else ''})"
        for metric, ids in moved.items()
        if ids
    ]
    return found


def _latency(output: RunOutput, budgets: LatencyBudgets, profile: LatencyProfile, run: str, budgets_path: str) -> tuple[list[str], dict[str, Number]]:
    check = latency_budget_check(output, budgets, LatencyBudgetSpec(kind="latency_budget", profile=profile, budgets=budgets_path))
    return [f"{run}: {line}" for line in check.detail], {f"{run}.{key}": value for key, value in check.measures.items() if key.startswith("retrieval_total")}


def _outcome(name: str, decision: str, runs: list[str], numbers: dict[str, Number], offenders: list[str]) -> GateOutcome:
    gated = [line for line in offenders if not is_below_min_n(line)]
    below = [line for line in offenders if is_below_min_n(line)]
    return GateOutcome(name=name, decision=decision, passed=not gated, runs=runs, numbers=numbers, offenders=gated, below_min_n=below)


def off_identity_gate(
    gate: OffIdentityGate,
    outputs: Mapping[str, RunOutput],
    modes: Mapping[str, str],
    baselines: Mapping[str, Baseline],
    noise: NoiseConfig,
    budgets: LatencyBudgets,
    budgets_path: str,
    command_codes: Mapping[str, int],
    *,
    latency: bool = True,
) -> GateOutcome:
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    for name in gate.runs:
        check = paired_all_zero_check(outputs[name], baselines[modes[name]], noise)
        numbers[f"{name}.nonzero_cells"] = 0 if check.passed else len(check.detail)
        if not check.passed:
            offenders += [f"{name} vs {modes[name]} baseline: {detail}" for detail in check.detail or ["paired differences not all zero"]]
        if not latency:
            continue
        lines, measures = _latency(outputs[name], budgets, gate.latency_profile, name, budgets_path)
        offenders += lines
        numbers.update(measures)
    for command in gate.commands:
        code = command_codes.get(command)
        numbers[f"command.{command}.exit_code"] = code
        if code != 0:
            offenders.append(f"command {command} exited {code if code is not None else 'without running'}")
    return _outcome("off_identity", gate.decision, list(gate.runs), numbers, offenders)


def on_gate(gate: OnGate, outputs: Mapping[str, RunOutput], noise: NoiseConfig, budgets: LatencyBudgets, budgets_path: str) -> GateOutcome:
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    runs: list[str] = []
    for pair in gate.pairs:
        on, reference = outputs[pair.run], outputs[pair.reference]
        offenders += [f"{pair.run}: {line}" for line in drop_offenders(on, reference, noise, reference_name=pair.reference)]
        refusal = refusal_differences(on, reference, reference_name=pair.reference)
        numbers[f"{pair.run}.refusal_differences"] = len(refusal)
        offenders += [f"{pair.run}: {line}" for line in refusal]
        lines, measures = _latency(on, budgets, gate.latency_profile, pair.run, budgets_path)
        offenders += lines
        numbers.update(measures)
        for metric in ("recall_at_10", "mrr"):
            numbers[f"{pair.run}.{metric}"] = getattr(on.report.overall, metric).value
            numbers[f"{pair.reference}.{metric}"] = getattr(reference.report.overall, metric).value
        runs += [pair.run, pair.reference]
    return _outcome("on", gate.decision, runs, numbers, offenders)


def expected_df_mode(config: Mapping[str, Any]) -> Literal["cluster"] | None:
    """The DF mode a run's overlap file must carry: cluster only when the run config makes it effective (bm25 and RAG_DUP_CLUSTERS, D-45)."""
    env = config.get("env") or {}
    if env.get("RAG_LEXICAL_DF_MODE", "raw").strip().lower() != "cluster":
        return None
    if env.get("RAG_LEXICAL_SCORING", OFF_ENV["RAG_LEXICAL_SCORING"]).strip().lower() != BM25:
        return None
    if env.get("RAG_DUP_CLUSTERS", "false").strip().lower() != "true":
        return None
    return "cluster"


def cap_agreement_gate(
    gate: CapAgreementGate,
    overlaps: Mapping[str, OverlapReport],
    expected_df_modes: Mapping[str, Literal["cluster"] | None] | None = None,
) -> GateOutcome:
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    for name in gate.runs:
        report = overlaps[name]
        wanted = (expected_df_modes or {}).get(name)
        if report.df_mode != wanted:
            offenders.append(f"{name}: overlap measured with df_mode {report.df_mode or 'raw'}, the run serves {wanted or 'raw'}")
        numbers[f"{name}.mean_overlap_at_k"] = report.mean_overlap_at_k
        numbers[f"{name}.min_overlap_at_k"] = report.min_overlap_at_k
        numbers[f"{name}.measured"] = report.measured
        if report.k != gate.k:
            offenders.append(f"{name}: overlap measured at k={report.k}, the spec gates k={gate.k}")
        if report.mean_overlap_at_k is None or report.measured == 0:
            offenders.append(f"{name}: no question had an uncapped lexical hit; the overlap was not measured")
        elif report.mean_overlap_at_k < gate.min_mean_overlap:
            offenders.append(f"{name}: mean overlap@{gate.k} {report.mean_overlap_at_k:.4f} < {gate.min_mean_overlap:.2f}")
    return _outcome("cap_agreement", gate.decision, list(gate.runs), numbers, offenders)


def report_only_pair(pair: ReportOnlyPair, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> ReportOnlyOutcome:
    on, reference = outputs[pair.run], outputs[pair.reference]
    numbers: dict[str, Number] = {}
    for metric in ("recall_at_5", "recall_at_10", "mrr"):
        numbers[f"{pair.run}.{metric}"] = getattr(on.report.overall, metric).value
        numbers[f"{pair.reference}.{metric}"] = getattr(reference.report.overall, metric).value
    moves = [*drop_offenders(on, reference, noise, reference_name=pair.reference), *refusal_differences(on, reference, reference_name=pair.reference)]
    return ReportOnlyOutcome(run=pair.run, reference=pair.reference, note=pair.note, numbers=numbers, moves=moves)


# ---------- runs


def _selection(only: Iterable[str] | None) -> list[str]:
    chosen = list(dict.fromkeys(only or ()))
    unknown = [name for name in chosen if name not in GATE_NAMES]
    if unknown:
        raise ComparisonError(f"unknown gate(s) {', '.join(unknown)}; choose from {', '.join(GATE_NAMES)}")
    return [name for name in GATE_NAMES if name in chosen] if chosen else list(GATE_NAMES)


def run_phase44_gates(
    spec: Phase44GateSpec | Path,
    out: Path,
    runner: Runner = default_runner,
    *,
    command_runner: CommandRunner = default_command_runner,
    only: Iterable[str] | None = None,
    reuse: Path | None = None,
) -> Phase44Gates:
    if not isinstance(spec, Phase44GateSpec):
        spec = _read_model(Phase44GateSpec, str(spec), "gate spec")
    selected = _selection(only)
    noise = with_min_gate_n(_read_model(NoiseConfig, spec.noise, "noise config"), spec.no_slice_drop_rule.min_gate_n)
    budgets = _read_model(LatencyBudgets, spec.budgets, "latency budgets")
    by_name = {run.name: run for run in spec.runs}
    needed = {name for gate in selected for name in runs_for(spec, gate)}
    if not only:
        needed |= {name for pair in spec.report_only for name in (pair.run, pair.reference)}
    out_dir = Path(out)
    configs = {run.name: run_config_for(spec, run) for run in spec.runs if run.name in needed}
    _check_scoring(spec, configs)
    baselines: dict[str, Baseline] = {}
    if "off_identity" in selected:
        modes_needed = sorted({by_name[name].fixture_mode for name in spec.gates.off_identity.runs})
        baselines = {mode: _read_model(Baseline, spec.baselines[mode], f"{mode} baseline") for mode in modes_needed}
    run_root = (Path(reuse) if reuse is not None else out_dir) / HARNESS_DIR
    outputs: dict[str, RunOutput] = {}
    for run in spec.runs:
        if run.name not in needed:
            continue
        if reuse is not None:
            outputs[run.name] = load_run(run_root / run.name)
            continue
        print(f"[Phase 4.4 Gates] run {run.name} ({run.fixture_mode})", file=sys.stderr)
        outputs[run.name] = runner(
            RunRequest(name=run.name, run_config=configs[run.name], fixture_mode=run.fixture_mode, out_dir=run_root / run.name)
        )
    overlaps = {name: load_overlap(run_root / name, name) for name in spec.gates.cap_agreement.runs} if "cap_agreement" in selected else {}
    command_codes: dict[str, int] = {}
    if "off_identity" in selected:
        for command in spec.gates.off_identity.commands:
            command_codes[command] = command_runner(list(spec.commands[command]))
    modes = {name: run.fixture_mode for name, run in by_name.items()}
    gates: list[GateOutcome] = []
    g = spec.gates
    for name in selected:
        if name == "off_identity":
            gates.append(off_identity_gate(g.off_identity, outputs, modes, baselines, noise, budgets, spec.budgets, command_codes))
        elif name == "on":
            gates.append(on_gate(g.on, outputs, noise, budgets, spec.budgets))
        elif name == "cap_agreement":
            gates.append(cap_agreement_gate(g.cap_agreement, overlaps, {name: expected_df_mode(configs[name]) for name in g.cap_agreement.runs}))
    report_only = [report_only_pair(pair, outputs, noise) for pair in spec.report_only if pair.run in outputs and pair.reference in outputs]
    runs = [
        RunSummary(
            name=run.name,
            fixture_mode=run.fixture_mode,
            env=dict(configs[run.name]["env"]),
            run_config_hash=outputs[run.name].report.run_config_hash,
            overall=outputs[run.name].report.overall,
        )
        for run in spec.runs
        if run.name in outputs
    ]
    result = Phase44Gates(
        phase=spec.phase,
        passed=all(gate.passed for gate in gates),
        selected=selected,
        noise_floor=noise.floor,
        noise_k=noise.k,
        gates=gates,
        report_only=report_only,
        runs=runs,
        notes=[FIXTURE_NOTE, *spec.notes],
    )
    _write_text(out_dir / JSON_NAME, json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2) + "\n")
    _write_text(out_dir / MARKDOWN_NAME, render_markdown(result))
    return result


# ---------- markdown


def _num(value: Number) -> str:
    if value is None:
        return "—"
    return str(value) if isinstance(value, int) else f"{value:.4f}"


def render_markdown(result: Phase44Gates) -> str:
    lines = [
        f"# Phase {result.phase} gates",
        "",
        (
            f"Verdict: **{'PASS' if result.passed else 'FAIL'}** over {', '.join(result.selected)}. "
            f"Noise band: max({result.noise_k:g} x spread, {result.noise_floor:g})."
        ),
        "",
        "| Gate | Decision | Verdict | Offenders |",
        "| --- | --- | --- | --- |",
    ]
    lines += [f"| {g.name} | {g.decision} | {'PASS' if g.passed else 'FAIL'} | {len(g.offenders)} |" for g in result.gates]
    for g in result.gates:
        lines += ["", f"## {g.name} ({g.decision})", "", f"Runs: {', '.join(g.runs)}."]
        if g.numbers:
            lines += ["", "| Number | Value |", "| --- | --- |", *(f"| {key} | {_num(value)} |" for key, value in sorted(g.numbers.items()))]
        if g.offenders:
            lines += ["", "Offenders:", *(f"- {offender}" for offender in g.offenders)]
        if g.below_min_n:
            lines += ["", "Below min_gate_n (reported, not gated):", *(f"- {line}" for line in g.below_min_n)]
    if result.report_only:
        lines += ["", "## Report-only (not gated)"]
        for r in result.report_only:
            lines += ["", f"### `{r.run}` against `{r.reference}`", "", r.note, ""]
            lines += ["| Number | Value |", "| --- | --- |", *(f"| {key} | {_num(value)} |" for key, value in sorted(r.numbers.items()))]
            if r.moves:
                lines += ["", "Moves:", *(f"- {move}" for move in r.moves)]
    if result.runs:
        lines += ["", "## Runs", "", "| Run | Mode | Recall@10 | MRR | Run config hash |", "| --- | --- | --- | --- | --- |"]
        lines += [
            f"| {r.name} | {r.fixture_mode} | {_num(r.overall.recall_at_10.value)} | {_num(r.overall.mrr.value)} | `{r.run_config_hash[:12]}` |"
            for r in result.runs
        ]
    lines += ["", *(f"> {note}" for note in result.notes), ""]
    return "\n".join(lines)


# ---------- plan 04.4-22: tenant statistics for the local reranker (D-57, spec variant "local_rerank_stats")

LOCAL_STATS_VAR = "RAG_RERANK_LOCAL_STATS"
LOCAL_STATS_VARIANT = "local_rerank_stats"
LOCAL_STATS_GATE_NAMES = ("off_identity", "no_slice_drop", "pool_independence", "latency", "refusal")
TRACES_FILE = "traces.jsonl"
Arm = Literal["off", "pool", "tenant"]
BaselineKind = Literal["prechunked", "ingest", "voice"]


class LocalStatsRun(_Model):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    base: str | None = None
    fixture_mode: FixtureMode
    arm: Arm
    env: dict[str, str] = Field(default_factory=dict)


class BaselineRun(_Model):
    run: str
    baseline: BaselineKind


class LocalOffIdentityGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    runs: list[BaselineRun] = Field(min_length=1)
    commands: list[str] = Field(default_factory=list)


class PairsGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    pairs: list[RunPair] = Field(min_length=1)


class PoolIndependenceGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    pairs: list[RunPair] = Field(min_length=1)
    max_inversions: Literal[0] = 0
    min_compared_pairs: int = Field(ge=1)
    report_only_pairs: list[RunPair] = Field(default_factory=list)


class LatencyRun(_Model):
    run: str
    profiles: list[LatencyProfile] = Field(min_length=1)


class LocalLatencyGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    stage: Literal["rerank"] = "rerank"
    runs: list[LatencyRun] = Field(min_length=1)


class RefusalGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    pairs: list[RunPair] = Field(min_length=1)
    metrics: dict[str, Literal["higher", "lower"]] = Field(min_length=1)


class LocalStatsGates(_Model):
    off_identity: LocalOffIdentityGate
    no_slice_drop: PairsGate
    pool_independence: PoolIndependenceGate
    latency: LocalLatencyGate
    refusal: RefusalGate


class ItemLine(_Model):
    run: str
    reference: str
    item_id: str
    note: str = Field(min_length=1)


class LocalStatsGateSpec(_Model):
    schema_version: Literal[1] = 1
    phase: Literal["04.4"]
    variant: Literal["local_rerank_stats"]
    noise: str
    budgets: str = "eval/config/latency-budgets.json"
    no_slice_drop_rule: SliceGateRule = Field(default_factory=SliceGateRule)
    baselines: dict[BaselineKind, str]
    off_env: dict[str, str]
    tenant_env: dict[str, str]
    runs: list[LocalStatsRun] = Field(min_length=1)
    gates: LocalStatsGates
    report_only_items: list[ItemLine] = Field(default_factory=list)
    commands: dict[str, list[str]] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _references(self) -> LocalStatsGateSpec:
        if self.off_env != {LOCAL_STATS_VAR: "pool"} or self.tenant_env != {LOCAL_STATS_VAR: "tenant"}:
            raise ValueError(f"off_env must be {{{LOCAL_STATS_VAR}: pool}} and tenant_env {{{LOCAL_STATS_VAR}: tenant}}")
        names = [run.name for run in self.runs]
        if len(names) != len(set(names)):
            raise ValueError("run names must be unique")
        by_name = {run.name: run for run in self.runs}
        g = self.gates
        referenced = [
            *(entry.run for entry in g.off_identity.runs),
            *(n for gate in (g.no_slice_drop, g.refusal) for pair in gate.pairs for n in (pair.run, pair.reference)),
            *(n for pair in [*g.pool_independence.pairs, *g.pool_independence.report_only_pairs] for n in (pair.run, pair.reference)),
            *(entry.run for entry in g.latency.runs),
            *(n for line in self.report_only_items for n in (line.run, line.reference)),
        ]
        missing = sorted({n for n in referenced if n not in by_name})
        if missing:
            raise ValueError(f"gates name unknown runs: {', '.join(missing)}")
        for entry in g.off_identity.runs:
            if by_name[entry.run].arm != "off":
                raise ValueError(f"off_identity run {entry.run} must be an off arm")
            if entry.baseline not in self.baselines:
                raise ValueError(f"off_identity run {entry.run} names baseline {entry.baseline}, which the spec does not list")
        for pair in [*g.no_slice_drop.pairs, *g.refusal.pairs]:
            run, ref = by_name[pair.run], by_name[pair.reference]
            if run.arm != "tenant" or ref.arm != "pool":
                raise ValueError(f"pair {pair.run} / {pair.reference} must be a tenant arm against a pool arm")
            if run.base != ref.base or run.env != ref.env or run.fixture_mode != ref.fixture_mode:
                raise ValueError(f"pair {pair.run} / {pair.reference} must differ only in {LOCAL_STATS_VAR}")
        for pair in g.pool_independence.pairs:
            if by_name[pair.run].arm != "tenant" or by_name[pair.reference].arm != "tenant":
                raise ValueError(f"pool_independence pair {pair.run} / {pair.reference} must compare two tenant arms")
        for entry in g.latency.runs:
            if by_name[entry.run].arm != "tenant":
                raise ValueError(f"latency run {entry.run} must be a tenant arm")
        unknown = sorted(set(g.off_identity.commands) - set(self.commands))
        if unknown:
            raise ValueError(f"off_identity names unknown commands: {', '.join(unknown)}")
        return self


class LocalStatsResult(_Model):
    schema_version: Literal[1] = 1
    phase: str
    variant: str
    passed: bool
    spec: str
    spec_sha256: str
    registration_commit: str | None
    noise_floor: float
    noise_k: float
    gates: list[GateOutcome]
    report_only: list[ReportOnlyOutcome]
    runs: list[RunSummary]
    notes: list[str]


def is_local_stats_spec(path: Path) -> bool:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(raw, dict) and raw.get("variant") == LOCAL_STATS_VARIANT


def local_stats_run_config(spec: LocalStatsGateSpec, run: LocalStatsRun) -> dict[str, Any]:
    """The base run config (its entry_profile kept, unlike materialise_run_config) with the arm's switch value on top."""
    arm_env = spec.tenant_env if run.arm == "tenant" else spec.off_env
    env = {**run.env, **arm_env}
    if run.base is None:
        return {"name": run.name, "env": env, "overrides": None}
    path = resolve_cli_path(run.base)
    if not path.is_file():
        raise ComparisonError(f"run {run.name}: run config {run.base} does not exist")
    config = materialise_run_config(CompareRunSpec(name=run.name, base=run.base, fixture_mode=run.fixture_mode, env=env), [])
    base = json.loads(path.read_text(encoding="utf-8"))
    if base.get("entry_profile") is not None:
        config["entry_profile"] = base["entry_profile"]
    return config


def check_local_stats_arms(spec: LocalStatsGateSpec, configs: Mapping[str, dict[str, Any]]) -> None:
    """Each run serves the arm it is compared as (T-04.4-65: the right arm against the right reference)."""
    by_name = {run.name: run for run in spec.runs}
    for name, config in configs.items():
        value = (config.get("env") or {}).get(LOCAL_STATS_VAR)
        wanted = "tenant" if by_name[name].arm == "tenant" else "pool"
        if value != wanted:
            raise ComparisonError(f"run {name} is a {by_name[name].arm} arm but its run config sets {LOCAL_STATS_VAR}={value}")


def read_trace_scores(run_dir: Path, run: str) -> dict[str, dict[str, float]]:
    """Per item, the rerank score of each candidate the trace lists (candidates without a rerank score are left out)."""
    path = run_dir / TRACES_FILE
    if not path.is_file():
        raise ComparisonError(f"run {run}: {repo_relative(path)} is missing")
    out: dict[str, dict[str, float]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        scores = {
            str(c["chunk_id"]): float(c["rerank_score"])
            for c in row.get("candidates") or []
            if isinstance(c, dict) and isinstance(c.get("rerank_score"), int | float)
        }
        out[str(row["item_id"])] = scores
    return out


def rerank_inversions(a: Mapping[str, Mapping[str, float]], b: Mapping[str, Mapping[str, float]]) -> dict[str, Any]:
    """Pairs of candidates common to both runs of an item that one run orders strictly one way and the other strictly the other way.

    Ties are not orderings, so a pair tied in either run is not compared. Returns totals and the items with an inversion."""
    items = pairs = inversions = 0
    offending: list[str] = []
    for item_id in sorted(set(a) & set(b)):
        sa, sb = a[item_id], b[item_id]
        common = sorted(set(sa) & set(sb))
        if len(common) < 2:
            continue
        items += 1
        found = 0
        for i, x in enumerate(common):
            for y in common[i + 1 :]:
                da, db = sa[x] - sa[y], sb[x] - sb[y]
                if da == 0 or db == 0:
                    continue
                pairs += 1
                if (da > 0) != (db > 0):
                    found += 1
        inversions += found
        if found:
            offending.append(item_id)
    return {"items": items, "pairs": pairs, "inversions": inversions, "offending_items": offending}


def pool_independence_gate(gate: PoolIndependenceGate, scores: Mapping[str, Mapping[str, Mapping[str, float]]]) -> tuple[GateOutcome, list[ReportOnlyOutcome]]:
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    runs: list[str] = []
    for pair in gate.pairs:
        result = rerank_inversions(scores[pair.run], scores[pair.reference])
        key = f"{pair.run}~{pair.reference}"
        numbers[f"{key}.items_compared"] = result["items"]
        numbers[f"{key}.pairs_compared"] = result["pairs"]
        numbers[f"{key}.inversions"] = result["inversions"]
        if result["pairs"] < gate.min_compared_pairs:
            offenders.append(f"{key}: {result['pairs']} candidate pair(s) compared < {gate.min_compared_pairs}; the order was not measured")
        if result["inversions"] > gate.max_inversions:
            ids = result["offending_items"]
            offenders.append(f"{key}: {result['inversions']} order inversion(s) among common candidates in {len(ids)} item(s) ({', '.join(ids[:5])}{', ...' if len(ids) > 5 else ''})")
        runs += [pair.run, pair.reference]
    extra = []
    for pair in gate.report_only_pairs:
        result = rerank_inversions(scores[pair.run], scores[pair.reference])
        extra.append(
            ReportOnlyOutcome(
                run=pair.run,
                reference=pair.reference,
                note="Pool statistics under the same comparison (reported, not gated): the order flips the tenant statistics remove.",
                numbers={"items_compared": result["items"], "pairs_compared": result["pairs"], "inversions": result["inversions"]},
                moves=[f"inversions in {len(result['offending_items'])} item(s)"] if result["inversions"] else [],
            )
        )
    return _outcome("pool_independence", gate.decision, runs, numbers, offenders), extra


def local_latency_gate(gate: LocalLatencyGate, outputs: Mapping[str, RunOutput], budgets: LatencyBudgets, budgets_path: str) -> GateOutcome:
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    for entry in gate.runs:
        latency = outputs[entry.run].report.latency or {}
        stat = latency.get(gate.stage)
        if stat is None:
            offenders.append(f"{entry.run}: {gate.stage} latency was not measured")
            continue
        numbers[f"{entry.run}.{gate.stage}.p50_ms"] = getattr(stat, "p50_ms", None)
        numbers[f"{entry.run}.{gate.stage}.p95_ms"] = stat.p95_ms
        for profile in entry.profiles:
            budget = budgets.profiles[profile].stages.get(gate.stage) if profile in budgets.profiles else None
            if budget is None:
                offenders.append(f"{entry.run}: no {profile} budget for {gate.stage} in {budgets_path}")
                continue
            p50 = getattr(stat, "p50_ms", None)
            if stat.p95_ms > budget:
                offenders.append(f"{entry.run}: {gate.stage} p95 {stat.p95_ms:.1f} ms > {profile} budget {budget:.1f} ms")
            if p50 is not None and p50 > budget:
                offenders.append(f"{entry.run}: {gate.stage} p50 {p50:.1f} ms > {profile} budget {budget:.1f} ms")
    return _outcome("latency", gate.decision, [entry.run for entry in gate.runs], numbers, offenders)


def refusal_rate_gate(gate: RefusalGate, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> GateOutcome:
    """Overall refusal and false-answer rates of each tenant arm against its pool arm: a worsening beyond the noise floor fails (a single
    reference run has spread 0, so the band is the floor, as in phase_compare)."""
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    runs: list[str] = []
    for pair in gate.pairs:
        on, ref = outputs[pair.run].report.overall, outputs[pair.reference].report.overall
        for metric, direction in gate.metrics.items():
            a, b = getattr(on, metric, None), getattr(ref, metric, None)
            va = a.value if a is not None else None
            vb = b.value if b is not None else None
            numbers[f"{pair.run}.{metric}"] = va
            numbers[f"{pair.reference}.{metric}"] = vb
            if va is None or vb is None:
                if (va is None) != (vb is None):
                    offenders.append(f"{pair.run}: {metric} is measured in only one of the run and {pair.reference}")
                continue
            worse = (vb - va) if direction == "higher" else (va - vb)
            if worse > noise.floor:
                offenders.append(f"{pair.run}: {metric} {va:.4f} against {pair.reference} {vb:.4f} is worse beyond the noise floor {noise.floor:g}")
        runs += [pair.run, pair.reference]
    return _outcome("refusal", gate.decision, runs, numbers, offenders)


def item_line(line: ItemLine, outputs: Mapping[str, RunOutput]) -> ReportOnlyOutcome:
    def rank(name: str) -> Number:
        for item in outputs[name].report.items:
            if item.item_id == line.item_id:
                return item.first_hit_rank
        return None

    return ReportOnlyOutcome(
        run=line.run,
        reference=line.reference,
        note=line.note,
        numbers={f"{line.run}.{line.item_id}.first_hit_rank": rank(line.run), f"{line.reference}.{line.item_id}.first_hit_rank": rank(line.reference)},
    )


def registration_commit(spec_path: Path) -> str:
    """D-57: the commit that added the spec; it must be an ancestor of HEAD and the spec unchanged since (T-04.4-65)."""
    rel = repo_relative(spec_path)

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False)

    added = git("log", "--diff-filter=A", "--format=%H", "--", rel).stdout.split()
    if not added:
        raise ComparisonError(f"{rel} is not committed; the spec is registered by committing and pushing it before any run")
    commit = added[-1]
    if git("merge-base", "--is-ancestor", commit, "HEAD").returncode != 0:
        raise ComparisonError(f"the registration commit {commit[:12]} of {rel} is not an ancestor of HEAD")
    if git("diff", "--quiet", commit, "--", rel).returncode != 0:
        raise ComparisonError(f"{rel} changed after its registration commit {commit[:12]}")
    return commit


def run_local_stats_gates(
    spec_path: Path,
    out: Path,
    runner: Runner = default_runner,
    *,
    command_runner: CommandRunner = default_command_runner,
    reuse: Path | None = None,
    check_registration: bool = True,
) -> LocalStatsResult:
    spec = _read_model(LocalStatsGateSpec, str(spec_path), "gate spec")
    commit = registration_commit(Path(spec_path)) if check_registration else None
    noise = with_min_gate_n(_read_model(NoiseConfig, spec.noise, "noise config"), spec.no_slice_drop_rule.min_gate_n)
    budgets = _read_model(LatencyBudgets, spec.budgets, "latency budgets")
    configs = {run.name: local_stats_run_config(spec, run) for run in spec.runs}
    check_local_stats_arms(spec, configs)
    baselines = {kind: _read_model(Baseline, path, f"{kind} baseline") for kind, path in spec.baselines.items()}
    out_dir = Path(out)
    run_root = (Path(reuse) if reuse is not None else out_dir) / HARNESS_DIR
    outputs: dict[str, RunOutput] = {}
    for run in spec.runs:
        if reuse is not None:
            outputs[run.name] = load_run(run_root / run.name)
            continue
        print(f"[Phase 4.4 Gates] run {run.name} ({run.fixture_mode})", file=sys.stderr)
        outputs[run.name] = runner(RunRequest(name=run.name, run_config=configs[run.name], fixture_mode=run.fixture_mode, out_dir=run_root / run.name))
    g = spec.gates
    command_codes = {command: command_runner(list(spec.commands[command])) for command in g.off_identity.commands}
    off = off_identity_gate(
        OffIdentityGate(decision=g.off_identity.decision, description=g.off_identity.description, runs=[e.run for e in g.off_identity.runs], commands=g.off_identity.commands),
        outputs,
        {e.run: e.baseline for e in g.off_identity.runs},
        baselines,
        noise,
        budgets,
        spec.budgets,
        command_codes,
        latency=False,
    )
    drops: list[str] = []
    numbers: dict[str, Number] = {}
    for pair in g.no_slice_drop.pairs:
        drops += [f"{pair.run}: {line}" for line in drop_offenders(outputs[pair.run], outputs[pair.reference], noise, reference_name=pair.reference)]
        for metric in ("recall_at_5", "recall_at_10", "mrr"):
            numbers[f"{pair.run}.{metric}"] = getattr(outputs[pair.run].report.overall, metric).value
            numbers[f"{pair.reference}.{metric}"] = getattr(outputs[pair.reference].report.overall, metric).value
    no_drop = _outcome("no_slice_drop", g.no_slice_drop.decision, [n for p in g.no_slice_drop.pairs for n in (p.run, p.reference)], numbers, drops)
    names = {n for p in [*g.pool_independence.pairs, *g.pool_independence.report_only_pairs] for n in (p.run, p.reference)}
    scores = {name: read_trace_scores(run_root / name, name) for name in sorted(names)}
    independence, independence_extra = pool_independence_gate(g.pool_independence, scores)
    gates = [off, no_drop, independence, local_latency_gate(g.latency, outputs, budgets, spec.budgets), refusal_rate_gate(g.refusal, outputs, noise)]
    report_only = [*independence_extra, *(item_line(line, outputs) for line in spec.report_only_items)]
    runs = [
        RunSummary(
            name=run.name,
            fixture_mode=run.fixture_mode,
            env=dict(configs[run.name]["env"]),
            run_config_hash=outputs[run.name].report.run_config_hash,
            overall=outputs[run.name].report.overall,
        )
        for run in spec.runs
    ]
    result = LocalStatsResult(
        phase=spec.phase,
        variant=spec.variant,
        passed=all(gate.passed for gate in gates),
        spec=repo_relative(Path(spec_path)),
        spec_sha256=hashlib.sha256(Path(spec_path).read_bytes()).hexdigest(),
        registration_commit=commit,
        noise_floor=noise.floor,
        noise_k=noise.k,
        gates=gates,
        report_only=report_only,
        runs=runs,
        notes=[FIXTURE_NOTE, *spec.notes],
    )
    _write_text(out_dir / JSON_NAME, json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2) + "\n")
    _write_text(
        out_dir / MARKDOWN_NAME,
        render_markdown(
            Phase44Gates(
                phase=f"{spec.phase} ({spec.variant})",
                passed=result.passed,
                selected=list(LOCAL_STATS_GATE_NAMES),
                noise_floor=noise.floor,
                noise_k=noise.k,
                gates=gates,
                report_only=report_only,
                runs=runs,
                notes=[f"Spec {result.spec} sha256 {result.spec_sha256}, registered in commit {commit or 'not checked'}.", *result.notes],
            )
        ),
    )
    return result


# ---------- command line


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.phase44_gate", description="Phase 4.4 pre-registered gates (D-36)")
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", action="append", metavar="GATE", help=f"repeatable; one of {', '.join(GATE_NAMES)}")
    parser.add_argument("--reuse", type=Path, help="read finished runs from <dir>/harness/<run> instead of running the harness")
    args = parser.parse_args(argv)
    if is_local_stats_spec(resolve_cli_path(args.spec)):
        if args.only:
            print("error: --only is not available for the local_rerank_stats spec (every pre-registered gate runs)", file=sys.stderr)
            return EXIT_USAGE
        try:
            local = run_local_stats_gates(
                resolve_cli_path(args.spec),
                resolve_cli_path(args.out),
                runner=default_runner,
                reuse=resolve_cli_path(args.reuse) if args.reuse is not None else None,
            )
        except ComparisonError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_USAGE
        except HarnessError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_HARNESS
        for gate in local.gates:
            print(f"[Phase 4.4 Gates] {gate.name}: {'PASS' if gate.passed else 'FAIL'}")
            for offender in gate.offenders:
                print(f"[Phase 4.4 Gates]   {offender}")
        print(f"[Phase 4.4 Gates] {'PASS' if local.passed else 'FAIL'}: {repo_relative(resolve_cli_path(args.out))}/{JSON_NAME}")
        return EXIT_PASS if local.passed else EXIT_FAIL
    try:
        result = run_phase44_gates(
            resolve_cli_path(args.spec),
            resolve_cli_path(args.out),
            runner=default_runner,
            only=args.only,
            reuse=resolve_cli_path(args.reuse) if args.reuse is not None else None,
        )
    except ComparisonError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_HARNESS
    for gate in result.gates:
        print(f"[Phase 4.4 Gates] {gate.name}: {'PASS' if gate.passed else 'FAIL'}")
        for offender in gate.offenders:
            print(f"[Phase 4.4 Gates]   {offender}")
    print(f"[Phase 4.4 Gates] {'PASS' if result.passed else 'FAIL'}: {repo_relative(resolve_cli_path(args.out))}/{JSON_NAME}")
    return EXIT_PASS if result.passed else EXIT_FAIL


if __name__ == "__main__":
    raise SystemExit(main())
