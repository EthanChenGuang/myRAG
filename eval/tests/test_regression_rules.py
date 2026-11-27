import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.release import SwitchVerdict

from rag_eval.regression_rules import (
    JUDGE_PRIMARY,
    PAIR_PRIMARY,
    BackendCandidate,
    RuleSettings,
    RunSummary,
    apply_holm,
    decide_backend,
    decide_switch,
    gate_slices,
    holm_adjust,
    primary_outcome,
    run_invalid_reason,
)

NOISE = NoiseConfig.model_validate(
    {
        "floor": 0.02,
        "gated_slice_prefixes": ["overall", "language:"],
        "k": 3,
        "metrics": {
            "correct_refusal_rate": "higher",
            "false_refusal_rate": "lower",
            "mrr": "higher",
            "recall_at_10": "higher",
            "recall_at_5": "higher",
        },
        "schema_version": 1,
    }
)


def _settings(min_gate_n: int = 10) -> RuleSettings:
    return RuleSettings(
        k=NOISE.k,
        floor=NOISE.floor,
        metrics=dict(NOISE.metrics),
        gated_slice_prefixes=("overall", "language:", "category:", "pair:"),
        min_gate_n=min_gate_n,
        alpha=0.05,
        latency_budgets_p95_ms={"chat": 2000.0, "voice": 800.0},
    )


def _run(
    name: str,
    recall: dict[str, float],
    refusal: dict[str, float] | None = None,
    *,
    categories: dict[str, str] | None = None,
    judge: dict[str, float] | None = None,
    chat_p95: float | None = 900.0,
    voice_p95: float | None = None,
    asr: float | None = 0.0,
    fallbacks: dict[str, int] | None = None,
    backend: str = "pgvector",
    backend_impl: str | None = None,
) -> RunSummary:
    metrics: dict[str, dict[str, float | None]] = {}
    slices: dict[str, tuple[str, ...]] = {}
    categories = categories or {}
    for item_id, value in recall.items():
        metrics[item_id] = {"recall_at_10": value, "correct_refusal_rate": None}
    for item_id, value in (refusal or {}).items():
        metrics[item_id] = {"recall_at_10": None, "correct_refusal_rate": value}
    for item_id, values in metrics.items():
        if judge and item_id in judge:
            values[JUDGE_PRIMARY] = judge[item_id]
        slices[item_id] = ("overall", "language:en", f"category:{categories.get(item_id, 'general')}")
    return RunSummary(
        config_name=name,
        metrics=metrics,
        slices=slices,
        latency_p95_ms={"chat": chat_p95, "voice": voice_p95},
        injection_asr=asr,
        fallbacks=fallbacks or {},
        backend=backend,
        backend_impl=backend_impl,
    )


def _ids(n: int, prefix: str = "a") -> list[str]:
    return [f"{prefix}{index:03d}" for index in range(n)]


def _pair(gain_share: float, n: int = 100, **kwargs) -> tuple[RunSummary, RunSummary]:
    """Incumbent recall 0 on every item; the challenger lifts `gain_share` of the items to 1, a mean gain of gain_share."""
    ids = _ids(n)
    incumbent = _run("incumbent", {item: 0.0 for item in ids}, {f"u{i}": 1.0 for i in range(20)})
    moved = round(gain_share * n)
    challenger = _run("challenger", {item: (1.0 if index < moved else 0.0) for index, item in enumerate(ids)}, {f"u{i}": 1.0 for i in range(20)}, **kwargs)
    return challenger, incumbent


def test_a_gain_inside_the_band_is_rejected():
    challenger, incumbent = _pair(0.01)
    verdict = decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings())
    assert verdict.decision == "keep_incumbent"
    assert verdict.reason == "no_gain_beyond_band"
    assert verdict.band == pytest.approx(0.02)
    assert verdict.delta == pytest.approx(0.01)


def test_a_gain_beyond_the_band_without_slice_loss_is_accepted_before_holm():
    challenger, incumbent = _pair(0.05)
    verdict = decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings())
    assert verdict.decision == "adopt"
    assert verdict.reason == "gain_beyond_band"
    assert verdict.delta == pytest.approx(0.05)
    assert verdict.p_value is not None and verdict.p_value < 0.05
    assert verdict.p_holm is None


def test_pair_primary_rejects_a_recall_gain_with_a_refusal_loss_beyond_the_band():
    ids = _ids(100)
    incumbent = _run("i", {item: 0.0 for item in ids}, {f"u{i}": 1.0 for i in range(20)})
    challenger = _run(
        "c",
        {item: (1.0 if index < 10 else 0.0) for index, item in enumerate(ids)},
        {f"u{i}": (0.0 if i < 2 else 1.0) for i in range(20)},
    )
    primary = primary_outcome(challenger, incumbent, _settings())
    assert primary.metric == PAIR_PRIMARY
    assert not primary.gain and primary.loss
    assert decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings()).decision == "keep_incumbent"


def test_pair_primary_accepts_a_refusal_gain_when_recall_holds():
    ids = _ids(30)
    incumbent = _run("i", {item: 1.0 for item in ids}, {f"u{i}": (0.0 if i < 5 else 1.0) for i in range(30)})
    challenger = _run("c", {item: 1.0 for item in ids}, {f"u{i}": 1.0 for i in range(30)})
    primary = primary_outcome(challenger, incumbent, _settings())
    assert primary.gain and primary.chosen.metric == "correct_refusal_rate"


def test_judge_correctness_is_the_primary_metric_when_judge_results_exist():
    ids = _ids(40)
    incumbent = _run("i", {item: 1.0 for item in ids}, judge={item: 0.5 for item in ids})
    challenger = _run("c", {item: 1.0 for item in ids}, judge={item: 0.6 for item in ids})
    primary = primary_outcome(challenger, incumbent, _settings())
    assert primary.metric == JUDGE_PRIMARY
    assert primary.gain and primary.chosen.delta == pytest.approx(0.1)


def test_holm_step_down_adjusts_the_raw_p_values():
    adjusted = holm_adjust([0.01, 0.02, 0.03, 0.04, 0.2])
    assert adjusted == pytest.approx([0.05, 0.08, 0.09, 0.09, 0.2])
    assert holm_adjust([None, 0.04, 0.01]) == [None, pytest.approx(0.04), pytest.approx(0.02)]


def _adopted(switch: str, p: float) -> SwitchVerdict:
    return SwitchVerdict(
        switch=switch,
        value="true",
        delta=0.05,
        ci_low=0.01,
        ci_high=0.09,
        band=0.02,
        p_value=p,
        p_holm=None,
        gated_slices_ok=True,
        latency_ok=True,
        injection_asr=0.0,
        decision="adopt",
        reason="gain_beyond_band",
    )


def test_holm_across_five_ablations_keeps_only_the_survivors():
    verdicts = [_adopted(f"RAG_SWITCH_{index}", p) for index, p in enumerate([0.01, 0.02, 0.03, 0.04, 0.2])]
    adjusted = apply_holm(verdicts, _settings())
    assert [verdict.decision for verdict in adjusted] == ["adopt", "keep_incumbent", "keep_incumbent", "keep_incumbent", "keep_incumbent"]
    assert {verdict.reason for verdict in adjusted[1:]} == {"holm_not_significant"}
    assert all(verdict.p_holm is not None and verdict.p_holm >= verdict.p_value for verdict in adjusted)


def test_holm_leaves_a_security_tie_adopted():
    security = _adopted("RAG_CONTEXT_TAGGING", 0.6).model_copy(update={"reason": "security_wins_ties"})
    adjusted = apply_holm([security, _adopted("RAG_PARENT_CHILD", 0.3)], _settings())
    assert adjusted[0].decision == "adopt" and adjusted[0].p_holm == pytest.approx(0.6)
    assert adjusted[1].decision == "keep_incumbent"


def test_an_injection_attack_success_rejects_a_gain_at_any_n():
    challenger, incumbent = _pair(0.2, asr=0.05)
    verdict = decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings())
    assert verdict.decision == "keep_incumbent" and verdict.reason == "injection_attack_success"
    assert verdict.injection_asr == pytest.approx(0.05)


def test_an_unmeasured_injection_rate_cannot_adopt():
    challenger, incumbent = _pair(0.2, asr=None)
    assert decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings()).reason == "injection_not_measured"


def _slice_drop(slice_n: int) -> tuple[RunSummary, RunSummary]:
    ids = _ids(200)
    small = _ids(slice_n, "s")
    categories = {item: "table" for item in small}
    incumbent = _run("i", {**{item: 0.0 for item in ids}, **{item: 1.0 for item in small}}, categories=categories)
    drop = round(0.3 * slice_n)
    challenger = _run(
        "c",
        {
            **{item: (1.0 if index < 30 else 0.0) for index, item in enumerate(ids)},
            **{item: (0.0 if index < drop else 1.0) for index, item in enumerate(small)},
        },
        categories=categories,
    )
    return challenger, incumbent


def test_too_small_slice_drop_is_reported_and_never_decides():
    challenger, incumbent = _slice_drop(4)
    gate = gate_slices(challenger, incumbent, _settings())
    assert gate.ok and "category:table" in gate.too_small
    verdict = decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings())
    assert verdict.decision == "adopt"
    assert "category:table" in verdict.too_small_slices


def test_too_small_threshold_gates_a_slice_of_twelve():
    challenger, incumbent = _slice_drop(12)
    gate = gate_slices(challenger, incumbent, _settings())
    assert not gate.ok and "category:table/recall_at_10" in gate.regressions
    verdict = decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings())
    assert verdict.decision == "keep_incumbent" and verdict.reason == "slice_regression"
    assert "category:table" not in verdict.too_small_slices


def test_a_security_switch_with_no_gain_and_every_gate_held_is_set_on():
    ids = _ids(50)
    incumbent = _run("i", {item: 1.0 for item in ids})
    challenger = _run("c", {item: 1.0 for item in ids})
    verdict = decide_switch("RAG_CONTEXT_TAGGING", "true", challenger, incumbent, _settings())
    assert verdict.decision == "adopt" and verdict.reason == "security_wins_ties"
    assert decide_switch("RAG_INJECTION_CHECK", "drop", challenger, incumbent, _settings()).decision == "adopt"


def test_a_security_switch_failing_a_gate_stays_off():
    ids = _ids(50)
    incumbent = _run("i", {item: 1.0 for item in ids})
    slow = _run("c", {item: 1.0 for item in ids}, chat_p95=2500.0)
    assert decide_switch("RAG_CONTEXT_TAGGING", "true", slow, incumbent, _settings()).reason == "latency_over_budget"
    attacked = _run("c", {item: 1.0 for item in ids}, asr=0.1)
    assert decide_switch("RAG_INJECTION_CHECK", "drop", attacked, incumbent, _settings()).decision == "keep_incumbent"


def test_a_challenger_over_the_chat_latency_budget_is_rejected_even_with_a_gain():
    challenger, incumbent = _pair(0.2, chat_p95=2100.0)
    verdict = decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings())
    assert verdict.decision == "keep_incumbent" and verdict.reason == "latency_over_budget"
    assert not verdict.latency_ok


def test_a_challenger_over_the_voice_latency_budget_is_rejected():
    challenger, incumbent = _pair(0.2, voice_p95=900.0)
    assert decide_switch("RAG_PARENT_CHILD", "true", challenger, incumbent, _settings()).reason == "latency_over_budget"


def _backend_runs(shift_share: float, noisy: bool) -> tuple[RunSummary, RunSummary]:
    ids = _ids(100)
    incumbent = _run("b.pgvector.1", {item: 0.0 for item in ids}, {f"u{i}": 1.0 for i in range(20)})
    values: dict[str, float] = {}
    moved = round(shift_share * 100)
    for index, item in enumerate(ids):
        if index < moved:
            values[item] = 1.0
        elif noisy and index < moved + 6:
            values[item] = -0.0
        else:
            values[item] = 0.0
    if noisy:
        # Large losses on a few items widen the interval so ci_low <= 0 while the mean stays beyond the band.
        for index in range(moved, moved + 6):
            incumbent.metrics[ids[index]]["recall_at_10"] = 1.0
    challenger = _run("b.qdrant.1", values, {f"u{i}": 1.0 for i in range(20)}, backend="qdrant", backend_impl="real")
    return challenger, incumbent


def test_a_backend_beyond_the_band_with_ci_low_at_or_below_zero_keeps_pgvector():
    challenger, incumbent = _backend_runs(0.1, noisy=True)
    comparison = decide_backend(incumbent, [BackendCandidate("qdrant", challenger, "one node", "a second store")], _settings())
    result = comparison.results[0]
    assert result.valid and result.delta is not None and result.delta > result.band
    assert result.ci_low is not None and result.ci_low <= 0
    assert comparison.winner == "pgvector" and comparison.reason == "no_backend_beyond_ci"


def test_a_backend_with_ci_low_above_zero_wins_with_its_notes():
    challenger, incumbent = _backend_runs(0.2, noisy=False)
    comparison = decide_backend(incumbent, [BackendCandidate("qdrant", challenger, "one node", "a second store")], _settings())
    assert comparison.winner == "qdrant" and comparison.reason == "backend_beyond_ci"
    assert comparison.results[0].ci_low > 0
    assert comparison.results[0].cost_note == "one node"


def test_a_winning_backend_without_cost_or_operational_notes_keeps_pgvector():
    challenger, incumbent = _backend_runs(0.2, noisy=False)
    comparison = decide_backend(incumbent, [BackendCandidate("qdrant", challenger, None, "a second store")], _settings())
    assert comparison.winner == "pgvector" and comparison.reason == "backend_notes_missing"


@pytest.mark.parametrize("reason", ["backend_not_ready", "backend_error", "backend_slow"])
def test_a_run_with_a_backend_fallback_is_invalid(reason):
    challenger, incumbent = _backend_runs(0.2, noisy=False)
    fallen = RunSummary(**{**challenger.__dict__, "fallbacks": {reason: 1}})
    assert run_invalid_reason(fallen) == "backend_fallback"
    comparison = decide_backend(incumbent, [BackendCandidate("qdrant", fallen, "n", "n")], _settings())
    assert not comparison.results[0].valid and comparison.results[0].invalid_reason == "backend_fallback"
    assert comparison.winner == "pgvector" and comparison.reason == "no_valid_backend"
    assert decide_switch("RAG_PARENT_CHILD", "true", fallen, incumbent, _settings()).reason == "run_invalid"


def test_a_filter_unsupported_fallback_does_not_invalidate_a_run():
    challenger, _ = _backend_runs(0.2, noisy=False)
    assert run_invalid_reason(RunSummary(**{**challenger.__dict__, "fallbacks": {"filter_unsupported": 3}})) is None


def test_a_fake_store_run_is_invalid_for_the_backend_decision():
    challenger, incumbent = _backend_runs(0.2, noisy=False)
    fake = RunSummary(**{**challenger.__dict__, "backend_impl": "fake"})
    comparison = decide_backend(incumbent, [BackendCandidate("qdrant", fake, "n", "n")], _settings())
    assert comparison.results[0].invalid_reason == "backend_impl_fake"
    assert comparison.winner == "pgvector"


def test_a_pgvector_run_is_never_invalid_for_its_implementation():
    _, incumbent = _backend_runs(0.2, noisy=False)
    assert run_invalid_reason(RunSummary(**{**incumbent.__dict__, "backend_impl": "fake"})) is None
