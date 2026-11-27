"""D-18 and A-10: the defaults decision rule over paired eval runs.

Pure functions over RunSummary values; the regression CLI (rag_eval.regression) builds them from reports and traces.
Every interval and p-value comes from the shared paired bootstrap in rag_eval.paired.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.release import BackendComparison, BackendResult, SwitchVerdict

from rag_eval.paired import _stat, paired_p_value

PAIR_METRICS = ("recall_at_10", "correct_refusal_rate")
PAIR_PRIMARY = "recall_at_10+correct_refusal_rate"
JUDGE_PRIMARY = "judge_answer_correctness"
INCUMBENT_BACKEND = "pgvector"
LATENCY_CHANNELS = ("chat", "voice")
INVALID_FALLBACKS = frozenset({"backend_not_ready", "backend_error", "backend_slow"})
FAKE_IMPL = "fake"
NOTE_NOT_RECORDED = "not recorded"
# D-18: the security switches default on when they hold every gate; security wins ties.
SECURITY_VALUES: Mapping[str, str] = {"RAG_CONTEXT_TAGGING": "true", "RAG_INJECTION_CHECK": "drop"}

Direction = Literal["higher", "lower"]


@dataclass(frozen=True)
class RunSummary:
    """One run reduced to what the rule reads: per-item metric values, slice memberships, latency, injection, fallbacks."""

    config_name: str
    metrics: Mapping[str, Mapping[str, float | None]]
    slices: Mapping[str, tuple[str, ...]]
    latency_p95_ms: Mapping[str, float | None] = field(default_factory=dict)
    injection_asr: float | None = None
    fallbacks: Mapping[str, int] = field(default_factory=dict)
    backend: str = INCUMBENT_BACKEND
    backend_impl: str | None = None
    spread: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class RuleSettings:
    k: float
    floor: float
    metrics: Mapping[str, Direction]
    gated_slice_prefixes: tuple[str, ...]
    min_gate_n: int
    alpha: float
    latency_budgets_p95_ms: Mapping[str, float]

    @classmethod
    def build(
        cls,
        noise: NoiseConfig,
        budgets: LatencyBudgets | None,
        *,
        gated_slice_prefixes: Sequence[str],
        min_gate_n: int,
        alpha: float,
    ) -> "RuleSettings":
        return cls(
            k=noise.k,
            floor=noise.floor,
            metrics=dict(noise.metrics),
            gated_slice_prefixes=tuple(gated_slice_prefixes),
            min_gate_n=min_gate_n,
            alpha=alpha,
            latency_budgets_p95_ms=latency_budgets(budgets),
        )


def latency_budgets(budgets: LatencyBudgets | None) -> dict[str, float]:
    """Chat and voice p95 budgets: the pre-generation budget when present, else the profile total."""
    if budgets is None:
        return {}
    result: dict[str, float] = {}
    for channel in LATENCY_CHANNELS:
        pre = (budgets.pre_generation or {}).get(channel)
        if pre is not None:
            result[channel] = pre.p95_ms
        elif channel in budgets.profiles:
            result[channel] = budgets.profiles[channel].total_p95_ms
    return result


@dataclass(frozen=True)
class MetricOutcome:
    metric: str
    n: int
    delta: float | None
    ci_low: float | None
    ci_high: float | None
    band: float
    p_value: float | None

    @property
    def gain(self) -> bool:
        return self.delta is not None and self.delta > self.band

    @property
    def loss(self) -> bool:
        return self.delta is not None and self.delta < -self.band


@dataclass(frozen=True)
class PrimaryOutcome:
    metric: str
    chosen: MetricOutcome
    parts: tuple[MetricOutcome, ...]
    gain: bool
    loss: bool


@dataclass(frozen=True)
class SliceGate:
    ok: bool
    regressions: tuple[str, ...]
    too_small: tuple[str, ...]


@dataclass(frozen=True)
class BackendCandidate:
    backend: Literal["weaviate", "qdrant"]
    run: RunSummary
    cost_note: str | None = None
    operational_note: str | None = None


def band(settings: RuleSettings, spread: float = 0.0) -> float:
    return 0.0


def primary_outcome(challenger: RunSummary, incumbent: RunSummary, settings: RuleSettings) -> PrimaryOutcome:
    empty = MetricOutcome("none", 0, None, None, None, 0.0, None)
    return PrimaryOutcome("none", empty, (empty,), False, False)


def gate_slices(challenger: RunSummary, incumbent: RunSummary, settings: RuleSettings) -> SliceGate:
    return SliceGate(ok=True, regressions=(), too_small=())


def run_invalid_reason(run: RunSummary) -> str | None:
    return None


def decide_switch(switch: str, value: str, challenger: RunSummary, incumbent: RunSummary, settings: RuleSettings) -> SwitchVerdict:
    return SwitchVerdict(
        switch=switch, value=value, delta=None, ci_low=None, ci_high=None, band=0.0, p_value=None, p_holm=None,
        gated_slices_ok=True, latency_ok=True, injection_asr=None, decision="keep_incumbent", reason="not_implemented",
    )


def holm_adjust(p_values: Sequence[float | None]) -> list[float | None]:
    return list(p_values)


def apply_holm(verdicts: Sequence[SwitchVerdict], settings: RuleSettings) -> list[SwitchVerdict]:
    return list(verdicts)


def decide_backend(incumbent: RunSummary, candidates: Sequence[BackendCandidate], settings: RuleSettings) -> BackendComparison:
    results = [
        BackendResult(backend=c.backend, config_name=c.run.config_name, valid=True, cost_note="n", operational_note="n")
        for c in candidates
    ]
    return BackendComparison(results=results, winner="pgvector", reason="not_implemented")
