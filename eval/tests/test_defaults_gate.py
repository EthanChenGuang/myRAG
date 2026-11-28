import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.eval_run import RunManifest
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.report import EvalReport, ItemResult

import rag_eval.defaults_gate as dg
from rag_eval.defaults_gate import (
    DefaultsGateCriteria,
    DefaultsGateResult,
    RunInput,
    choose_floor,
    choose_no_key_fallback,
    derive_absolute_floor,
    evaluate_config_mode,
    evaluate_defaults_gate,
    main,
)
from rag_eval.paired import item_metrics

REPO = Path(__file__).resolve().parents[2]
METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
REQUIRED = ["v2-default", "v2-default-no-cells", "v2-default-hosted-fake", "v2-default-hosted-fake-no-cells"]
SIMILARITY = [
    "v2-default-similarity-floor",
    "v2-default-similarity-floor-no-cells",
    "v2-default-similarity-floor-hosted-fake",
    "v2-default-similarity-floor-hosted-fake-no-cells",
]
NONE = ["v2-default-fallback-none", "v2-default-fallback-none-no-cells"]
MODES = ("prechunked", "ingest")
CHANGED_AT = datetime(2026, 1, 1, tzinfo=UTC)
CREATED_AT = "2026-01-02T00:00:00Z"

# Synthetic slice values for every test; nothing here comes from a committed baseline.
DEFAULT_SLICES: dict[str, dict[str, tuple[float, int]]] = {
    "overall": {
        "recall_at_5": (0.6, 40),
        "recall_at_10": (0.7, 40),
        "mrr": (0.55, 40),
        "correct_refusal_rate": (0.5, 12),
        "false_refusal_rate": (0.2, 40),
    },
    "category:general": {m: (0.6, 20) for m in METRICS},
    "category:no_answer": {m: (0.5, 12) for m in METRICS},
    "category:cross_lingual": {m: (0.6, 10) for m in METRICS},
}


def _slices(changes: dict[str, dict[str, tuple[float, int]]] | None = None) -> dict[str, dict[str, tuple[float, int]]]:
    merged = {name: dict(values) for name, values in DEFAULT_SLICES.items()}
    for name, values in (changes or {}).items():
        merged.setdefault(name, {m: (0.6, 20) for m in METRICS}).update(values)
    return merged


def _metric_block(values: dict[str, tuple[float, int]]) -> dict:
    return {metric: {"value": value, "n": n} for metric, (value, n) in values.items()}


def _item(item_id: str, rank: int | None = 1) -> dict:
    return {
        "item_id": item_id,
        "language": "en",
        "category": "general",
        "split": "dev",
        "provenance": "synthetic_fixture",
        "answerable": True,
        "refused": False,
        "span_count": 1,
        "spans_hit_at_5": 1 if rank else 0,
        "spans_hit_at_10": 1 if rank else 0,
        "first_hit_rank": rank,
    }


ITEMS = [_item("a1"), _item("a2")]
COMMON = {
    "tier": "smoke",
    "corpus_sha256": "c" * 64,
    "golden_sha256": "g" * 64,
    "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
    "embedder_id": "fixture-embedder",
    "embedder_version": 3,
    "deployment_mode": "single-tenant",
    "request_options": {},
}


def _report(
    changes=None, *, run_id: str = "run-x", items=None, latency: dict | None | str = "default", overrides: dict | None = None
) -> EvalReport:
    slices = _slices(changes)
    data = {
        **COMMON,
        "run_id": run_id,
        "run_config_hash": "r" * 64,
        "k_values": [5, 10],
        "overall": _metric_block(slices["overall"]),
        "by_language": {},
        "by_category": {name.split(":", 1)[1]: _metric_block(v) for name, v in slices.items() if name.startswith("category:")},
        "by_language_category": {},
        "by_split": {},
        "items": items if items is not None else ITEMS,
    }
    if overrides is not None:
        data["request_options"] = {"retrieval_overrides": overrides}
    if latency == "default":
        data["latency"] = {
            "retrieval_total": {"p50_ms": 10.0, "p95_ms": 20.0, "n": 40},
            "rerank": {"p50_ms": 2.0, "p95_ms": 4.0, "n": 40},
        }
    elif latency is not None:
        data["latency"] = latency
    return EvalReport.model_validate(data)


def _baseline(changes=None, spread: float = 0.0, items=None) -> Baseline:
    slices = _slices(changes)
    data = {
        **COMMON,
        "spread_kind": "stdev_ddof1",
        "run_config_hash": "r" * 64,
        "runs": [{"run_id": f"b-{i}", "run_config_hash": "r" * 64, "created_at": "2025-12-01T00:00:00Z"} for i in range(3)],
        "slices": {
            name: {metric: {"mean": value, "spread": spread, "runs": [value] * 3, "n": n} for metric, (value, n) in values.items()}
            for name, values in slices.items()
        },
        "items": {
            item["item_id"]: {metric: [value] * 3 for metric, value in item_metrics(ItemResult(**item)).items()}
            for item in (items if items is not None else ITEMS)
        },
    }
    return Baseline.model_validate(data)


def _noise(floor: float = 0.02, k: float = 3.0) -> NoiseConfig:
    return NoiseConfig(k=k, floor=floor)


def _budgets() -> LatencyBudgets:
    return LatencyBudgets.model_validate(
        {"profiles": {"chat": {"total_p50_ms": 100, "total_p95_ms": 200, "stages": {"rerank": 50}}}}
    )


def _rules(baselines: dict[str, str] | None = None, noise_path: str = "noise.json", budgets_path: str = "budgets.json") -> dict:
    return {
        "schema_version": 1,
        "description": "synthetic test criteria",
        "refusal_basis": "single_threshold",
        "criteria": {gid: f"{gid} text" for gid in ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8")},
        "pass_rule": "words",
        "configurations_required": REQUIRED,
        "candidates": {
            "floor": {"legacy_rule": REQUIRED, "similarity": SIMILARITY},
            "fallback": {"local_bm25": REQUIRED[:2], "none": NONE, "hosted_not_applicable": "the hosted path never uses the fallback"},
        },
        "selection_rules": {
            "floor": {
                "rule": "words",
                "requires_pass_on_all_configurations": True,
                "prefer": {"slice": "overall", "metric": "correct_refusal_rate", "direction": "higher"},
                "prefer_aggregate": "mean_over_configurations_and_modes",
                "tie_goes_to": "legacy_rule",
            },
            "fallback": {
                "rule": "words",
                "requires_pass_on_all_configurations": True,
                "prefer": "local_bm25",
                "within_band_of_none": [
                    {"slice": "overall", "metric": "recall_at_10"},
                    {"slice": "overall", "metric": "mrr"},
                    {"slice": "category:cross_lingual", "metric": "recall_at_10"},
                ],
                "otherwise": "none",
            },
        },
        "modes": list(MODES),
        "baselines": baselines or {"prechunked": "prechunked.json", "ingest": "ingest.json"},
        "noise_path": noise_path,
        "gated_metrics": dict(_noise().metrics),
        "category_min_n": 8,
        "category_metrics": ["recall_at_10", "mrr"],
        "refusal_metrics": [
            {"slice": "overall", "metric": "false_refusal_rate", "direction": "lower"},
            {"slice": "overall", "metric": "correct_refusal_rate", "direction": "higher"},
            {"slice": "category:no_answer", "metric": "correct_refusal_rate", "direction": "higher"},
        ],
        "latency_budgets_path": budgets_path,
        "latency": {"profile": "chat", "total_key": "retrieval_total", "stage": "rerank"},
        "legacy_run_config": "legacy",
        "legacy_requires_all_zero": True,
    }


def _write(path: Path, model) -> Path:
    path.write_text(model.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path


def _criteria(tmp_path: Path, baseline: Baseline | None = None, noise: NoiseConfig | None = None) -> DefaultsGateCriteria:
    ingest = _write(tmp_path / "ingest.json", baseline or _baseline())
    noise_path = _write(tmp_path / "noise.json", noise or _noise())
    return DefaultsGateCriteria.model_validate(derive_absolute_floor(_rules(), ingest, noise_path))


def _manifest(name: str, report: EvalReport, created_at: str = CREATED_AT) -> RunManifest:
    return RunManifest.model_validate(
        {
            "run_id": report.run_id,
            "tier": "smoke",
            "created_at": created_at,
            "deployment_mode": "single-tenant",
            "golden_path": "golden.jsonl",
            "golden_sha256": "g" * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "sql_sha256": {},
            "request_options": {},
            "effective_config_hash": "e" * 64,
            "run_config_hash": report.run_config_hash,
            "item_count": 2,
            "edge_errors": 0,
            "run_config": {"name": name},
        }
    )


def _run(name: str, mode: str, report: EvalReport | None = None, created_at: str = CREATED_AT) -> RunInput:
    report = report or _report(run_id=f"{name}-{mode}")
    return RunInput(
        config=name,
        mode=mode,
        report=report,
        manifest=_manifest(name, report, created_at),
        report_path=f"{name}-{mode}/report.json",
        report_sha256="s" * 64,
    )


def _all_runs(overrides: dict[tuple[str, str], EvalReport] | None = None) -> dict[tuple[str, str], RunInput]:
    runs = {}
    for name in [*REQUIRED, *SIMILARITY, *NONE, "legacy"]:
        for mode in MODES:
            report = (overrides or {}).get((name, mode))
            runs[(name, mode)] = _run(name, mode, report)
    return runs


def _evaluate(criteria, runs, baselines=None, noise=None, g8=True, changed_at=CHANGED_AT) -> DefaultsGateResult:
    g8_input = (
        dg.G8Input(
            two_tenant_matrix={"single_tenant": True, "multi_tenant": True},
            negative_checks={"drop_top_candidate_fails": True, "max_results_1_fails": True},
        )
        if g8
        else None
    )
    return evaluate_defaults_gate(
        criteria,
        criteria_sha256="d" * 64,
        criteria_path="criteria.json",
        criteria_changed_at=changed_at,
        runs=runs,
        baselines=baselines or {mode: _baseline() for mode in MODES},
        noise=noise or _noise(),
        budgets=_budgets(),
        sources=[],
        g8=g8_input,
    )


def _criterion(mode_result, gid):
    return next(c for c in mode_result.criteria if c.id == gid)


def _mode(result: DefaultsGateResult, config: str, mode: str):
    found = next(c for c in result.configurations if c.name == config)
    return next(m for m in found.modes if m.mode == mode)


# ---------- the whole gate


def test_reports_equal_to_the_baseline_pass_every_criterion(tmp_path):
    result = _evaluate(_criteria(tmp_path), _all_runs())
    assert result.passed is True, result.failures
    assert len(result.configurations) == 11
    for config in result.configurations:
        for mode in config.modes:
            assert all(c.status == "pass" for c in mode.criteria), (config.name, mode.mode, mode.criteria)
    assert result.selections.floor == "legacy_rule"
    assert result.selections.no_key_fallback == "local_bm25"
    assert result.refusal_basis == "single_threshold"
    assert result.g8.status == "pass"


def test_recall_below_the_band_fails_g1_and_g2_and_names_the_slice(tmp_path):
    criteria = _criteria(tmp_path)
    low = _report({"overall": {"recall_at_10": (0.7 - 0.03, 40)}}, run_id="low")
    result = evaluate_config_mode(_run("v2-default", "prechunked", low), _baseline(), _noise(), _budgets(), criteria)
    g1, g2 = _criterion(result, "G1"), _criterion(result, "G2")
    assert g1.status == "fail" and any(c.slice == "overall" and c.metric == "recall_at_10" for c in g1.checks if c.status == "fail")
    assert g2.status == "fail" and g2.checks[0].slice == "overall"
    assert result.passed is False


def test_missing_g8_input_is_skipped_never_pass(tmp_path):
    result = _evaluate(_criteria(tmp_path), _all_runs(), g8=False)
    assert result.g8.status == "skipped"
    assert result.passed is False and "G8 skipped" in result.failures


# ---------- derive and staleness


def test_derive_writes_mean_minus_band_with_the_hashes(tmp_path):
    spread = 0.01
    baseline = _baseline(spread=spread)
    ingest = _write(tmp_path / "ingest.json", baseline)
    noise_path = _write(tmp_path / "noise.json", _noise(floor=0.02, k=3))
    derived = derive_absolute_floor(_rules(), ingest, noise_path)["absolute"]["ingest"]["overall"]
    mean = baseline.slices["overall"]["recall_at_10"].mean
    assert derived["recall_at_10_min"] == pytest.approx(mean - max(3 * spread, 0.02))
    assert derived["derivation"]["band"] == pytest.approx(3 * spread)
    assert derived["derivation"]["baseline_mean"] == mean
    assert derived["derivation"]["baseline_sha256"] == dg.sha256_file(ingest)
    assert derived["derivation"]["noise_sha256"] == dg.sha256_file(noise_path)

    flat = derive_absolute_floor(_rules(), _write(tmp_path / "flat.json", _baseline()), noise_path)
    assert flat["absolute"]["ingest"]["overall"]["derivation"]["band"] == 0.02


def test_derive_cli_is_byte_identical_and_touches_only_the_absolute_block(tmp_path):
    ingest = _write(tmp_path / "ingest.json", _baseline(spread=0.004))
    noise_path = _write(tmp_path / "noise.json", _noise())
    criteria_path = tmp_path / "criteria.json"
    rules = _rules()
    criteria_path.write_text(dg.dump_criteria(rules), encoding="utf-8")
    args = ["derive", "--criteria", str(criteria_path), "--ingest-baseline", str(ingest), "--noise", str(noise_path)]
    assert main(args) == 0
    first = criteria_path.read_bytes()
    assert main(args) == 0
    assert criteria_path.read_bytes() == first
    written = json.loads(first)
    assert {key: value for key, value in written.items() if key != "absolute"} == rules
    assert main(["check-criteria", *args[1:]]) == 0


def test_a_report_at_the_derived_floor_passes_g2_and_just_below_fails(tmp_path):
    # The ingest baseline used for the floor sits above the per-mode baseline, so only the absolute floor binds.
    criteria = _criteria(tmp_path, baseline=_baseline({"overall": {"recall_at_10": (0.8, 40)}}))
    floor = criteria.absolute.ingest.overall.recall_at_10_min
    at = _report({"overall": {"recall_at_10": (floor, 40)}})
    below = _report({"overall": {"recall_at_10": (floor - 1e-6, 40)}})
    for report, expected in ((at, "pass"), (below, "fail")):
        result = evaluate_config_mode(_run("v2-default", "ingest", report), _baseline(), _noise(), _budgets(), criteria)
        check = next(c for c in _criterion(result, "G2").checks if c.name == "recall_at_10_absolute_floor")
        assert check.status == expected
        assert check.bound == floor


def test_a_criteria_file_for_another_baseline_is_refused_with_criteria_stale(tmp_path, capsys):
    ingest = _write(tmp_path / "ingest.json", _baseline())
    noise_path = _write(tmp_path / "noise.json", _noise())
    criteria_path = tmp_path / "criteria.json"
    criteria_path.write_text(dg.dump_criteria(derive_absolute_floor(_rules(), ingest, noise_path)), encoding="utf-8")
    _write(ingest, _baseline({"overall": {"recall_at_10": (0.65, 40)}}))
    code = main(["check-criteria", "--criteria", str(criteria_path), "--ingest-baseline", str(ingest), "--noise", str(noise_path)])
    assert code == 2
    assert "criteria_stale" in capsys.readouterr().err

    out = tmp_path / "out"
    assert main(["evaluate", "--criteria", str(_absolute_criteria(tmp_path, criteria_path)), "--reports", str(tmp_path), "--out", str(out)]) == 2
    assert not (out / "defaults-gate.json").exists()


def _absolute_criteria(tmp_path: Path, criteria_path: Path) -> Path:
    raw = json.loads(criteria_path.read_text(encoding="utf-8"))
    raw["baselines"] = {"prechunked": str(tmp_path / "ingest.json"), "ingest": str(tmp_path / "ingest.json")}
    raw["noise_path"] = str(tmp_path / "noise.json")
    raw["latency_budgets_path"] = str(tmp_path / "budgets.json")
    path = tmp_path / "criteria-abs.json"
    path.write_text(dg.dump_criteria(raw), encoding="utf-8")
    return path


def test_a_hand_edited_floor_is_refused(tmp_path, capsys):
    ingest = _write(tmp_path / "ingest.json", _baseline())
    noise_path = _write(tmp_path / "noise.json", _noise())
    raw = derive_absolute_floor(_rules(), ingest, noise_path)
    raw["absolute"]["ingest"]["overall"]["recall_at_10_min"] -= 0.05
    criteria_path = tmp_path / "criteria.json"
    criteria_path.write_text(dg.dump_criteria(raw), encoding="utf-8")
    code = main(["check-criteria", "--criteria", str(criteria_path), "--ingest-baseline", str(ingest), "--noise", str(noise_path)])
    assert code == 2
    err = capsys.readouterr().err
    assert "criteria_stale" in err and "recall_at_10_min" in err


def test_a_criteria_file_changed_after_a_report_is_refused(tmp_path):
    criteria = _criteria(tmp_path)
    runs = _all_runs()
    runs[("v2-default", "ingest")] = _run("v2-default", "ingest", created_at="2025-12-31T23:59:59Z")
    with pytest.raises(dg.CriteriaStaleError) as caught:
        _evaluate(criteria, runs)
    assert dg.CRITERIA_CHANGED_AFTER_RUNS in caught.value.problems[0]


# ---------- G3 refusal


def test_correct_refusal_one_item_below_the_baseline_on_twelve_no_answer_items_fails_g3(tmp_path):
    criteria = _criteria(tmp_path)
    baseline = _baseline({"category:no_answer": {"correct_refusal_rate": (6 / 12, 12)}})
    report = _report({"category:no_answer": {"correct_refusal_rate": (5 / 12, 12)}})
    result = evaluate_config_mode(_run("v2-default", "prechunked", report), baseline, _noise(), _budgets(), criteria)
    g3 = _criterion(result, "G3")
    failing = [c for c in g3.checks if c.status == "fail"]
    assert g3.status == "fail" and failing[0].slice == "category:no_answer" and failing[0].n == 12


def test_false_refusal_passes_inside_the_band_and_fails_just_outside(tmp_path):
    criteria = _criteria(tmp_path)
    for delta, expected in ((0.019, "pass"), (0.021, "fail")):
        report = _report({"overall": {"false_refusal_rate": (0.2 + delta, 40)}})
        result = evaluate_config_mode(_run("v2-default", "prechunked", report), _baseline(), _noise(floor=0.02), _budgets(), criteria)
        check = next(c for c in _criterion(result, "G3").checks if c.metric == "false_refusal_rate")
        assert check.status == expected
        assert check.band == pytest.approx(0.02)
        assert check.n == 40 and check.upper_95 is not None and check.upper_95 > check.observed


def test_the_result_copies_refusal_basis_and_another_basis_is_rejected(tmp_path):
    result = _evaluate(_criteria(tmp_path), _all_runs())
    dumped = result.model_dump_json()
    assert result.refusal_basis == "single_threshold"
    for key in ("mode_key", "rag_mode", "behavior_mode"):
        assert key not in dumped
    bad = _rules()
    bad["refusal_basis"] = "per_mode"
    with pytest.raises(ValueError):
        DefaultsGateCriteria.model_validate(bad)
    extra = _rules()
    extra["rag_mode"] = "strict"
    with pytest.raises(ValueError):
        DefaultsGateCriteria.model_validate(extra)


# ---------- G4, G5, G6


def test_a_category_with_n_7_is_reported_not_gated_and_n_8_with_a_drop_fails_g4(tmp_path):
    criteria = _criteria(tmp_path)
    for n, expected in ((7, "not_gated"), (8, "fail")):
        baseline = _baseline({"category:typo": {"recall_at_10": (0.6, n), "mrr": (0.6, n)}})
        report = _report({"category:typo": {"recall_at_10": (0.57, n), "mrr": (0.6, n)}})
        result = evaluate_config_mode(_run("v2-default", "prechunked", report), baseline, _noise(), _budgets(), criteria)
        check = next(c for c in _criterion(result, "G4").checks if c.slice == "category:typo" and c.metric == "recall_at_10")
        assert check.status == expected and check.n == n
        assert _criterion(result, "G4").status == ("pass" if n == 7 else "fail")


def test_latency_above_the_budget_fails_g5_and_missing_latency_is_skipped(tmp_path):
    criteria = _criteria(tmp_path)
    slow = _report(latency={"retrieval_total": {"p50_ms": 10.0, "p95_ms": 201.0, "n": 40}, "rerank": {"p50_ms": 1.0, "p95_ms": 4.0, "n": 40}})
    result = evaluate_config_mode(_run("v2-default", "prechunked", slow), _baseline(), _noise(), _budgets(), criteria)
    assert _criterion(result, "G5").status == "fail"
    missing = evaluate_config_mode(_run("v2-default", "prechunked", _report(latency=None)), _baseline(), _noise(), _budgets(), criteria)
    assert _criterion(missing, "G5").status == "skipped"
    assert missing.passed is False


def test_a_legacy_run_with_a_nonzero_paired_difference_fails_g6(tmp_path):
    criteria = _criteria(tmp_path)
    moved = _report(items=[_item("a1", rank=2), _item("a2")])
    result = evaluate_config_mode(_run("legacy", "ingest", moved), _baseline(), _noise(), _budgets(), criteria, legacy=True)
    assert [c.id for c in result.criteria] == ["G6"]
    assert result.criteria[0].status == "fail" and result.passed is False
    same = evaluate_config_mode(_run("legacy", "ingest"), _baseline(), _noise(), _budgets(), criteria, legacy=True)
    assert same.passed is True


def test_hosted_fake_overrides_are_aligned_not_a_mismatch(tmp_path):
    criteria = _criteria(tmp_path)
    report = _report(overrides={"rerank_model": "fake-quality-v1"})
    result = evaluate_config_mode(_run("v2-default-hosted-fake", "prechunked", report), _baseline(), _noise(), _budgets(), criteria)
    assert _criterion(result, "G1").status == "pass"


# ---------- selections


def _failing_report(run_id: str) -> EvalReport:
    return _report({"overall": {"recall_at_10": (0.5, 40)}}, run_id=run_id)


def test_choose_floor_follows_the_registered_rule(tmp_path):
    criteria = _criteria(tmp_path)

    def select(overrides):
        result = _evaluate(criteria, _all_runs(overrides))
        return result.selection_details.floor

    assert select({}).chosen == "legacy_rule"  # tie
    higher = {(name, mode): _report({"overall": {"correct_refusal_rate": (0.51, 12)}}) for name in SIMILARITY for mode in MODES}
    assert select(higher).chosen == "similarity"
    one_similarity_fails = {**higher, (SIMILARITY[3], "ingest"): _failing_report("f")}
    assert select(one_similarity_fails).chosen == "legacy_rule"
    legacy_fails = {(REQUIRED[2], "prechunked"): _failing_report("f")}
    assert select(legacy_fails).chosen == "similarity"
    both = {**legacy_fails, (SIMILARITY[0], "ingest"): _failing_report("g")}
    neither = select(both)
    assert neither.chosen is None

    direct = choose_floor(criteria, _evaluate(criteria, _all_runs(both)).configurations, _all_runs(both))
    assert direct.chosen is None


def test_choose_no_key_fallback_follows_the_registered_rule(tmp_path):
    criteria = _criteria(tmp_path)
    baselines = {mode: _baseline() for mode in MODES}

    def select(overrides):
        runs = _all_runs(overrides)
        return choose_no_key_fallback(criteria, _evaluate(criteria, runs).configurations, runs, baselines, _noise())

    assert select({}).chosen == "local_bm25"
    # A cross-lingual drop beyond the band relative to none (inside the baseline band, so the configuration still passes).
    better_none = {(name, mode): _report({"category:cross_lingual": {"recall_at_10": (0.63, 10)}}) for name in NONE for mode in MODES}
    worse_bm25 = {(REQUIRED[1], "ingest"): _report({"category:cross_lingual": {"recall_at_10": (0.59, 10)}})}
    chosen = select({**better_none, **worse_bm25})
    assert chosen.chosen == "none"
    assert any(c.status == "fail" and c.slice == "category:cross_lingual" for c in chosen.candidates[0].comparisons)
    neither = select({(REQUIRED[0], "prechunked"): _failing_report("f"), (NONE[1], "ingest"): _failing_report("g")})
    assert neither.chosen is None


# ---------- CLI end to end


def _write_runs(directory: Path, runs: dict[tuple[str, str], RunInput]) -> None:
    for (name, mode), run in runs.items():
        target = directory / f"{name}-{mode}"
        target.mkdir(parents=True)
        _write(target / "report.json", run.report)
        _write(target / "run.json", run.manifest)


def test_evaluate_cli_writes_the_result_and_the_markdown(tmp_path, monkeypatch):
    ingest = _write(tmp_path / "ingest.json", _baseline())
    _write(tmp_path / "prechunked.json", _baseline())
    noise_path = _write(tmp_path / "noise.json", _noise())
    _write(tmp_path / "budgets.json", _budgets())
    rules = _rules(
        baselines={"prechunked": str(tmp_path / "prechunked.json"), "ingest": str(ingest)},
        noise_path=str(noise_path),
        budgets_path=str(tmp_path / "budgets.json"),
    )
    criteria_path = tmp_path / "criteria.json"
    criteria_path.write_text(dg.dump_criteria(derive_absolute_floor(rules, ingest, noise_path)), encoding="utf-8")
    reports = tmp_path / "reports"
    _write_runs(reports, _all_runs())
    g8 = tmp_path / "g8.json"
    g8.write_text(
        json.dumps(
            {
                "two_tenant_matrix": {"single_tenant": True, "multi_tenant": True},
                "negative_checks": {"drop_top_candidate_fails": True, "max_results_1_fails": True},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(dg, "git_changed_at", lambda _path: CHANGED_AT)
    out = tmp_path / "out"
    assert main(["evaluate", "--criteria", str(criteria_path), "--reports", str(reports), "--out", str(out), "--g8", str(g8)]) == 0
    result = DefaultsGateResult.model_validate_json((out / "defaults-gate.json").read_text(encoding="utf-8"))
    assert result.criteria_sha256 == dg.sha256_file(criteria_path)
    assert {s.role for s in result.sources} >= {"baseline:ingest", "baseline:prechunked", "noise", "latency_budgets", "g8"}
    assert next(s for s in result.sources if s.role == "baseline:ingest").sha256 == dg.sha256_file(ingest)
    markdown = (out / "defaults-gate.md").read_text(encoding="utf-8")
    for gid in ("G1", "G2", "G3", "G4", "G5", "G6", "G8"):
        assert gid in markdown
    assert main(["evaluate", "--criteria", str(criteria_path), "--reports", str(reports), "--out", str(tmp_path / "o2")]) == 1


def test_a_missing_report_is_malformed_input(tmp_path, monkeypatch):
    ingest = _write(tmp_path / "ingest.json", _baseline())
    noise_path = _write(tmp_path / "noise.json", _noise())
    _write(tmp_path / "budgets.json", _budgets())
    rules = _rules(baselines={"prechunked": str(ingest), "ingest": str(ingest)}, noise_path=str(noise_path), budgets_path=str(tmp_path / "budgets.json"))
    criteria_path = tmp_path / "criteria.json"
    criteria_path.write_text(dg.dump_criteria(derive_absolute_floor(rules, ingest, noise_path)), encoding="utf-8")
    monkeypatch.setattr(dg, "git_changed_at", lambda _path: CHANGED_AT)
    assert main(["evaluate", "--criteria", str(criteria_path), "--reports", str(tmp_path / "none"), "--out", str(tmp_path / "out")]) == 2


def test_the_module_and_the_committed_criteria_hold_no_baseline_value():
    source = (REPO / "eval" / "src" / "rag_eval" / "defaults_gate.py").read_text(encoding="utf-8")
    criteria_file = REPO / "eval" / "config" / "defaults-gate.json"
    rules_text = ""
    if criteria_file.exists():
        raw = json.loads(criteria_file.read_text(encoding="utf-8"))
        raw.pop("absolute", None)
        rules_text = json.dumps(raw)
    for name in ("fixture-baseline.json", "fixture-ingest-baseline.json"):
        baseline = json.loads((REPO / "eval" / "baselines" / name).read_text(encoding="utf-8"))
        for metrics in baseline["slices"].values():
            for stat in metrics.values():
                if stat.get("mean") in (None, 0, 0.0, 1, 1.0, 0.5):
                    continue
                text = repr(round(stat["mean"], 4))
                assert text not in source, f"{name} value {text} in the module"
                assert text not in rules_text, f"{name} value {text} in the criteria rules"


def test_the_committed_criteria_validate_and_name_existing_run_configs():
    raw = json.loads((REPO / "eval" / "config" / "defaults-gate.json").read_text(encoding="utf-8"))
    criteria = DefaultsGateCriteria.model_validate(raw)
    assert criteria.absolute is not None
    for name in [*criteria.configuration_names(), criteria.legacy_run_config]:
        assert (REPO / "eval" / "config" / "runs" / f"{name}.json").is_file(), name
    assert criteria.gated_metrics == NoiseConfig.model_validate_json(
        (REPO / criteria.noise_path).read_text(encoding="utf-8")
    ).metrics
