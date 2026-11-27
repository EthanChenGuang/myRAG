"""D-18 and A-10: the defaults decision rule over paired eval runs.

Pure functions over RunSummary values; the regression CLI (rag_eval.regression) builds them from reports and traces.
Every interval and p-value comes from the shared paired bootstrap in rag_eval.paired.
"""

from __future__ import annotations

import math
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
    return max(settings.k * spread, settings.floor)


def paired_differences(challenger: RunSummary, incumbent: RunSummary, metric: str, items: set[str] | None = None) -> list[float]:
    differences: list[float] = []
    for item_id in sorted(set(challenger.metrics) & set(incumbent.metrics)):
        if items is not None and item_id not in items:
            continue
        observed = challenger.metrics[item_id].get(metric)
        recorded = incumbent.metrics[item_id].get(metric)
        if observed is None or recorded is None:
            continue
        differences.append(observed - recorded)
    return differences


def metric_outcome(
    challenger: RunSummary, incumbent: RunSummary, metric: str, settings: RuleSettings, items: set[str] | None = None
) -> MetricOutcome:
    differences = paired_differences(challenger, incumbent, metric, items)
    stat = _stat(differences)
    return MetricOutcome(
        metric=metric,
        n=stat.n,
        delta=stat.mean_d,
        ci_low=stat.ci_low,
        ci_high=stat.ci_high,
        band=band(settings, incumbent.spread.get(metric, 0.0)),
        p_value=paired_p_value(differences),
    )


def has_judge(challenger: RunSummary, incumbent: RunSummary) -> bool:
    return bool(paired_differences(challenger, incumbent, JUDGE_PRIMARY))


def primary_outcome(challenger: RunSummary, incumbent: RunSummary, settings: RuleSettings) -> PrimaryOutcome:
    """D-18: judge answer correctness when judge results exist; else Recall@10 and correct refusal as a pair."""
    if has_judge(challenger, incumbent):
        judge = metric_outcome(challenger, incumbent, JUDGE_PRIMARY, settings)
        return PrimaryOutcome(JUDGE_PRIMARY, judge, (judge,), judge.gain, judge.loss)
    recall, refusal = (metric_outcome(challenger, incumbent, metric, settings) for metric in PAIR_METRICS)
    gain = (recall.gain and not refusal.loss) or (refusal.gain and not recall.loss)
    loss = recall.loss or refusal.loss
    parts = (recall, refusal)
    if gain:
        gaining = [part for part in parts if part.gain]
        chosen = min(gaining, key=lambda part: (part.p_value if part.p_value is not None else 1.0, part.metric))
    elif loss:
        chosen = min((part for part in parts if part.loss), key=lambda part: (part.delta or 0.0, part.metric))
    else:
        chosen = recall if recall.n else refusal
    return PrimaryOutcome(PAIR_PRIMARY, chosen, parts, gain, loss)


def _is_gated(slice_name: str, prefixes: Sequence[str]) -> bool:
    return any(slice_name == prefix if not prefix.endswith(":") else slice_name.startswith(prefix) for prefix in prefixes)


def gate_slices(challenger: RunSummary, incumbent: RunSummary, settings: RuleSettings) -> SliceGate:
    """No gated slice with at least min_gate_n paired items regresses beyond the band; smaller ones are reported only."""
    paired = set(challenger.metrics) & set(incumbent.metrics)
    members: dict[str, set[str]] = {}
    for item_id in paired:
        for slice_name in incumbent.slices.get(item_id, ()):
            if _is_gated(slice_name, settings.gated_slice_prefixes):
                members.setdefault(slice_name, set()).add(item_id)
    regressions: list[str] = []
    too_small: list[str] = []
    for slice_name in sorted(members):
        items = members[slice_name]
        if len(items) < settings.min_gate_n:
            too_small.append(slice_name)
            continue
        for metric, direction in sorted(settings.metrics.items()):
            differences = paired_differences(challenger, incumbent, metric, items)
            if not differences:
                continue
            mean = math.fsum(differences) / len(differences)
            limit = band(settings, incumbent.spread.get(metric, 0.0))
            if (direction == "higher" and mean < -limit) or (direction == "lower" and mean > limit):
                regressions.append(f"{slice_name}/{metric}")
    return SliceGate(ok=not regressions, regressions=tuple(regressions), too_small=tuple(too_small))


def latency_ok(run: RunSummary, settings: RuleSettings) -> bool:
    """Chat and voice p95 within budget; a channel the run did not measure cannot fail."""
    for channel in LATENCY_CHANNELS:
        observed = run.latency_p95_ms.get(channel)
        budget = settings.latency_budgets_p95_ms.get(channel)
        if observed is not None and budget is not None and observed > budget:
            return False
    return True


def run_invalid_reason(run: RunSummary) -> str | None:
    """D-11, Pitfall 6: a fallback or the fake store makes a run invalid for a backend comparison."""
    if any(run.fallbacks.get(reason, 0) > 0 for reason in INVALID_FALLBACKS):
        return "backend_fallback"
    if run.backend != INCUMBENT_BACKEND and run.backend_impl == FAKE_IMPL:
        return "backend_impl_fake"
    return None


def _verdict(
    switch: str,
    value: str,
    primary: PrimaryOutcome,
    slices: SliceGate,
    latency: bool,
    asr: float | None,
    decision: Literal["adopt", "keep_incumbent"],
    reason: str,
) -> SwitchVerdict:
    chosen = primary.chosen
    return SwitchVerdict(
        switch=switch,
        value=value,
        delta=chosen.delta,
        ci_low=chosen.ci_low,
        ci_high=chosen.ci_high,
        band=chosen.band,
        p_value=chosen.p_value,
        p_holm=None,
        gated_slices_ok=slices.ok,
        too_small_slices=list(slices.too_small),
        latency_ok=latency,
        injection_asr=asr,
        decision=decision,
        reason=reason,
    )


def is_security_value(switch: str, value: str) -> bool:
    return SECURITY_VALUES.get(switch) == value


def decide_switch(
    switch: str, value: str, challenger: RunSummary, incumbent: RunSummary, settings: RuleSettings
) -> SwitchVerdict:
    """One ablation before multiplicity control: `challenger` runs `switch=value`, `incumbent` differs only in that switch."""
    primary = primary_outcome(challenger, incumbent, settings)
    slices = gate_slices(challenger, incumbent, settings)
    latency = latency_ok(challenger, settings)
    asr = challenger.injection_asr

    def keep(reason: str) -> SwitchVerdict:
        return _verdict(switch, value, primary, slices, latency, asr, "keep_incumbent", reason)

    if run_invalid_reason(challenger) or run_invalid_reason(incumbent):
        return keep("run_invalid")
    if asr is None:
        return keep("injection_not_measured")
    if asr > 0:
        return keep("injection_attack_success")
    if not latency:
        return keep("latency_over_budget")
    if not slices.ok:
        return keep("slice_regression")
    if is_security_value(switch, value):
        if primary.loss:
            return keep("primary_loss")
        return _verdict(switch, value, primary, slices, latency, asr, "adopt", "security_wins_ties")
    if primary.gain:
        return _verdict(switch, value, primary, slices, latency, asr, "adopt", "gain_beyond_band")
    if primary.loss:
        return keep("primary_loss")
    return keep("no_gain_beyond_band")


def holm_adjust(p_values: Sequence[float | None]) -> list[float | None]:
    """Holm-Bonferroni step-down adjusted p-values; None stays None and is not counted in the family."""
    present = sorted((p, index) for index, p in enumerate(p_values) if p is not None)
    m = len(present)
    adjusted: list[float | None] = [None] * len(p_values)
    running = 0.0
    for rank, (p, index) in enumerate(present):
        running = max(running, min(1.0, (m - rank) * p))
        adjusted[index] = running
    return adjusted


def apply_holm(verdicts: Sequence[SwitchVerdict], settings: RuleSettings) -> list[SwitchVerdict]:
    """A-10: an ablation adopted for a gain stays adopted only when its Holm-adjusted p is at most alpha.

    Security switches adopted under the tie rule need no win, so multiplicity control does not touch them."""
    adjusted = holm_adjust([verdict.p_value for verdict in verdicts])
    result: list[SwitchVerdict] = []
    for verdict, p_holm in zip(verdicts, adjusted, strict=True):
        update: dict[str, object] = {"p_holm": p_holm}
        if verdict.decision == "adopt" and verdict.reason == "gain_beyond_band" and (p_holm is None or p_holm > settings.alpha):
            update.update({"decision": "keep_incumbent", "reason": "holm_not_significant"})
        result.append(verdict.model_copy(update=update))
    return [SwitchVerdict.model_validate(verdict.model_dump()) for verdict in result]


def _note(value: str | None) -> str:
    return value if value else NOTE_NOT_RECORDED


def decide_backend(incumbent: RunSummary, candidates: Sequence[BackendCandidate], settings: RuleSettings) -> BackendComparison:
    """D-18: pgvector stays unless an external backend has ci_low > 0 and a mean gain beyond the band, holds every
    gate, and has its cost and operational notes recorded (Pitfall 20). Invalid runs are reported, never compared."""
    results: list[BackendResult] = []
    eligible: list[tuple[float, BackendCandidate]] = []
    for candidate in candidates:
        invalid = run_invalid_reason(candidate.run)
        if invalid is not None:
            results.append(
                BackendResult(
                    backend=candidate.backend,
                    config_name=candidate.run.config_name,
                    valid=False,
                    invalid_reason=invalid,
                    cost_note=_note(candidate.cost_note),
                    operational_note=_note(candidate.operational_note),
                )
            )
            continue
        primary = primary_outcome(candidate.run, incumbent, settings)
        chosen = primary.chosen
        results.append(
            BackendResult(
                backend=candidate.backend,
                config_name=candidate.run.config_name,
                valid=True,
                delta=chosen.delta,
                ci_low=chosen.ci_low,
                ci_high=chosen.ci_high,
                band=chosen.band,
                cost_note=_note(candidate.cost_note),
                operational_note=_note(candidate.operational_note),
            )
        )
        gates = (
            gate_slices(candidate.run, incumbent, settings).ok
            and latency_ok(candidate.run, settings)
            and candidate.run.injection_asr == 0
        )
        beyond_ci = primary.gain and chosen.ci_low is not None and chosen.ci_low > 0
        if beyond_ci and gates and chosen.delta is not None:
            eligible.append((chosen.delta, candidate))
    if not results:
        raise ValueError("a backend comparison needs at least one external backend run")
    if not any(result.valid for result in results):
        return BackendComparison(results=results, winner=INCUMBENT_BACKEND, reason="no_valid_backend")
    if not eligible:
        return BackendComparison(results=results, winner=INCUMBENT_BACKEND, reason="no_backend_beyond_ci")
    _, best = max(eligible, key=lambda entry: (entry[0], entry[1].backend))
    if not best.cost_note or not best.operational_note:
        return BackendComparison(results=results, winner=INCUMBENT_BACKEND, reason="backend_notes_missing")
    return BackendComparison(results=results, winner=best.backend, reason="backend_beyond_ci")


def with_spread(run: RunSummary, spread: Mapping[str, float]) -> RunSummary:
    return replace(run, spread=dict(spread))
