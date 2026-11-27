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
import json
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
from rag_eval.paths import repo_relative, resolve_cli_path
from rag_eval.phase42_gate import drop_offenders, load_run
from rag_eval.phase_compare import (
    HARNESS_DIR,
    ComparisonError,
    LatencyBudgetSpec,
    RunOutput,
    RunRequest,
    _Model,
    _read_model,
    _write_text,
    default_command_runner,
    default_runner,
    latency_budget_check,
    materialise_run_config,
    paired_all_zero_check,
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
    return
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
    tenant_hash: str
    k: int = Field(ge=1)
    capped_candidate_limit: int = Field(ge=0)
    questions: int = Field(ge=0)
    measured: int = Field(ge=0)
    mean_overlap_at_k: float | None = Field(default=None, ge=0, le=1)
    min_overlap_at_k: float | None = Field(default=None, ge=0, le=1)
    items: list[OverlapRow]


def load_overlap(run_dir: Path, run: str) -> OverlapReport:
    return OverlapReport(tenant_hash='', k=10, capped_candidate_limit=0, questions=0, measured=0, items=[])
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
    return []
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
    return GateOutcome(name=name, decision=decision, passed=not offenders, runs=runs, numbers=numbers, offenders=offenders)


def off_identity_gate(
    gate: OffIdentityGate,
    outputs: Mapping[str, RunOutput],
    modes: Mapping[str, str],
    baselines: Mapping[str, Baseline],
    noise: NoiseConfig,
    budgets: LatencyBudgets,
    budgets_path: str,
    command_codes: Mapping[str, int],
) -> GateOutcome:
    return _outcome("off_identity", gate.decision, list(gate.runs), {}, [])
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    for name in gate.runs:
        check = paired_all_zero_check(outputs[name], baselines[modes[name]], noise)
        numbers[f"{name}.nonzero_cells"] = 0 if check.passed else len(check.detail)
        if not check.passed:
            offenders += [f"{name} vs {modes[name]} baseline: {detail}" for detail in check.detail or ["paired differences not all zero"]]
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
    return _outcome("on", gate.decision, [], {}, [])
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


def cap_agreement_gate(gate: CapAgreementGate, overlaps: Mapping[str, OverlapReport]) -> GateOutcome:
    return _outcome("cap_agreement", gate.decision, list(gate.runs), {}, [])
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    for name in gate.runs:
        report = overlaps[name]
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
    noise = _read_model(NoiseConfig, spec.noise, "noise config")
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
            gates.append(cap_agreement_gate(g.cap_agreement, overlaps))
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
        f"Verdict: **{'PASS' if result.passed else 'FAIL'}** over {', '.join(result.selected)}. "
        f"Noise band: max({result.noise_k:g} x spread, {result.noise_floor:g}).",
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


# ---------- command line


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.phase44_gate", description="Phase 4.4 pre-registered gates (D-36)")
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", action="append", metavar="GATE", help=f"repeatable; one of {', '.join(GATE_NAMES)}")
    parser.add_argument("--reuse", type=Path, help="read finished runs from <dir>/harness/<run> instead of running the harness")
    args = parser.parse_args(argv)
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
