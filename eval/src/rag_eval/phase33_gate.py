"""Phase 3.3 gate tool (plan 03.3-22; D-36, TPL-09): pre-registered gates of eval/config/phase33-gates.json, applied as data.

`check` validates the gates file against the comparison spec it names; `evaluate` reads finished harness run directories
(`<reports>/<run>/report.json`, `traces.jsonl`, `run.json` and the golden file run.json names) and writes gates.json and
README.md. Every number comes from the gates file. Missing data fails a gate (`missing_data`), never passes it. Output carries
numbers, ids, tags, slice names and fixture file names only: no chunk text, question or declared line."""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport, ItemResult, SliceMetrics

from rag_eval.golden_io import load_golden
from rag_eval.metrics import (
    POPULATION_EXCLUSIONS,
    TEMPLATED_CATEGORY,
    aggregate,
    citation_is_valid,
)
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.phase_compare import (
    RETRIEVAL_METRICS,
    CheckResult,
    RunOutput,
    SliceGateRule,
    SwitchComparisonSpec,
    gate_check,
    no_slice_drop_check,
    paired_all_zero_check,
    retrieval_unchanged_check,
    with_min_gate_n,
)
from rag_eval.profile_compare import baseline_from_report
from rag_eval.traces import load_manifest, load_traces

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_INVALID = 2
EXIT_INTERNAL = 70

MISSING_DATA = "missing_data"
GATES_JSON = "gates.json"
README = "README.md"
MODES = ("prechunked", "ingest")
INGEST = "ingest"
TEMPLATED_RATES = (
    "named_document_recall",
    "wrong_document_at_1",
    "variant_accuracy",
    "quantity_match_rate",
    "attribute_filter_fallback_rate",
)
SLICE_DELTA_PREFIXES = ("overall", "language:", "category:")

RunName = Annotated[str, Field(pattern=r"^tpl-[a-z0-9][a-z0-9-]{0,48}-(prechunked|ingest)$")]
Rate = Annotated[float, Field(ge=0, le=1)]
Tag = Annotated[str, Field(pattern=r"^feature:[a-z][a-z0-9_]{0,39}$")]
CategoryName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*$")]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def run_mode(name: str) -> str:
    return name.rsplit("-", 1)[1]


# ---------- gates file


class _Gate(_Model):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    decisions: list[Annotated[str, Field(pattern=r"^D-\d{2}$")]] = Field(min_length=1)
    requirements: list[Annotated[str, Field(pattern=r"^TPL-\d{2}$")]] = Field(min_length=1)

    def run_names(self) -> list[str]:
        raise NotImplementedError

    def ingest_runs(self) -> list[str]:
        """Runs that must be ingest-mode: the templated collection is loaded only there."""
        return []


class OffIdentityGate(_Gate):
    kind: Literal["off_identity"]
    runs: list[RunName] = Field(min_length=1)

    def run_names(self) -> list[str]:
        return list(self.runs)


class BoilerplateShareGate(_Gate):
    kind: Literal["boilerplate_share"]
    run: RunName
    control: RunName
    slice: Annotated[str, Field(pattern=r"^category:[a-z][a-z0-9_]*$")]
    max: Rate
    control_min: Rate

    def run_names(self) -> list[str]:
        return [self.run, self.control]

    def ingest_runs(self) -> list[str]:
        return [self.run, self.control]


class _TagGate(_Gate):
    run: RunName
    tag: Tag

    def run_names(self) -> list[str]:
        return [self.run]

    def ingest_runs(self) -> list[str]:
        return [self.run]


class NamedDocumentGate(_TagGate):
    kind: Literal["named_document"]
    k: Literal[5]
    recall_min: Rate
    wrong_document_at_1_max: Rate
    cited_asked_document_min: Rate


class VariantGate(_TagGate):
    kind: Literal["variant"]
    min: Rate


class QuantityGate(_TagGate):
    kind: Literal["quantity"]
    min: Rate
    require_lexical_leg: bool = True


class RunPair(_Model):
    run: RunName
    reference: RunName

    @model_validator(mode="after")
    def _same_mode(self) -> RunPair:
        if run_mode(self.run) != run_mode(self.reference):
            raise ValueError(f"{self.run} and {self.reference} must share a fixture mode")
        return self


class NoOtherSliceDropGate(_Gate):
    kind: Literal["no_other_slice_drop"]
    pairs: list[RunPair] = Field(min_length=1)
    exclude_categories: list[CategoryName] = Field(min_length=1)

    def run_names(self) -> list[str]:
        return [name for pair in self.pairs for name in (pair.run, pair.reference)]


Gate = Annotated[
    OffIdentityGate | BoilerplateShareGate | NamedDocumentGate | VariantGate | QuantityGate | NoOtherSliceDropGate,
    Field(discriminator="kind"),
]


class RetrievalMoves(_Model):
    pairs: list[RunPair] = Field(min_length=1)
    exclude_categories: list[CategoryName] = Field(min_length=1)


class ReportOnlySpec(_Model):
    fallback_rate_runs: list[RunName] = Field(min_length=1)
    retrieval_moves: RetrievalMoves
    single_switch: list[RunPair] = Field(min_length=1)
    notes: list[str] = Field(default_factory=list)

    def run_names(self) -> list[str]:
        names = list(self.fallback_rate_runs)
        for pair in [*self.retrieval_moves.pairs, *self.single_switch]:
            names += [pair.run, pair.reference]
        return names


class Phase33GatesSpec(_Model):
    schema_version: Literal[1]
    phase: Literal["03.3"]
    description: str = Field(min_length=1)
    comparison_spec: str = Field(min_length=1)
    noise: str = Field(min_length=1)
    gate_split: Literal["dev", "test"]
    min_dev_items: int = Field(ge=1)
    gates: list[Gate] = Field(min_length=1)
    report_only: ReportOnlySpec
    no_slice_drop_rule: SliceGateRule = Field(default_factory=SliceGateRule)

    @model_validator(mode="after")
    def _consistent(self) -> Phase33GatesSpec:
        ids = [gate.id for gate in self.gates]
        if len(set(ids)) != len(ids):
            raise ValueError("gate ids must be unique")
        for gate in self.gates:
            wrong = [name for name in gate.ingest_runs() if run_mode(name) != INGEST]
            if wrong:
                raise ValueError(f"gate {gate.id}: {', '.join(wrong)} must be ingest runs (templated fixtures load only there)")
        return self

    def run_names(self) -> list[str]:
        names = [name for gate in self.gates for name in gate.run_names()] + self.report_only.run_names()
        return list(dict.fromkeys(names))


# ---------- results


class GateOutcome(_Model):
    id: str
    kind: str
    decisions: list[str]
    requirements: list[str]
    passed: bool
    reason: str | None = None
    measures: dict[str, float | None] = Field(default_factory=dict)
    offenders: list[str] = Field(default_factory=list)
    alignment: list[str] = Field(default_factory=list)
    detail: list[str] = Field(default_factory=list)


class ReportOnlyRow(_Model):
    name: str
    run: str
    reference: str | None = None
    measures: dict[str, float | None] = Field(default_factory=dict)
    detail: list[str] = Field(default_factory=list)
    alignment: list[str] = Field(default_factory=list)


class Phase33GateResult(_Model):
    schema_version: Literal[1] = 1
    phase: str
    passed: bool
    spec_path: str
    spec_sha256: str
    spec_commit: str | None
    spec_commit_count: int
    comparison_spec_sha256: str
    gates: list[GateOutcome]
    report_only: list[ReportOnlyRow]
    failures: list[str]


class InputError(Exception):
    pass


# ---------- inputs


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_spec(path: Path) -> Phase33GatesSpec:
    return Phase33GatesSpec.model_validate_json(Path(path).read_text(encoding="utf-8"))


def spec_problems(spec: Phase33GatesSpec) -> tuple[list[str], SwitchComparisonSpec | None]:
    """Every run the gates name is a run of the comparison spec with the fixture mode its name ends in; the noise file reads."""
    problems: list[str] = []
    comparison: SwitchComparisonSpec | None = None
    try:
        comparison = SwitchComparisonSpec.model_validate_json(resolve_cli_path(spec.comparison_spec).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        problems.append(f"comparison spec {spec.comparison_spec} is unreadable: {exc}")
    try:
        NoiseConfig.model_validate_json(resolve_cli_path(spec.noise).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        problems.append(f"noise file {spec.noise} is unreadable: {exc}")
    if comparison is not None:
        modes = {run.name: run.fixture_mode for run in comparison.runs}
        for name in spec.run_names():
            if name not in modes:
                problems.append(f"run {name} is not in {spec.comparison_spec}")
            elif modes[name] != run_mode(name):
                problems.append(f"run {name} has fixture mode {modes[name]} in {spec.comparison_spec}, expected {run_mode(name)}")
    return problems, comparison


def read_run(reports_dir: Path, name: str) -> RunOutput:
    directory = reports_dir / name
    paths = [directory / "report.json", directory / "traces.jsonl", directory / "run.json"]
    if not all(path.is_file() for path in paths):
        raise InputError(f"run {name}: missing report.json, traces.jsonl or run.json in {repo_relative(directory)}")
    try:
        report = EvalReport.model_validate_json(paths[0].read_text(encoding="utf-8"))
        traces = load_traces(paths[1])
        manifest = load_manifest(paths[2])
        golden = load_golden(resolve_cli_path(manifest.golden_path))
    except (OSError, ValidationError, ValueError) as exc:
        raise InputError(f"run {name}: unreadable run directory: {exc}") from exc
    if manifest.run_id != report.run_id:
        raise InputError(f"run {name}: run.json and report.json describe different runs")
    return RunOutput(report=report, traces=traces, golden=golden)


def git_history(path: Path) -> tuple[str | None, int]:
    """The commit that last changed a tracked file and the number of commits that touched it."""
    try:
        relative = repo_relative(path)
        last = subprocess.run(
            ["git", "log", "-1", "--format=%H", "--", relative], capture_output=True, text=True, check=True, cwd=REPO_ROOT
        ).stdout.strip()
        count = subprocess.run(
            ["git", "rev-list", "--count", "HEAD", "--", relative], capture_output=True, text=True, check=True, cwd=REPO_ROOT
        ).stdout.strip()
        return (last or None), int(count or 0)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None, 0


# ---------- helpers


def _report_slice(report: EvalReport, slice_name: str) -> SliceMetrics | None:
    if slice_name == "overall":
        return report.overall
    kind, _, name = slice_name.partition(":")
    groups = {"language": report.by_language, "category": report.by_category, "pair": report.by_language_pair}
    return groups.get(kind, {}).get(name)


def _slice_values(report: EvalReport) -> dict[str, SliceMetrics]:
    rows: dict[str, SliceMetrics] = {"overall": report.overall}
    rows.update({f"language:{name}": metrics for name, metrics in report.by_language.items()})
    rows.update({f"category:{name}": metrics for name, metrics in report.by_category.items()})
    return rows


def _tag_items(output: RunOutput, tag: str, gate_split: str) -> list[tuple[GoldenItem, ItemResult]]:
    results = {item.item_id: item for item in output.report.items}
    return [
        (item, results[item.id])
        for item in output.golden
        if tag in item.tags and item.split == gate_split and item.id in results
    ]


def _rate(values: list[bool]) -> float | None:
    return sum(1 for value in values if value) / len(values) if values else None


def _outcome(gate: _Gate, passed: bool, **fields) -> GateOutcome:
    return GateOutcome(
        id=gate.id,
        kind=gate.kind,  # type: ignore[attr-defined]
        decisions=list(gate.decisions),
        requirements=list(gate.requirements),
        passed=passed,
        **fields,
    )


def _missing(gate: _Gate, detail: list[str], measures: dict[str, float | None] | None = None) -> GateOutcome:
    return _outcome(gate, False, reason=MISSING_DATA, detail=detail, measures=measures or {})


def without_categories(report: EvalReport, excluded: list[str]) -> EvalReport:
    """The report re-aggregated over the items outside the excluded categories."""
    items = [item for item in report.items if item.category not in set(excluded)]
    aggregated = aggregate(items, gate_split=report.golden_filter.gate_split)
    aggregated.pop(POPULATION_EXCLUSIONS)
    return report.model_copy(update={**aggregated, "items": items})


def aligned_reference(run: EvalReport, reference: EvalReport, *, tag: str) -> tuple[Baseline, list[str]]:
    """The reference run as a baseline, aligned on the run's corpus hash (ingest switches change it by design) and options."""
    baseline = baseline_from_report(reference, tag=tag)
    alignment: list[str] = []
    update: dict[str, object] = {"request_options": run.request_options}
    if baseline.corpus_sha256 != run.corpus_sha256:
        update["corpus_sha256"] = run.corpus_sha256
        alignment.append(f"corpus_sha256 of {tag} aligned on the run's ({(run.corpus_sha256 or 'none')[:12]})")
    if baseline.request_options != run.request_options:
        alignment.append(f"request options of {tag} aligned on the run's")
    return baseline.model_copy(update=update), alignment


# ---------- gate evaluators


def _off_identity(gate: OffIdentityGate, runs: Mapping[str, RunOutput], baselines: Mapping[str, Baseline], noise: NoiseConfig, _spec) -> GateOutcome:
    detail: list[str] = []
    offenders: list[str] = []
    for name in gate.runs:
        baseline = baselines.get(run_mode(name))
        if baseline is None:
            return _missing(gate, [f"no committed baseline for fixture mode {run_mode(name)}"])
        for check in (gate_check(runs[name], baseline, noise), paired_all_zero_check(runs[name], baseline, noise)):
            if not check.passed:
                offenders.append(f"{name}/{check.name}")
                detail.extend(f"{name}/{check.name}: {line}" for line in check.detail)
    return _outcome(gate, not offenders, offenders=offenders, detail=detail)


def _boilerplate_share(gate: BoilerplateShareGate, runs: Mapping[str, RunOutput], _baselines, _noise, _spec) -> GateOutcome:
    values: dict[str, float | None] = {}
    counts: dict[str, int] = {}
    for role, name in (("share", gate.run), ("control_share", gate.control)):
        metrics = _report_slice(runs[name].report, gate.slice)
        share = metrics.boilerplate_token_share if metrics is not None else None
        values[role] = share.value if share is not None else None
        counts[role] = share.n if share is not None else 0
    measures = {**values, "chunks": float(counts["share"]), "control_chunks": float(counts["control_share"])}
    unmeasured = [role for role, value in values.items() if value is None or counts[role] == 0]
    if unmeasured:
        return _missing(gate, [f"{gate.slice} boilerplate_token_share not measured ({', '.join(unmeasured)})"], measures)
    offenders = []
    if values["share"] > gate.max:
        offenders.append(f"{gate.run}:{gate.slice}")
    if values["control_share"] < gate.control_min:
        offenders.append(f"{gate.control}:{gate.slice}")
    return _outcome(gate, not offenders, measures=measures, offenders=offenders)


def _named_document(gate: NamedDocumentGate, runs: Mapping[str, RunOutput], _baselines, _noise, spec: Phase33GatesSpec) -> GateOutcome:
    output = runs[gate.run]
    rows = _tag_items(output, gate.tag, spec.gate_split)
    traces = {trace.item_id: trace for trace in output.traces if trace.item_id is not None}
    hits = [result.named_document_hit for _, result in rows if result.named_document_hit is not None]
    wrong = [result.wrong_document_at_1 for _, result in rows if result.wrong_document_at_1 is not None]
    cited: list[bool] = []
    offenders: list[str] = []
    for item, result in rows:
        trace = traces.get(item.id)
        asked = item.gold_evidence[0].document.casefold() if item.gold_evidence else None
        valid = [citation for citation in trace.citations if citation_is_valid(trace, citation)] if trace is not None else []
        names_asked = bool(valid) and asked is not None and all(c.documentName.casefold() == asked for c in valid)
        cited.append(names_asked)
        if result.named_document_hit is not True or result.wrong_document_at_1 is True or not names_asked:
            offenders.append(item.id)
    measures = {
        "dev_items": float(len(rows)),
        "named_document_recall": _rate(hits),
        "wrong_document_at_1": _rate(wrong),
        "cited_asked_document": _rate(cited),
    }
    short = [label for label, values in (("recall", hits), ("wrong_document_at_1", wrong), ("cited", cited)) if len(values) < spec.min_dev_items]
    if short:
        return _missing(gate, [f"{gate.tag}: fewer than {spec.min_dev_items} defined dev values ({', '.join(short)})"], measures)
    passed = (
        measures["named_document_recall"] >= gate.recall_min
        and measures["wrong_document_at_1"] <= gate.wrong_document_at_1_max
        and measures["cited_asked_document"] >= gate.cited_asked_document_min
    )
    return _outcome(gate, passed, measures=measures, offenders=sorted(offenders))


def _flag_gate(field: str, require_all: bool) -> Callable:
    def evaluate(gate, runs: Mapping[str, RunOutput], _baselines, _noise, spec: Phase33GatesSpec) -> GateOutcome:
        rows = _tag_items(runs[gate.run], gate.tag, spec.gate_split)
        values = [getattr(result, field) for _, result in rows]
        defined = [value for value in values if value is not None]
        measures = {"dev_items": float(len(rows)), "defined": float(len(defined)), field: _rate(defined)}
        if len(defined) < spec.min_dev_items:
            return _missing(gate, [f"{gate.tag}: {len(defined)} defined dev value(s), at least {spec.min_dev_items} required"], measures)
        if require_all and len(defined) != len(values):
            undefined = sorted(item.id for item, result in rows if getattr(result, field) is None)
            missing = _missing(gate, [f"{gate.tag}: {field} undefined (lexical leg did not run)"], measures)
            return missing.model_copy(update={"offenders": undefined})
        offenders = sorted(item.id for item, result in rows if getattr(result, field) is False)
        return _outcome(gate, measures[field] >= gate.min, measures=measures, offenders=offenders)

    return evaluate


def _no_other_slice_drop(gate: NoOtherSliceDropGate, runs: Mapping[str, RunOutput], _baselines, noise: NoiseConfig, _spec) -> GateOutcome:
    offenders: list[str] = []
    detail: list[str] = []
    alignment: list[str] = []
    for pair in gate.pairs:
        run, reference = runs[pair.run], runs[pair.reference]
        observed = without_categories(run.report, gate.exclude_categories)
        baseline, aligned = aligned_reference(observed, without_categories(reference.report, gate.exclude_categories), tag=pair.reference)
        alignment.extend(f"{pair.run}: {line}" for line in aligned)
        check = no_slice_drop_check(RunOutput(report=observed, traces=run.traces, golden=run.golden), baseline, noise)
        if not check.passed:
            offenders.append(pair.run)
            detail.extend(f"{pair.run}: {line}" for line in check.detail)
    return _outcome(gate, not offenders, offenders=offenders, detail=detail, alignment=alignment)


EVALUATORS: dict[str, Callable] = {
    "off_identity": _off_identity,
    "boilerplate_share": _boilerplate_share,
    "named_document": _named_document,
    "variant": _flag_gate("variant_correct", require_all=False),
    "quantity": _flag_gate("quantity_matched", require_all=True),
    "no_other_slice_drop": _no_other_slice_drop,
}


def evaluate_gate(gate, runs, baselines, noise, spec) -> GateOutcome:
    if gate.kind == "quantity" and not gate.require_lexical_leg:
        return _flag_gate("quantity_matched", require_all=False)(gate, runs, baselines, noise, spec)
    return EVALUATORS[gate.kind](gate, runs, baselines, noise, spec)


# ---------- report-only


def _templated_rates(report: EvalReport) -> dict[str, float | None]:
    metrics = report.by_category.get(TEMPLATED_CATEGORY)
    rates: dict[str, float | None] = {}
    for field in TEMPLATED_RATES:
        value = getattr(metrics, field) if metrics is not None else None
        rates[field] = value.value if value is not None else None
    return rates


def _slice_deltas(run: EvalReport, reference: EvalReport) -> dict[str, float | None]:
    observed, recorded = _slice_values(run), _slice_values(reference)
    deltas: dict[str, float | None] = {}
    for name in sorted(set(observed) | set(recorded)):
        if not name.startswith(SLICE_DELTA_PREFIXES):
            continue
        for metric in RETRIEVAL_METRICS:
            on = getattr(observed[name], metric).value if name in observed else None
            off = getattr(recorded[name], metric).value if name in recorded else None
            deltas[f"{name}:{metric}"] = on - off if on is not None and off is not None else None
    return deltas


def report_only_rows(spec: ReportOnlySpec, runs: Mapping[str, RunOutput], noise: NoiseConfig) -> list[ReportOnlyRow]:
    rows: list[ReportOnlyRow] = []
    for name in spec.fallback_rate_runs:
        fallback = runs[name].report.overall.attribute_filter_fallback_rate
        rows.append(
            ReportOnlyRow(
                name="attribute_filter_fallback_rate",
                run=name,
                measures={
                    "attribute_filter_fallback_rate": fallback.value if fallback is not None else None,
                    "n": float(fallback.n) if fallback is not None else 0.0,
                },
            )
        )
    for pair in spec.retrieval_moves.pairs:
        run = runs[pair.run]
        baseline, alignment = aligned_reference(run.report, runs[pair.reference].report, tag=pair.reference)
        check: CheckResult = retrieval_unchanged_check(
            run, baseline, noise, exclude_categories=list(spec.retrieval_moves.exclude_categories)
        )
        rows.append(
            ReportOnlyRow(
                name="retrieval_unchanged",
                run=pair.run,
                reference=pair.reference,
                measures={"unchanged": 1.0 if check.passed else 0.0, "moved_cells": float(len(check.detail))},
                detail=list(check.detail),
                alignment=alignment,
            )
        )
    for pair in spec.single_switch:
        run, reference = runs[pair.run].report, runs[pair.reference].report
        rows.append(
            ReportOnlyRow(
                name="single_switch",
                run=pair.run,
                reference=pair.reference,
                measures={**_templated_rates(run), **{f"delta:{key}": value for key, value in _slice_deltas(run, reference).items()}},
            )
        )
    return rows


# ---------- evaluation


def evaluate_phase33(
    spec: Phase33GatesSpec,
    runs: Mapping[str, RunOutput],
    baselines: Mapping[str, Baseline],
    noise: NoiseConfig,
    *,
    spec_path: str,
    spec_sha256: str,
    spec_commit: str | None,
    spec_commit_count: int,
    comparison_spec_sha256: str,
) -> Phase33GateResult:
    outcomes = [evaluate_gate(gate, runs, baselines, noise, spec) for gate in spec.gates]
    failures = [
        f"{outcome.id}: {outcome.reason or 'failed'}" + (f" ({', '.join(outcome.offenders[:10])})" if outcome.offenders else "")
        for outcome in outcomes
        if not outcome.passed
    ]
    return Phase33GateResult(
        phase=spec.phase,
        passed=not failures,
        spec_path=spec_path,
        spec_sha256=spec_sha256,
        spec_commit=spec_commit,
        spec_commit_count=spec_commit_count,
        comparison_spec_sha256=comparison_spec_sha256,
        gates=outcomes,
        report_only=report_only_rows(spec.report_only, runs, noise),
        failures=failures,
    )


def _num(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def render_markdown(result: Phase33GateResult) -> str:
    lines = [
        f"# Phase {result.phase} gates: {'PASS' if result.passed else 'FAIL'}",
        "",
        (
            f"- Gates file: `{result.spec_path}` (sha256 {result.spec_sha256[:12]}, last commit "
            f"{(result.spec_commit or 'untracked')[:12]}, {result.spec_commit_count} commit(s))"
        ),
        "",
        "## Requirements",
        "",
        "| Requirement | Gates | Verdict |",
        "|---|---|---|",
    ]
    by_requirement: dict[str, list[GateOutcome]] = {}
    for outcome in result.gates:
        for requirement in outcome.requirements:
            by_requirement.setdefault(requirement, []).append(outcome)
    for requirement, outcomes in sorted(by_requirement.items()):
        verdict = "pass" if all(outcome.passed for outcome in outcomes) else "fail"
        lines.append(f"| {requirement} | {', '.join(outcome.id for outcome in outcomes)} | {verdict} |")
    lines += ["", "## Gates", "", "| Gate | Decisions | Verdict | Measures | Offenders |", "|---|---|---|---|---|"]
    for outcome in result.gates:
        verdict = "pass" if outcome.passed else f"fail{' (' + outcome.reason + ')' if outcome.reason else ''}"
        measures = "; ".join(f"{key} {_num(value)}" for key, value in outcome.measures.items()) or "-"
        offenders = ", ".join(outcome.offenders[:20]) or "-"
        lines.append(f"| {outcome.id} | {', '.join(outcome.decisions)} | {verdict} | {measures} | {offenders} |")
    alignment = [f"- {outcome.id}: {line}" for outcome in result.gates for line in outcome.alignment]
    if alignment:
        lines += ["", "## Alignment", "", *alignment]
    lines += ["", "## Report-only", "", "| Measure | Run | Reference | Values |", "|---|---|---|---|"]
    for row in result.report_only:
        values = "; ".join(f"{key} {_num(value)}" for key, value in row.measures.items() if not key.startswith("delta:"))
        lines.append(f"| {row.name} | {row.run} | {row.reference or '-'} | {values or '-'} |")
    lines.append("")
    return "\n".join(lines)


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _cmd_check(args: argparse.Namespace) -> int:
    spec = load_spec(resolve_cli_path(args.spec))
    problems, _ = spec_problems(spec)
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return EXIT_INVALID
    print(f"phase33_gate: {len(spec.gates)} gate(s) valid against {spec.comparison_spec}")
    return EXIT_PASS


def _cmd_evaluate(args: argparse.Namespace) -> int:
    spec_path = resolve_cli_path(args.spec)
    spec = load_spec(spec_path)
    problems, comparison = spec_problems(spec)
    if problems or comparison is None:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return EXIT_INVALID
    noise = with_min_gate_n(
        NoiseConfig.model_validate_json(resolve_cli_path(spec.noise).read_text(encoding="utf-8")), spec.no_slice_drop_rule.min_gate_n
    )
    baselines = {
        mode: Baseline.model_validate_json(resolve_cli_path(path).read_text(encoding="utf-8"))
        for mode, path in comparison.baselines.items()
    }
    reports_dir = resolve_cli_path(args.reports)
    runs = {name: read_run(reports_dir, name) for name in spec.run_names()}
    commit, count = git_history(spec_path)
    result = evaluate_phase33(
        spec,
        runs,
        baselines,
        noise,
        spec_path=repo_relative(spec_path),
        spec_sha256=sha256_file(spec_path),
        spec_commit=commit,
        spec_commit_count=count,
        comparison_spec_sha256=sha256_file(resolve_cli_path(spec.comparison_spec)),
    )
    out_dir = resolve_cli_path(args.out)
    _write_text(out_dir / GATES_JSON, result.model_dump_json(indent=2) + "\n")
    _write_text(out_dir / README, render_markdown(result))
    if not result.passed:
        print("phase33_gate: FAIL", file=sys.stderr)
        for failure in result.failures:
            print(f"  {failure}", file=sys.stderr)
        return EXIT_FAIL
    print(f"phase33_gate: PASS ({len(result.gates)} gate(s))")
    return EXIT_PASS


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.phase33_gate", description="Phase 3.3 pre-registered gates")
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check")
    check.add_argument("--spec", required=True, type=Path)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--spec", required=True, type=Path)
    evaluate.add_argument("--reports", required=True, type=Path)
    evaluate.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
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
        print(f"phase33_gate: INTERNAL ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
