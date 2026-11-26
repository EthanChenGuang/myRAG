import hashlib
import json

from _private_runs import make_private_root
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.feedback_loop import GatePopulationConfig, ShipCheckResult
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval import ship_check
from rag_eval.ship_check import (
    EXIT_FAIL,
    EXIT_INPUT,
    EXIT_OK,
    EXIT_PRIVATE,
    bootstrap_interval,
    main,
    run_ship_check,
)

METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
NOISE = NoiseConfig()
POPULATION = GatePopulationConfig(mode="real", provenances=["production", "human"], min_items=1)


def _item(item_id: str, *, hit: bool, language: str = "en", category: str = "general", provenance: str = "human", split: str = "dev") -> ItemResult:
    return ItemResult(
        item_id=item_id,
        language=language,
        category=category,
        split=split,
        provenance=provenance,
        answerable=True,
        refused=False,
        span_count=1,
        spans_hit_at_5=1 if hit else 0,
        spans_hit_at_10=1 if hit else 0,
        first_hit_rank=1 if hit else None,
    )


def _slice() -> dict:
    return {metric: {"value": 0.5, "n": 1} for metric in METRICS}


def _report(items: list[ItemResult], *, population: str = "real", golden_sha: str = "a" * 64) -> EvalReport:
    return EvalReport.model_validate(
        {
            "gate_population": population,
            "run_id": "run-x",
            "tier": "live",
            "run_config_hash": "r" * 64,
            "golden_sha256": golden_sha,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "deployment_mode": "single-tenant",
            "request_options": {},
            "k_values": [5, 10],
            "overall": _slice(),
            "by_language": {},
            "by_category": {},
            "by_language_category": {},
            "by_split": {},
            "items": [item.model_dump() for item in items],
        }
    )


def _items(hits: dict[str, bool], language: str = "en") -> list[ItemResult]:
    return [_item(item_id, hit=hit, language=language) for item_id, hit in hits.items()]


def _check(baseline: EvalReport, candidate: EvalReport, target: str = "recall_at_5", **kwargs):
    return run_ship_check(
        baseline,
        candidate,
        target,
        noise=NOISE,
        population=POPULATION,
        baseline_hash="b" * 64,
        candidate_hash="c" * 64,
        **kwargs,
    )


def _improving_pair() -> tuple[EvalReport, EvalReport]:
    ids = [f"q{i}" for i in range(20)]
    baseline = _items({item_id: i < 10 for i, item_id in enumerate(ids)})
    candidate = _items({item_id: i < 18 for i, item_id in enumerate(ids)})
    return _report(baseline), _report(candidate)


def test_bootstrap_of_a_constant_difference_is_that_constant():
    assert bootstrap_interval([1.0, 1.0, 1.0], seed=0, resamples=500) == (1.0, 1.0)


def test_bootstrap_matches_the_hand_computed_interval_for_two_items():
    # Resampling [0, 1] gives means 0, 0.5 and 1 with probabilities 1/4, 1/2 and 1/4,
    # so the 2.5th percentile is 0 and the 97.5th percentile is 1.
    assert bootstrap_interval([0.0, 1.0], seed=0, resamples=10000) == (0.0, 1.0)


def test_bootstrap_is_deterministic_for_a_seed():
    differences = [0.0, 1.0, 0.0, 0.5, 1.0, 0.0, 0.25, 1.0, 0.0, 0.0]
    first = bootstrap_interval(differences, seed=7, resamples=2000)
    assert first == bootstrap_interval(differences, seed=7, resamples=2000)
    assert first[0] < first[1]


def test_better_candidate_without_slice_regression_passes():
    baseline, candidate = _improving_pair()
    result, details = _check(baseline, candidate)
    assert result.passed, details
    assert result.reasons == []
    assert result.ci_low is not None and result.ci_low > 0
    assert result.target_delta == 0.4
    assert result.manifest_hash == "a" * 64
    assert result.gate_population == "real"


def test_same_seed_gives_the_same_interval_and_the_seed_is_recorded():
    baseline, candidate = _improving_pair()
    first, _ = _check(baseline, candidate, seed=3, resamples=2000)
    second, _ = _check(baseline, candidate, seed=3, resamples=2000)
    assert (first.ci_low, first.ci_high) == (second.ci_low, second.ci_high)
    assert (first.seed, first.resamples) == (3, 2000)


def test_equal_candidate_fails_with_target_not_improved():
    baseline, _ = _improving_pair()
    result, _ = _check(baseline, baseline)
    assert not result.passed
    assert result.reasons == ["target_not_improved"]
    assert (result.ci_low, result.ci_high) == (0.0, 0.0)


def test_overall_gain_with_one_language_regressing_fails_with_slice_regression():
    en_ids = [f"e{i}" for i in range(30)]
    zh_ids = [f"z{i}" for i in range(10)]
    baseline = _items({item_id: i < 10 for i, item_id in enumerate(en_ids)}) + _items(
        {item_id: True for item_id in zh_ids}, language="zh"
    )
    candidate = _items({item_id: True for item_id in en_ids}) + _items(
        {item_id: i < 7 for i, item_id in enumerate(zh_ids)}, language="zh"
    )
    result, details = _check(_report(baseline), _report(candidate))
    assert not result.passed
    assert "slice_regression_language_zh" in result.reasons
    assert "target_not_improved" not in result.reasons
    assert any(line.startswith("slice_regression:language:zh:recall_at_5") for line in details)


def test_lower_is_better_target_improves_when_the_rate_falls():
    ids = [f"q{i}" for i in range(20)]
    baseline = [_item(i, hit=True).model_copy(update={"refused": n < 10}) for n, i in enumerate(ids)]
    candidate = [_item(i, hit=True) for i in ids]
    result, details = _check(_report(baseline), _report(candidate), target="false_refusal_rate")
    assert result.passed, details
    assert result.target_delta == -0.5
    assert result.ci_high is not None and result.ci_high < 0


def test_non_real_population_is_refused():
    baseline, candidate = _improving_pair()
    for population in ("all", "production"):
        legacy = _report([item.model_copy(update={"provenance": "production"}) for item in candidate.items], population=population)
        result, _ = _check(baseline, legacy)
        assert not result.passed
        assert result.reasons == ["not_real_population"]
        assert result.gate_population == population
        assert result.ci_low is None


def test_manifest_hash_mismatch_is_refused():
    baseline, candidate = _improving_pair()
    other = candidate.model_copy(update={"golden_sha256": "d" * 64})
    result, _ = _check(baseline, other)
    assert result.reasons == ["manifest_mismatch"]
    assert result.manifest_hash is None


def test_different_item_sets_are_refused():
    baseline, candidate = _improving_pair()
    fewer = candidate.model_copy(update={"items": candidate.items[:-1]})
    result, _ = _check(baseline, fewer)
    assert result.reasons == ["item_set_mismatch"]


def test_synthetic_items_never_enter_the_comparison():
    baseline, _ = _improving_pair()
    synthetic = [_item(f"s{i}", hit=True, provenance="synthetic_fixture") for i in range(5)]
    worse_on_synthetic = [_item(f"s{i}", hit=False, provenance="synthetic_fixture") for i in range(5)]
    _, candidate = _improving_pair()
    result, details = _check(
        baseline.model_copy(update={"items": [*baseline.items, *synthetic]}),
        candidate.model_copy(update={"items": [*candidate.items, *worse_on_synthetic]}),
    )
    assert result.passed, details


def test_only_synthetic_items_is_refused_as_no_gated_items():
    synthetic = [_item(f"s{i}", hit=i < 2, provenance="synthetic_fixture") for i in range(5)]
    better = [_item(f"s{i}", hit=True, provenance="synthetic_fixture") for i in range(5)]
    result, _ = _check(_report(synthetic), _report(better))
    assert not result.passed
    assert result.reasons == ["no_gated_items"]


def test_unknown_target_metric_is_an_input_error(tmp_path, monkeypatch):
    make_private_root(tmp_path, monkeypatch)
    baseline, candidate = _improving_pair()
    paths = _write_reports(tmp_path, baseline, candidate)
    assert main([*paths, "--target", "made_up_metric"]) == EXIT_INPUT


def _write_reports(tmp_path, baseline: EvalReport, candidate: EvalReport) -> list[str]:
    base = tmp_path / "baseline.json"
    cand = tmp_path / "candidate.json"
    base.write_text(baseline.model_dump_json(), encoding="utf-8")
    cand.write_text(candidate.model_dump_json(), encoding="utf-8")
    return ["--baseline", str(base), "--candidate", str(cand)]


def _write_population(tmp_path) -> list[str]:
    path = tmp_path / "gate-population.json"
    path.write_text(POPULATION.model_dump_json(), encoding="utf-8")
    return ["--gate-population", str(path)]


def test_cli_writes_a_passing_result_under_the_private_ship_directory(tmp_path, monkeypatch, capsys):
    private = make_private_root(tmp_path, monkeypatch)
    baseline, candidate = _improving_pair()
    paths = _write_reports(tmp_path, baseline, candidate)
    code = main([*paths, *_write_population(tmp_path), "--target", "recall_at_5", "--resamples", "2000", "--seed", "0"])
    assert code == EXIT_OK
    written = sorted((private / "ship").glob("ship-check-*.json"))
    assert len(written) == 1
    result = ShipCheckResult.model_validate_json(written[0].read_text(encoding="utf-8"))
    assert result.passed
    expected_hash = hashlib.sha256((tmp_path / "baseline.json").read_bytes()).hexdigest()
    assert result.baseline_hash == expected_hash
    assert "PASS" in capsys.readouterr().out


def test_cli_exits_one_and_lists_the_reasons(tmp_path, monkeypatch, capsys):
    private = make_private_root(tmp_path, monkeypatch)
    baseline, _ = _improving_pair()
    paths = _write_reports(tmp_path, baseline, baseline)
    code = main([*paths, *_write_population(tmp_path), "--target", "recall_at_5", "--resamples", "500"])
    assert code == EXIT_FAIL
    assert "target_not_improved" in capsys.readouterr().out
    written = list((private / "ship").glob("ship-check-*.json"))
    assert json.loads(written[0].read_text(encoding="utf-8"))["passed"] is False


def test_cli_refuses_an_output_outside_the_private_directory(tmp_path, monkeypatch):
    make_private_root(tmp_path, monkeypatch)
    baseline, candidate = _improving_pair()
    paths = _write_reports(tmp_path, baseline, candidate)
    code = main([*paths, *_write_population(tmp_path), "--target", "recall_at_5", "--out", str(tmp_path / "out.json")])
    assert code == EXIT_PRIVATE


def test_module_exposes_the_default_resamples():
    assert ship_check.DEFAULT_RESAMPLES == 10000
    assert ship_check.DEFAULT_SEED == 0
