"""Phase 4.2 gates: every gate and decision rule is read from the pre-registered spec eval/config/phase42-gates.json (D-37)."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, ValidationError, model_validator
from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport, ItemResult, SliceMetrics

from rag_eval.calibrate.refusal import CalibrationResult, CellRecord
from rag_eval.golden_io import load_golden
from rag_eval.harness_runner import HarnessError
from rag_eval.matching import chunk_matches_span
from rag_eval.metrics import is_identifier_item
from rag_eval.ndcg import gold_unit_first_hits
from rag_eval.paired import item_metrics
from rag_eval.paths import repo_relative, resolve_cli_path
from rag_eval.phase_compare import (
    HARNESS_DIR,
    ComparisonError,
    RunOutput,
    RunRequest,
    _Model,
    _read_model,
    _slice,
    _write_text,
    default_runner,
    materialise_run_config,
    paired_all_zero_check,
    slice_drops,
)
from rag_eval.phase_compare import RunSpec as CompareRunSpec
from rag_eval.profile_compare import baseline_from_report
from rag_eval.traces import load_manifest, load_traces

FixtureMode = Literal["prechunked", "ingest"]
RetrievalMetric = Literal["recall_at_5", "recall_at_10", "mrr"]
RefusalModeName = Literal["strict", "balanced", "flexible"]
Runner = Callable[[RunRequest], RunOutput]

PHASE42_SWITCHES = frozenset(
    {
        "RAG_LEXICAL_DICTIONARY",
        "RAG_LEXICAL_STEM_IT",
        "RAG_VERSION_SCOPE",
        "RAG_TABLE_LOOKUP",
        "RAG_DUP_CLUSTERS",
        "RAG_RESULT_DIVERSITY",
        "RAG_IDENTIFIER_INDEX",
        "RAG_IDENTIFIER_FILTER",
    }
)
GATE_NAMES = ("off_identity", "diversity", "identifier", "table", "versions", "dictionary")
RULE_NAMES = ("stem_it", "refusal_mode_cells")
SELECTABLE = (*GATE_NAMES, *RULE_NAMES)
STEM_OUTCOMES = ("flip", "keep_off")
CELL_OUTCOMES = ("commit", "keep")
INSUFFICIENT = "insufficient_data"
JSON_NAME = "gates.json"
MARKDOWN_NAME = "README.md"
REDUNDANCY_TOLERANCE = 1e-9

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_HARNESS = 3

FIXTURE_NOTE = (
    "Fixture corpus only: every gate, threshold and rule here was committed before any gated run (D-37, pre-registration). "
    "Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare."
)


# ---------- spec


class RunEntry(_Model):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    base: str | None = None
    fixture_mode: FixtureMode
    env: dict[str, str] = Field(default_factory=dict)
    phase42_off: bool = False


class OffPair(_Model):
    run: str
    reference: str


class OffIdentityGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    against_baseline: list[str] = Field(min_length=1)
    against_run: list[OffPair] = Field(default_factory=list)


class DiversityGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    runs: list[str] = Field(min_length=1)
    reference: str
    slice: str
    intent_coverage_min: float = Field(ge=0, le=1)
    max_chunks_per_cluster: int = Field(ge=1)
    no_slice_drop_exclude: list[str] = Field(default_factory=list)


class DescriptiveSpec(_Model):
    definition: str = Field(min_length=1)
    max_asked: int = Field(ge=0)
    min_items: int = Field(ge=1)
    metrics: list[RetrievalMetric] = Field(min_length=1)


class IdentifierGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    run: str
    reference: str
    slice: str
    identifier_precision_min: float = Field(ge=0, le=1)
    near_miss_leakage_max: float = Field(ge=0, le=1)
    descriptive: DescriptiveSpec
    no_slice_drop_exclude: list[str] = Field(default_factory=list)


class TableGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    run: str
    reference: str
    tag: str = Field(min_length=1)
    leg: str = Field(min_length=1)
    min_items: int = Field(ge=1)
    no_slice_drop_exclude: list[str] = Field(default_factory=list)


class VersionsGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    run: str
    reference: str
    tag: str = Field(min_length=1)
    min_items: int = Field(ge=1)
    min_superseded_kept: int = Field(ge=0)
    no_slice_drop_exclude: list[str] = Field(default_factory=list)


class DictionaryGate(_Model):
    decision: str = Field(min_length=1)
    description: str
    run: str
    reference: str
    no_slice_drop_exclude: list[str] = Field(default_factory=list)


class GateSpecs(_Model):
    off_identity: OffIdentityGate
    diversity: DiversityGate
    identifier: IdentifierGate
    table: TableGate
    versions: VersionsGate
    dictionary: DictionaryGate


class StemRule(_Model):
    decision: str = Field(min_length=1)
    description: str
    run: str
    reference: str
    slice: str
    metric: RetrievalMetric
    outcomes: list[str]

    @model_validator(mode="after")
    def _outcomes(self) -> StemRule:
        if tuple(self.outcomes) != STEM_OUTCOMES:
            raise ValueError(f"stem_it outcomes must be {list(STEM_OUTCOMES)}")
        return self


class RefusalCellRule(_Model):
    decision: str = Field(min_length=1)
    description: str
    modes: list[RefusalModeName] = Field(min_length=1)
    dev_fit_status: str = Field(min_length=1)
    holdout_status: str = Field(min_length=1)
    strict_mode: RefusalModeName
    strict_not_below_base: bool
    skip_insufficient_data: bool
    outcomes: list[str]

    @model_validator(mode="after")
    def _outcomes(self) -> RefusalCellRule:
        if tuple(self.outcomes) != CELL_OUTCOMES:
            raise ValueError(f"refusal_mode_cells outcomes must be {list(CELL_OUTCOMES)}")
        if self.strict_mode not in self.modes:
            raise ValueError("strict_mode must be one of modes")
        return self


class RuleSpecs(_Model):
    stem_it: StemRule
    refusal_mode_cells: RefusalCellRule


class ReportOnlyEntry(_Model):
    metric: str = Field(min_length=1)
    note: str


class Phase42GateSpec(_Model):
    schema_version: Literal[1] = 1
    phase: str
    noise: str
    baselines: dict[FixtureMode, str]
    calibration_result: str
    phase42_off_env: dict[str, str]
    runs: list[RunEntry] = Field(min_length=1)
    gates: GateSpecs
    rules: RuleSpecs
    report_only: list[ReportOnlyEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _references(self) -> Phase42GateSpec:
        names = [run.name for run in self.runs]
        if len(names) != len(set(names)):
            raise ValueError("run names must be unique")
        if set(self.phase42_off_env) != PHASE42_SWITCHES:
            raise ValueError(f"phase42_off_env must name exactly the Phase 4.2 switches: {', '.join(sorted(PHASE42_SWITCHES))}")
        by_name = {run.name: run for run in self.runs}
        missing = sorted({name for gate in SELECTABLE for name in runs_for(self, gate) if name not in by_name})
        if missing:
            raise ValueError(f"gates name unknown runs: {', '.join(missing)}")
        for name in self.gates.off_identity.against_baseline:
            if not by_name[name].phase42_off:
                raise ValueError(f"off_identity run {name} must set phase42_off")
        for pair in self.gates.off_identity.against_run:
            if not by_name[pair.run].phase42_off:
                raise ValueError(f"off_identity run {pair.run} must set phase42_off")
        for on, reference in _comparisons(self):
            if by_name[on].fixture_mode != by_name[reference].fixture_mode:
                raise ValueError(f"run {on} and its reference {reference} must use the same fixture mode")
        if not {run.fixture_mode for run in self.runs} <= set(self.baselines):
            raise ValueError("every fixture mode used by a run needs a baseline")
        return self


def _comparisons(spec: Phase42GateSpec) -> list[tuple[str, str]]:
    g, r = spec.gates, spec.rules
    pairs = [(pair.run, pair.reference) for pair in g.off_identity.against_run]
    pairs += [(run, g.diversity.reference) for run in g.diversity.runs]
    pairs += [(gate.run, gate.reference) for gate in (g.identifier, g.table, g.versions, g.dictionary)]
    pairs.append((r.stem_it.run, r.stem_it.reference))
    return pairs


def runs_for(spec: Phase42GateSpec, gate: str) -> list[str]:
    g, r = spec.gates, spec.rules
    if gate == "off_identity":
        return [*g.off_identity.against_baseline, *(name for pair in g.off_identity.against_run for name in (pair.run, pair.reference))]
    if gate == "diversity":
        return [*g.diversity.runs, g.diversity.reference]
    if gate in ("identifier", "table", "versions", "dictionary"):
        entry = getattr(g, gate)
        return [entry.run, entry.reference]
    if gate == "stem_it":
        return [r.stem_it.run, r.stem_it.reference]
    if gate == "refusal_mode_cells":
        return []
    raise ComparisonError(f"unknown gate {gate!r}; choose from {', '.join(SELECTABLE)}")


def run_config_for(spec: Phase42GateSpec, run: RunEntry) -> dict[str, Any]:
    env = {**(spec.phase42_off_env if run.phase42_off else {}), **run.env}
    if run.base is None:
        return {"name": run.name, "env": env, "overrides": None}
    if not resolve_cli_path(run.base).is_file():
        raise ComparisonError(f"run {run.name}: run config {run.base} does not exist")
    return materialise_run_config(CompareRunSpec(name=run.name, base=run.base, fixture_mode=run.fixture_mode, env=env), [])


# ---------- results


Number = float | int | None


class GateOutcome(_Model):
    name: str
    decision: str
    passed: bool
    runs: list[str]
    numbers: dict[str, Number] = Field(default_factory=dict)
    offenders: list[str] = Field(default_factory=list)


class RuleOutcome(_Model):
    name: str
    decision: str
    outcome: str
    numbers: dict[str, Number] = Field(default_factory=dict)
    reasons: list[str] = Field(default_factory=list)


class RunSummary(_Model):
    name: str
    fixture_mode: str
    env: dict[str, str]
    run_config_hash: str
    overall: SliceMetrics


class Phase42Gates(_Model):
    schema_version: Literal[1] = 1
    phase: str
    passed: bool
    selected: list[str]
    noise_floor: float
    noise_k: float
    gates: list[GateOutcome]
    decisions: list[RuleOutcome]
    runs: list[RunSummary]
    report_only: list[ReportOnlyEntry]
    notes: list[str]


# ---------- helpers over one run


def _gated(output: RunOutput) -> list[ItemResult]:
    split = output.report.golden_filter.gate_split
    return [item for item in output.report.items if item.split == split]


def _slice_members(output: RunOutput, slice_name: str) -> list[ItemResult]:
    items = _gated(output)
    if slice_name == "overall":
        return items
    kind, _, name = slice_name.partition(":")
    if kind == "category":
        return [item for item in items if item.category == name]
    if kind == "language":
        return [item for item in items if item.language == name]
    raise ComparisonError(f"slice {slice_name!r} must be overall, language:<code> or category:<name>")


def _traces(output: RunOutput) -> dict[str, Any]:
    return {trace.item_id: trace for trace in output.traces if trace.item_id is not None}


def _tagged(output: RunOutput, tag: str) -> list[GoldenItem]:
    scored = {item.item_id for item in output.report.items}
    return [item for item in output.golden if tag in item.tags and item.id in scored]


def _band(reference: Baseline, slice_name: str, metric: str, noise: NoiseConfig) -> float:
    stat = reference.slices.get(slice_name, {}).get(metric)
    spread = stat.spread if stat is not None else 0.0
    return max(noise.k * spread, noise.floor)


def _reference(output: RunOutput, name: str) -> Baseline:
    return baseline_from_report(output.report, tag=name)


def drop_offenders(on: RunOutput, reference: RunOutput, noise: NoiseConfig, *, reference_name: str, exclude: Iterable[str] = ()) -> list[str]:
    """Every overall, language and category slice on Recall@5, Recall@10 and MRR against the reference run (phase_compare.slice_drops)."""
    skip = set(exclude)
    gate = slice_drops(on.report, _reference(reference, reference_name), noise)
    found = [f"report and reference {reference_name} differ: {problem}" for problem in gate.mismatches]
    found += [
        f"{o.slice}:{o.metric} dropped beyond the noise band ({o.observed:.4f} < {o.threshold:.4f}, {reference_name} {o.baseline_mean:.4f})"
        for o in gate.offenders
        if o.slice not in skip
    ]
    return found


def _outcome(name: str, decision: str, runs: list[str], numbers: dict[str, Number], offenders: list[str]) -> GateOutcome:
    return GateOutcome(name=name, decision=decision, passed=not offenders, runs=runs, numbers=numbers, offenders=offenders)


# ---------- gates


def off_identity_gate(
    gate: OffIdentityGate, outputs: Mapping[str, RunOutput], modes: Mapping[str, str], baselines: Mapping[str, Baseline], noise: NoiseConfig
) -> GateOutcome:
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    runs: list[str] = []
    for name in gate.against_baseline:
        check = paired_all_zero_check(outputs[name], baselines[modes[name]], noise)
        numbers[f"{name}.nonzero_cells"] = len(check.detail) if not check.passed else 0
        offenders += [f"{name} vs {modes[name]} baseline: {detail}" for detail in check.detail or ["paired differences not all zero"]] if not check.passed else []
        runs.append(name)
    for pair in gate.against_run:
        check = paired_all_zero_check(outputs[pair.run], _reference(outputs[pair.reference], pair.reference), noise)
        numbers[f"{pair.run}.nonzero_cells"] = len(check.detail) if not check.passed else 0
        offenders += [f"{pair.run} vs {pair.reference}: {detail}" for detail in check.detail or ["paired differences not all zero"]] if not check.passed else []
        runs += [pair.run, pair.reference]
    return _outcome("off_identity", gate.decision, runs, numbers, offenders)


def diversity_gate(gate: DiversityGate, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> GateOutcome:
    offenders: list[str] = []
    numbers: dict[str, Number] = {}
    reference = outputs[gate.reference]
    for name in gate.runs:
        output = outputs[name]
        members = _slice_members(output, gate.slice)
        numbers[f"{name}.items"] = len(members)
        if not members:
            offenders.append(f"{name}: no gated item in {gate.slice}")
            continue
        metrics = _slice(output.report, gate.slice)
        coverage = metrics.intent_coverage if metrics is not None else None
        numbers[f"{name}.intent_coverage"] = coverage.value if coverage is not None else None
        if coverage is None or coverage.value is None:
            offenders.append(f"{name}: {gate.slice} intent_coverage not measured")
        elif coverage.value < gate.intent_coverage_min:
            offenders.append(f"{name}: {gate.slice} intent_coverage {coverage.value:.4f} < {gate.intent_coverage_min:.4f}")
        worst: float | None = None
        for item in members:
            k, redundancy = item.context_k, item.topk_redundancy
            if not k or redundancy is None:
                offenders.append(f"{name}: {item.item_id} has no context (topk_redundancy not measured)")
                continue
            limit = gate.max_chunks_per_cluster / k
            excess = redundancy - limit
            worst = excess if worst is None else max(worst, excess)
            if excess > REDUNDANCY_TOLERANCE:
                offenders.append(f"{name}: {item.item_id} topk_redundancy {redundancy:.4f} > {gate.max_chunks_per_cluster}/{k} = {limit:.4f}")
        numbers[f"{name}.max_redundancy_over_limit"] = worst
        offenders += [f"{name}: {line}" for line in drop_offenders(output, reference, noise, reference_name=gate.reference, exclude=gate.no_slice_drop_exclude)]
    return _outcome("diversity", gate.decision, [*gate.runs, gate.reference], numbers, offenders)


def descriptive_ids(output: RunOutput, max_asked: int) -> list[str]:
    """Gated items whose trace carries an identifier block with at most max_asked asked identifiers (the pipeline's own extraction)."""
    traces = _traces(output)
    ids = []
    for item in _gated(output):
        trace = traces.get(item.item_id)
        if trace is not None and trace.identifier is not None and trace.identifier.asked <= max_asked:
            ids.append(item.item_id)
    return sorted(ids)


def _mean_over(items: Iterable[ItemResult], metric: str) -> float | None:
    values = [value for item in items if (value := item_metrics(item)[metric]) is not None]
    return sum(values) / len(values) if values else None


def identifier_members(output: RunOutput, slice_name: str) -> list[ItemResult]:
    """The gated items of the slice plus the gated no_answer items that ask about an absent identifier (D-32, plan 04.2-37)."""
    members = _slice_members(output, slice_name)
    seen = {item.item_id for item in members}
    golden = {item.id: item for item in output.golden}
    absent = [
        item
        for item in _gated(output)
        if item.item_id not in seen
        and (source := golden.get(item.item_id)) is not None
        and source.category == "no_answer"
        and is_identifier_item(source)
    ]
    return [*members, *absent]


def identifier_gate(gate: IdentifierGate, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> GateOutcome:
    on, reference = outputs[gate.run], outputs[gate.reference]
    offenders: list[str] = []
    members = identifier_members(on, gate.slice)
    numbers: dict[str, Number] = {"items": len(members)}
    if not members:
        offenders.append(f"no gated item in {gate.slice}")
    for field, item_field, bound, higher in (
        ("identifier_precision", "identifier_precise", gate.identifier_precision_min, True),
        ("near_miss_leakage", "near_miss_leak", gate.near_miss_leakage_max, False),
    ):
        measured = [float(value) for item in members if (value := getattr(item, item_field)) is not None]
        mean = sum(measured) / len(measured) if measured else None
        numbers[field] = mean
        numbers[f"{field}_n"] = len(measured)
        if mean is None:
            offenders.append(f"{gate.slice} {field} not measured")
        elif len(measured) != len(members):
            offenders.append(f"{gate.slice} {field} measured on {len(measured)} of {len(members)} item(s)")
        elif (higher and mean < bound) or (not higher and mean > bound):
            offenders.append(f"{gate.slice} {field} {mean:.4f} {'<' if higher else '>'} {bound:.4f}")
    ids = descriptive_ids(on, gate.descriptive.max_asked)
    numbers["descriptive_items"] = len(ids)
    if len(ids) < gate.descriptive.min_items:
        offenders.append(f"descriptive slice has {len(ids)} item(s), fewer than {gate.descriptive.min_items}")
    else:
        on_items = {item.item_id: item for item in _gated(on)}
        ref_items = {item.item_id: item for item in _gated(reference)}
        absent = [item_id for item_id in ids if item_id not in ref_items]
        if absent:
            offenders.append(f"descriptive item(s) missing from {gate.reference}: {', '.join(absent)}")
        shared = [item_id for item_id in ids if item_id in ref_items]
        for metric in gate.descriptive.metrics:
            observed = _mean_over((on_items[i] for i in shared), metric)
            recorded = _mean_over((ref_items[i] for i in shared), metric)
            numbers[f"descriptive.{metric}"] = observed
            numbers[f"descriptive.{metric}.reference"] = recorded
            if observed is None or recorded is None:
                continue
            if observed < recorded - noise.floor:
                offenders.append(
                    f"descriptive:{metric} dropped beyond the noise band ({observed:.4f} < {recorded - noise.floor:.4f}, {gate.reference} {recorded:.4f})"
                )
    offenders += drop_offenders(on, reference, noise, reference_name=gate.reference, exclude=gate.no_slice_drop_exclude)
    return _outcome("identifier", gate.decision, [gate.run, gate.reference], numbers, offenders)


def _all_units_kept(trace: Any, item: GoldenItem) -> bool:
    if trace is None or trace.refused or not trace.kept:
        return False
    units = gold_unit_first_hits(trace, item)
    return bool(units) and all(position is not None for position in units)


def table_gate(gate: TableGate, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> GateOutcome:
    on, reference = outputs[gate.run], outputs[gate.reference]
    items = _tagged(on, gate.tag)
    traces = _traces(on)
    offenders: list[str] = []
    if len(items) < gate.min_items:
        offenders.append(f"{len(items)} item(s) tagged {gate.tag}, fewer than {gate.min_items}")
    with_leg = 0
    for item in items:
        trace = traces.get(item.id)
        if not _all_units_kept(trace, item):
            offenders.append(f"{item.id}: a gold unit has no kept chunk")
        candidates = trace.candidates if trace is not None else []
        gold = [c for c in candidates if any(chunk_matches_span(c.document_name or "", c.content, span) for span in item.gold_evidence)]
        if any(gate.leg in c.legs for c in gold):
            with_leg += 1
        else:
            offenders.append(f"{item.id}: no gold candidate carries the {gate.leg} list")
    offenders += drop_offenders(on, reference, noise, reference_name=gate.reference, exclude=gate.no_slice_drop_exclude)
    return _outcome("table", gate.decision, [gate.run, gate.reference], {"items": len(items), "items_with_leg": with_leg}, offenders)


def versions_gate(gate: VersionsGate, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> GateOutcome:
    on, reference = outputs[gate.run], outputs[gate.reference]
    items = _tagged(on, gate.tag)
    on_traces, ref_traces = _traces(on), _traces(reference)
    offenders: list[str] = []
    if len(items) < gate.min_items:
        offenders.append(f"{len(items)} item(s) tagged {gate.tag}, fewer than {gate.min_items}")
    superseded_total = 0
    for item in items:
        trace = on_traces.get(item.id)
        if not _all_units_kept(trace, item):
            offenders.append(f"{item.id}: an evidence group has no kept chunk")
        superseded = [chunk for chunk in (trace.kept if trace is not None else []) if chunk.is_current is False]
        superseded_total += len(superseded)
        if len(superseded) < gate.min_superseded_kept:
            offenders.append(f"{item.id}: {len(superseded)} superseded chunk(s) kept, fewer than {gate.min_superseded_kept}")
        offenders += [f"{item.id}: superseded chunk {chunk.chunk_id} has no document_version" for chunk in superseded if chunk.document_version is None]
        ref_trace = ref_traces.get(item.id)
        if ref_trace is None:
            offenders.append(f"{item.id}: missing from {gate.reference}")
        else:
            offenders += [
                f"{item.id}: {gate.reference} keeps superseded chunk {chunk.chunk_id}" for chunk in ref_trace.kept if chunk.is_current is False
            ]
    offenders += drop_offenders(on, reference, noise, reference_name=gate.reference, exclude=gate.no_slice_drop_exclude)
    return _outcome("versions", gate.decision, [gate.run, gate.reference], {"items": len(items), "superseded_kept": superseded_total}, offenders)


def dictionary_gate(gate: DictionaryGate, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> GateOutcome:
    offenders = drop_offenders(outputs[gate.run], outputs[gate.reference], noise, reference_name=gate.reference, exclude=gate.no_slice_drop_exclude)
    return _outcome("dictionary", gate.decision, [gate.run, gate.reference], {}, offenders)


# ---------- decision rules


def stem_rule(rule: StemRule, outputs: Mapping[str, RunOutput], noise: NoiseConfig) -> RuleOutcome:
    on, reference = outputs[rule.run], outputs[rule.reference]
    baseline = _reference(reference, rule.reference)
    on_metrics, ref_metrics = _slice(on.report, rule.slice), _slice(reference.report, rule.slice)
    observed = getattr(on_metrics, rule.metric).value if on_metrics is not None else None
    recorded = getattr(ref_metrics, rule.metric).value if ref_metrics is not None else None
    gain = None if observed is None or recorded is None else observed - recorded
    band = _band(baseline, rule.slice, rule.metric, noise)
    reasons = drop_offenders(on, reference, noise, reference_name=rule.reference)
    if gain is None:
        reasons.append(f"{rule.slice} {rule.metric} not measured in one of the runs")
    elif gain <= band:
        reasons.append(f"{rule.slice} {rule.metric} gain {gain:.4f} does not exceed the noise band {band:.4f}")
    outcome = STEM_OUTCOMES[0] if not reasons else STEM_OUTCOMES[1]
    numbers: dict[str, Number] = {"on": observed, "reference": recorded, "gain": gain, "band": band, "dropped_slices": len([r for r in reasons if "dropped" in r])}
    return RuleOutcome(name="stem_it", decision=rule.decision, outcome=outcome, numbers=numbers, reasons=reasons)


def _base_key(record: CellRecord) -> str:
    return record.cell.key if record.cell.mode is None else record.cell.key.rsplit("|", 1)[0]


def refusal_cell_rule(rule: RefusalCellRule, calibration: CalibrationResult) -> RuleOutcome:
    groups: dict[str, dict[str | None, CellRecord]] = {}
    for record in calibration.cells:
        groups.setdefault(_base_key(record), {})[record.cell.mode] = record
    reasons: list[str] = []
    evaluated = skipped = 0
    for base_key in sorted(groups):
        group = groups[base_key]
        members = [group.get(None), *(group.get(mode) for mode in rule.modes)]
        if rule.skip_insufficient_data and all(r is None or r.fit_status == INSUFFICIENT for r in members):
            skipped += 1
            continue
        for mode in rule.modes:
            record = group.get(mode)
            if record is None:
                reasons.append(f"{base_key}|{mode}: no mode cell")
                continue
            evaluated += 1
            if record.fit_status != rule.dev_fit_status or record.cell.threshold is None:
                reasons.append(f"{base_key}|{mode}: not calibrated on dev ({record.fit_status})")
            elif record.cell.status != rule.holdout_status:
                reasons.append(f"{base_key}|{mode}: holdout check not passed ({record.cell.status})")
        strict, base = group.get(rule.strict_mode), group.get(None)
        if rule.strict_not_below_base and strict is not None and strict.cell.threshold is not None:
            if base is None or base.cell.threshold is None:
                reasons.append(f"{base_key}|{rule.strict_mode}: base cell has no threshold to compare")
            elif strict.cell.threshold < base.cell.threshold:
                reasons.append(f"{base_key}|{rule.strict_mode}: threshold {strict.cell.threshold:.4f} below the base cell's {base.cell.threshold:.4f}")
    if evaluated == 0:
        reasons.append("no mode cell to commit")
    outcome = CELL_OUTCOMES[0] if not reasons else CELL_OUTCOMES[1]
    return RuleOutcome(
        name="refusal_mode_cells",
        decision=rule.decision,
        outcome=outcome,
        numbers={"mode_cells_evaluated": evaluated, "bases_skipped_insufficient_data": skipped},
        reasons=reasons,
    )


# ---------- runs


def load_run(directory: Path) -> RunOutput:
    """A finished harness run (report.json, traces.jsonl, run.json), as default_runner leaves it."""
    report_path = directory / "report.json"
    if not report_path.is_file():
        raise ComparisonError(f"reused run {repo_relative(directory)} has no report.json")
    try:
        report = EvalReport.model_validate_json(report_path.read_text(encoding="utf-8"))
        traces = load_traces(directory / "traces.jsonl")
        golden = load_golden(resolve_cli_path(load_manifest(directory / "run.json").golden_path))
    except (OSError, ValidationError, ValueError) as exc:
        raise ComparisonError(f"reused run {repo_relative(directory)} is unreadable: {exc}") from exc
    return RunOutput(report=report, traces=traces, golden=golden)


def _selection(only: Iterable[str] | None) -> list[str]:
    chosen = list(dict.fromkeys(only or ()))
    unknown = [name for name in chosen if name not in SELECTABLE]
    if unknown:
        raise ComparisonError(f"unknown gate(s) {', '.join(unknown)}; choose from {', '.join(SELECTABLE)}")
    return [name for name in SELECTABLE if name in chosen] if chosen else list(SELECTABLE)


def run_phase42_gates(
    spec: Phase42GateSpec | Path,
    out: Path,
    runner: Runner = default_runner,
    *,
    only: Iterable[str] | None = None,
    reuse: Path | None = None,
) -> Phase42Gates:
    if not isinstance(spec, Phase42GateSpec):
        spec = _read_model(Phase42GateSpec, str(spec), "gate spec")
    selected = _selection(only)
    noise = _read_model(NoiseConfig, spec.noise, "noise config")
    by_name = {run.name: run for run in spec.runs}
    needed = {name for gate in selected for name in runs_for(spec, gate)}
    baselines: dict[str, Baseline] = {}
    if "off_identity" in selected:
        modes_needed = {by_name[name].fixture_mode for name in spec.gates.off_identity.against_baseline}
        baselines = {mode: _read_model(Baseline, spec.baselines[mode], f"{mode} baseline") for mode in sorted(modes_needed)}
    calibration = _read_model(CalibrationResult, spec.calibration_result, "calibration result") if "refusal_mode_cells" in selected else None
    out_dir = Path(out)
    outputs: dict[str, RunOutput] = {}
    configs: dict[str, dict[str, Any]] = {}
    for run in spec.runs:
        if run.name not in needed:
            continue
        configs[run.name] = run_config_for(spec, run)
        if reuse is not None:
            outputs[run.name] = load_run(Path(reuse) / HARNESS_DIR / run.name)
            continue
        print(f"[Phase 4.2 Gates] run {run.name} ({run.fixture_mode})", file=sys.stderr)
        outputs[run.name] = runner(
            RunRequest(name=run.name, run_config=configs[run.name], fixture_mode=run.fixture_mode, out_dir=out_dir / HARNESS_DIR / run.name)
        )
    modes = {name: run.fixture_mode for name, run in by_name.items()}
    gates: list[GateOutcome] = []
    decisions: list[RuleOutcome] = []
    g = spec.gates
    for name in selected:
        if name == "off_identity":
            gates.append(off_identity_gate(g.off_identity, outputs, modes, baselines, noise))
        elif name == "diversity":
            gates.append(diversity_gate(g.diversity, outputs, noise))
        elif name == "identifier":
            gates.append(identifier_gate(g.identifier, outputs, noise))
        elif name == "table":
            gates.append(table_gate(g.table, outputs, noise))
        elif name == "versions":
            gates.append(versions_gate(g.versions, outputs, noise))
        elif name == "dictionary":
            gates.append(dictionary_gate(g.dictionary, outputs, noise))
        elif name == "stem_it":
            decisions.append(stem_rule(spec.rules.stem_it, outputs, noise))
        elif name == "refusal_mode_cells" and calibration is not None:
            decisions.append(refusal_cell_rule(spec.rules.refusal_mode_cells, calibration))
    runs = [
        RunSummary(
            name=name,
            fixture_mode=modes[name],
            env=dict(configs[name]["env"]),
            run_config_hash=outputs[name].report.run_config_hash,
            overall=outputs[name].report.overall,
        )
        for name in (run.name for run in spec.runs)
        if name in outputs
    ]
    result = Phase42Gates(
        phase=spec.phase,
        passed=all(gate.passed for gate in gates),
        selected=selected,
        noise_floor=noise.floor,
        noise_k=noise.k,
        gates=gates,
        decisions=decisions,
        runs=runs,
        report_only=list(spec.report_only),
        notes=[FIXTURE_NOTE],
    )
    _write_text(out_dir / JSON_NAME, json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2) + "\n")
    _write_text(out_dir / MARKDOWN_NAME, render_markdown(result))
    return result


# ---------- markdown


def _num(value: Number) -> str:
    if value is None:
        return "—"
    return str(value) if isinstance(value, int) else f"{value:.4f}"


def render_markdown(result: Phase42Gates) -> str:
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
    if result.decisions:
        lines += ["", "## Decisions", ""]
        for d in result.decisions:
            lines += [f"### {d.name} ({d.decision}): `{d.outcome}`", ""]
            if d.numbers:
                lines += ["| Number | Value |", "| --- | --- |", *(f"| {key} | {_num(value)} |" for key, value in sorted(d.numbers.items())), ""]
            lines += [f"- {reason}" for reason in d.reasons] or ["- every condition of the rule holds"]
            lines.append("")
    if result.report_only:
        lines += ["", "## Report-only", "", *(f"- {entry.metric}: {entry.note}" for entry in result.report_only)]
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
    parser = argparse.ArgumentParser(prog="rag_eval.phase42_gate", description="Phase 4.2 pre-registered gates and decision rules (D-37)")
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", action="append", metavar="GATE", help=f"repeatable; one of {', '.join(SELECTABLE)}")
    parser.add_argument("--reuse", type=Path, help="read finished runs from <dir>/harness/<run> instead of running the harness")
    args = parser.parse_args(argv)
    try:
        result = run_phase42_gates(
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
    for decision in result.decisions:
        print(f"[Phase 4.2 Gates] {decision.name}: {decision.outcome}")
    print(f"[Phase 4.2 Gates] {'PASS' if result.passed else 'FAIL'}: {repo_relative(resolve_cli_path(args.out))}/{JSON_NAME}")
    return EXIT_PASS if result.passed else EXIT_FAIL


if __name__ == "__main__":
    raise SystemExit(main())
