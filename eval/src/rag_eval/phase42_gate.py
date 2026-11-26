"""Phase 4.2 gates: every gate and decision rule is read from the pre-registered spec eval/config/phase42-gates.json (D-37)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from pydantic import Field, model_validator

from rag_eval.paths import resolve_cli_path
from rag_eval.phase_compare import (
    ComparisonError,
    RunOutput,
    RunRequest,
    _Model,
    materialise_run_config,
)
from rag_eval.phase_compare import RunSpec as CompareRunSpec

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


# ---------- gates (stub: names only, implemented in the GREEN commit)

GATE_NAMES = ("off_identity", "diversity", "identifier", "table", "versions", "dictionary")


class GateOutcome(_Model):
    name: str
    decision: str
    passed: bool
    runs: list[str] = Field(default_factory=list)
    numbers: dict[str, float | int | None] = Field(default_factory=dict)
    offenders: list[str] = Field(default_factory=list)


class RuleOutcome(_Model):
    name: str
    decision: str
    outcome: str
    numbers: dict[str, float | int | None] = Field(default_factory=dict)
    reasons: list[str] = Field(default_factory=list)


def _stub(name: str, gate: Any) -> GateOutcome:
    return GateOutcome(name=name, decision=gate.decision, passed=True)


def off_identity_gate(gate, outputs, modes, baselines, noise) -> GateOutcome:
    return _stub("off_identity", gate)


def diversity_gate(gate, outputs, noise) -> GateOutcome:
    return _stub("diversity", gate)


def descriptive_ids(output, max_asked) -> list[str]:
    return []


def identifier_gate(gate, outputs, noise) -> GateOutcome:
    return _stub("identifier", gate)


def table_gate(gate, outputs, noise) -> GateOutcome:
    return _stub("table", gate)


def versions_gate(gate, outputs, noise) -> GateOutcome:
    return _stub("versions", gate)


def dictionary_gate(gate, outputs, noise) -> GateOutcome:
    return _stub("dictionary", gate)


def stem_rule(rule, outputs, noise) -> RuleOutcome:
    return RuleOutcome(name="stem_it", decision=rule.decision, outcome="")


def refusal_cell_rule(rule, calibration) -> RuleOutcome:
    return RuleOutcome(name="refusal_mode_cells", decision=rule.decision, outcome="")


def run_phase42_gates(spec, out, runner=None, *, only=None, reuse=None):
    raise AssertionError("run_phase42_gates is not implemented")


def default_runner(request):
    raise AssertionError("default_runner is not implemented")


def main(argv: list[str] | None = None) -> int:
    return -1
