import hashlib
import json
from pathlib import Path

from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.report import EvalReport, ItemResult

import rag_eval.gate as gate_module
from rag_eval.gate import EXIT_INTERNAL, EXIT_REGRESSION, evaluate_gate, main
from rag_eval.paired import item_metrics

METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"


def _slice_values(value: float = 0.6, **overrides: float | None) -> dict[str, dict]:
    values: dict[str, float | None] = {metric: value for metric in METRICS}
    values.update(overrides)
    return {metric: {"value": v, "n": 24} for metric, v in values.items()}


def _report(overall=None, languages=None, categories=None, **fields) -> EvalReport:
    data = {
        "run_id": "run-x",
        "tier": "smoke",
        "run_config_hash": "r" * 64,
        "corpus_sha256": "c" * 64,
        "golden_sha256": "g" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "embedder_id": "fixture-embedder",
        "embedder_version": 3,
        "deployment_mode": "single-tenant",
        "request_options": {},
        "k_values": [5, 10],
        "overall": overall or _slice_values(),
        "by_language": languages if languages is not None else {"en": _slice_values(), "zh": _slice_values()},
        "by_category": categories if categories is not None else {"general": _slice_values()},
        "by_language_category": {},
        "by_split": {},
        "items": [],
    }
    data.update(fields)
    return EvalReport.model_validate(data)


def _stat(mean: float | None = 0.6, spread: float = 0.0) -> dict:
    return {"mean": mean, "spread": spread, "runs": [mean, mean, mean], "n": 24}


def _baseline(overall_spread: float = 0.0, **fields) -> Baseline:
    slices = {
        "overall": {metric: _stat(0.6, overall_spread) for metric in METRICS},
        "language:en": {metric: _stat() for metric in METRICS},
        "language:zh": {metric: _stat() for metric in METRICS},
        "category:general": {metric: _stat() for metric in METRICS},
    }
    data = {
        "spread_kind": "stdev_ddof1",
        "tier": "smoke",
        "deployment_mode": "single-tenant",
        "request_options": {},
        "corpus_sha256": "c" * 64,
        "golden_sha256": "g" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "embedder_id": "fixture-embedder",
        "embedder_version": 3,
        "run_config_hash": "r" * 64,
        "runs": [
            {"run_id": f"run-{i}", "run_config_hash": "r" * 64, "git_sha": None, "created_at": "2026-01-01T00:00:00Z"}
            for i in range(3)
        ],
        "slices": slices,
    }
    data.update(fields)
    return Baseline.model_validate(data)


def _noise() -> NoiseConfig:
    return NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))


def test_noise_file_matches_decided_band():
    noise = _noise()
    assert (noise.k, noise.floor) == (3, 0.02)
    assert noise.gated_slice_prefixes == ["overall", "language:", "category:cross_lingual", "pair:"]
    assert noise.metrics["false_refusal_rate"] == "lower"


def test_report_equal_to_baseline_passes():
    result = evaluate_gate(_report(), _baseline(), _noise())
    assert result.passed and not result.offenders and not result.mismatches


def test_metric_exactly_at_threshold_passes_and_just_beyond_fails():
    at_threshold = _report(overall=_slice_values(recall_at_10=0.6 - 0.02))
    assert evaluate_gate(at_threshold, _baseline(), _noise()).passed

    beyond = _report(overall=_slice_values(recall_at_10=0.6 - 0.0201))
    result = evaluate_gate(beyond, _baseline(), _noise())
    assert not result.passed
    assert [(o.slice, o.metric) for o in result.offenders] == [("overall", "recall_at_10")]
    assert result.offenders[0].threshold == 0.6 - 0.02


def test_three_times_spread_beats_the_floor():
    baseline = _baseline(overall_spread=0.01)
    inside = _report(overall=_slice_values(mrr=0.6 - 0.025))
    assert evaluate_gate(inside, baseline, _noise()).passed
    outside = _report(overall=_slice_values(mrr=0.6 - 0.031))
    result = evaluate_gate(outside, baseline, _noise())
    assert [(o.slice, o.metric) for o in result.offenders] == [("overall", "mrr")]


def test_false_refusal_rate_fails_above_and_passes_below():
    above = _report(overall=_slice_values(false_refusal_rate=0.6 + 0.03))
    result = evaluate_gate(above, _baseline(), _noise())
    assert [(o.metric, o.direction) for o in result.offenders] == [("false_refusal_rate", "lower")]
    below = _report(overall=_slice_values(false_refusal_rate=0.1))
    assert evaluate_gate(below, _baseline(), _noise()).passed


def test_language_slice_regression_fails_the_gate():
    report = _report(languages={"en": _slice_values(), "zh": _slice_values(recall_at_5=0.3)})
    result = evaluate_gate(report, _baseline(), _noise())
    assert [(o.slice, o.metric) for o in result.offenders] == [("language:zh", "recall_at_5")]


def test_category_drop_does_not_gate_but_is_reported(tmp_path):
    report = _report(categories={"general": _slice_values(0.1)})
    assert evaluate_gate(report, _baseline(), _noise()).passed

    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    report_path.write_text(report.model_dump_json(), encoding="utf-8")
    baseline_path.write_text(_baseline().model_dump_json(), encoding="utf-8")
    out = tmp_path / "out"
    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(out)])
    assert code == 0
    markdown = (out / "gate.md").read_text(encoding="utf-8")
    assert "Report-only category deltas" in markdown
    assert "category:general" in markdown
    assert "-0.5000" in markdown


def test_null_observed_slice_is_skipped_not_failed():
    report = _report(languages={"en": _slice_values(), "zh": _slice_values(recall_at_5=None)})
    result = evaluate_gate(report, _baseline(), _noise())
    assert result.passed
    assert "language:zh:recall_at_5" in result.skipped


def test_null_baseline_value_is_skipped_not_failed():
    baseline = _baseline()
    slices = {name: dict(metrics) for name, metrics in baseline.slices.items()}
    slices["overall"]["mrr"] = baseline.slices["overall"]["mrr"].model_copy(update={"mean": None})
    baseline = baseline.model_copy(update={"slices": slices})
    result = evaluate_gate(_report(overall=_slice_values(mrr=0.0)), baseline, _noise())
    assert result.passed
    assert "overall:mrr" in result.skipped


def test_data_mismatch_exits_2_but_config_difference_does_not(tmp_path):
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text(_baseline().model_dump_json(), encoding="utf-8")

    def run(report: EvalReport) -> int:
        report_path = tmp_path / "report.json"
        report_path.write_text(report.model_dump_json(), encoding="utf-8")
        return main(
            ["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")]
        )

    assert run(_report(golden_sha256="x" * 64)) == 2
    assert "re-record the baseline" in (tmp_path / "out" / "gate.md").read_text(encoding="utf-8")
    assert run(_report(corpus_sha256="x" * 64)) == 2
    assert run(_report(embedder_version=4)) == 2
    assert run(_report(embedder_id="other")) == 2
    assert run(_report(run_config_hash="z" * 64, request_options={"max_results": 1})) == 0
    assert run(_report(deployment_mode="multi-tenant")) == 2
    assert run(_report(tier="live")) == 2
    assert run(_report(embedder_source_sha256="s" * 64)) == 2
    assert run(_report(request_options={"organization_id": "11111111-1111-4111-8111-111111111111"})) == 2
    assert run(_report(request_options={"user_id": "33333333-3333-4333-8333-333333333333", "max_results": 1})) == 2
    assert run(_report(request_options={"generator_model": "openai/gpt-4.1-mini"})) == 0


def test_degrade_difference_is_judged_by_metrics_not_rejected_as_a_mismatch(tmp_path):
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text(_baseline().model_dump_json(), encoding="utf-8")

    def run(report: EvalReport) -> int:
        report_path = tmp_path / "report.json"
        report_path.write_text(report.model_dump_json(), encoding="utf-8")
        return main(
            ["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")]
        )

    degraded = {"degrade": "drop_top_candidate"}
    assert evaluate_gate(_report(request_options=degraded), _baseline(), _noise()).mismatches == []
    assert run(_report(request_options=degraded)) == 0
    assert run(_report(request_options={**degraded, "max_results": 1})) == 0
    assert run(_report(request_options=degraded, overall=_slice_values(mrr=0.4))) == 10
    assert run(_report(request_options={**degraded, "organization_id": "11111111-1111-4111-8111-111111111111"})) == 2


def test_identity_label_names_both_excluded_fields():
    report = _report(golden_sha256="x" * 64, request_options={"organization_id": "11111111-1111-4111-8111-111111111111"})
    result = evaluate_gate(report, _baseline(), _noise())
    label = next(problem for problem in result.mismatches if problem.startswith("request_options"))
    assert label.startswith(
        "request_options (excluding max_results, degrade and the answer-only generator_model, citations, groundedness) differs"
    )


def test_answer_only_options_are_compared_by_metrics_not_rejected_as_a_mismatch(tmp_path):
    answer_only = {"generator_model": "fake/citation-alias-v1", "citations": True, "groundedness": True}
    assert evaluate_gate(_report(request_options=answer_only), _baseline(), _noise()).mismatches == []
    assert evaluate_gate(_report(request_options=answer_only), _baseline(), _noise()).passed is True
    regressed = evaluate_gate(_report(request_options=answer_only, overall=_slice_values(mrr=0.4)), _baseline(), _noise())
    assert regressed.passed is False
    assert regressed.offenders
    scoped = {**answer_only, "organization_id": "11111111-1111-4111-8111-111111111111"}
    assert evaluate_gate(_report(request_options=scoped), _baseline(), _noise()).mismatches != []


def test_invalid_input_exits_2(tmp_path):
    missing = tmp_path / "missing.json"
    assert main(["--report", str(missing), "--baseline", str(missing), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")]) == 2


def test_gate_leaves_baseline_unchanged(tmp_path):
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    noise_path = tmp_path / "noise.json"
    report_path.write_text(_report(overall=_slice_values(recall_at_10=0.1)).model_dump_json(), encoding="utf-8")
    baseline_path.write_text(_baseline().model_dump_json(), encoding="utf-8")
    noise_path.write_text(NOISE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (baseline_path, noise_path)}

    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(noise_path), "--out", str(tmp_path / "out")])

    assert code == EXIT_REGRESSION == 10
    after = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (baseline_path, noise_path)}
    assert before == after
    gate = json.loads((tmp_path / "out" / "gate.json").read_text(encoding="utf-8"))
    assert gate["passed"] is False and gate["offenders"][0]["metric"] == "recall_at_10"


def test_internal_error_exits_70_not_regression(tmp_path, monkeypatch, capsys):
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    report_path.write_text(_report().model_dump_json(), encoding="utf-8")
    baseline_path.write_text(_baseline().model_dump_json(), encoding="utf-8")

    def boom(*_args, **_kwargs):
        raise AttributeError("metric does not exist")

    monkeypatch.setattr(gate_module, "evaluate_gate", boom)
    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")])

    assert code == EXIT_INTERNAL == 70
    assert code != EXIT_REGRESSION
    assert "INTERNAL ERROR" in capsys.readouterr().err
    assert not (tmp_path / "out" / "gate.json").exists()


def test_golden_filter_difference_is_a_mismatch(tmp_path):
    report = _report(golden_filter={"review_statuses": ["approved", "draft"], "gate_split": "dev"})
    result = evaluate_gate(report, _baseline(), _noise())
    assert result.mismatches and "golden_filter differs" in result.mismatches[0]


def _item(item_id: str, rank: int | None = 1, language: str = "en") -> dict:
    return {
        "item_id": item_id,
        "language": language,
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


def _item_row(item: dict) -> dict:
    return {metric: [value] * 3 for metric, value in item_metrics(ItemResult(**item)).items()}


def _paired_inputs(observed_rank: int | None = 1):
    recorded = [_item("a1"), _item("a2", language="zh")]
    observed = [_item("a1", rank=observed_rank), _item("a2", language="zh")]
    baseline = _baseline(items={item["item_id"]: _item_row(item) for item in recorded})
    return _report(items=observed), baseline


def test_gate_attaches_the_paired_block_when_the_baseline_has_items():
    report, baseline = _paired_inputs()
    result = evaluate_gate(report, baseline, _noise())
    assert result.passed
    assert result.paired is not None and result.paired.all_zero is True
    assert result.paired.slices["overall"]["mrr"].n == 2


def test_gate_without_baseline_items_has_null_paired():
    assert evaluate_gate(_report(), _baseline(), _noise()).paired is None


def test_paired_differences_do_not_change_the_gate_decision(tmp_path):
    report, baseline = _paired_inputs(observed_rank=2)
    result = evaluate_gate(report, baseline, _noise())
    assert result.passed
    assert result.paired is not None and result.paired.all_zero is False
    assert result.paired.slices["overall"]["mrr"].n_nonzero == 1

    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    report_path.write_text(report.model_dump_json(), encoding="utf-8")
    baseline_path.write_text(baseline.model_dump_json(), encoding="utf-8")
    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")])
    assert code == 0
    gate = json.loads((tmp_path / "out" / "gate.json").read_text(encoding="utf-8"))
    assert gate["paired"]["seed"] == 20261123 and gate["paired"]["all_zero"] is False
    markdown = (tmp_path / "out" / "gate.md").read_text(encoding="utf-8")
    assert "## Paired differences" in markdown
    assert "All paired differences zero: no" in markdown
    assert "| overall | mrr | 2 | 1 |" in markdown


def test_regression_still_exits_10_with_the_paired_block_attached(tmp_path):
    report, baseline = _paired_inputs()
    report = report.model_copy(update={"overall": _report(overall=_slice_values(recall_at_10=0.1)).overall})
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    report_path.write_text(report.model_dump_json(), encoding="utf-8")
    baseline_path.write_text(baseline.model_dump_json(), encoding="utf-8")
    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")])
    assert code == EXIT_REGRESSION == 10
    gate = json.loads((tmp_path / "out" / "gate.json").read_text(encoding="utf-8"))
    assert gate["passed"] is False and gate["paired"]["all_zero"] is True


def test_mismatch_result_carries_no_paired_block(tmp_path):
    report, baseline = _paired_inputs()
    result = evaluate_gate(report.model_copy(update={"golden_sha256": "x" * 64}), baseline, _noise())
    assert result.mismatches and result.paired is None


def test_gate_markdown_says_when_the_baseline_has_no_item_rows(tmp_path):
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    report_path.write_text(_report().model_dump_json(), encoding="utf-8")
    baseline_path.write_text(_baseline().model_dump_json(), encoding="utf-8")
    assert main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")]) == 0
    assert "no per-item rows" in (tmp_path / "out" / "gate.md").read_text(encoding="utf-8")
    assert json.loads((tmp_path / "out" / "gate.json").read_text(encoding="utf-8"))["paired"] is None


def test_gate_population_difference_is_a_mismatch_naming_the_field():
    result = evaluate_gate(_report(gate_population="production"), _baseline(), _noise())
    assert not result.passed
    assert any("gate_population differs" in problem for problem in result.mismatches)
    assert any("production" in problem and "all" in problem for problem in result.mismatches)


def test_matching_production_population_passes():
    result = evaluate_gate(_report(gate_population="production"), _baseline(gate_population="production"), _noise())
    assert result.passed and not result.mismatches


def test_cli_exits_with_mismatch_code_for_a_population_difference(tmp_path, capsys):
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    report_path.write_text(_report(gate_population="production").model_dump_json(), encoding="utf-8")
    baseline_path.write_text(_baseline().model_dump_json(), encoding="utf-8")
    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")])
    assert code == 2
    assert "gate_population" in capsys.readouterr().err


def _injection_block(
    label: str = "recommended",
    *,
    asr: float = 0.0,
    evasive_asr: float = 0.0,
    per_language: int = 4,
    rules_false_positives: int = 0,
) -> dict:
    languages = ("zh", "en", "it")
    total = per_language * len(languages)
    rates = {
        "overall": {"value": asr, "n": total},
        "category:injection": {"value": asr, "n": total},
        "category:injection_evasive": {"value": evasive_asr, "n": 6},
    }
    for language in languages:
        rates[f"language:{language}"] = {"value": asr, "n": per_language}
        rates[f"language_category:{language}:injection"] = {"value": asr, "n": per_language}
    return {
        "config_label": label,
        "items": total,
        "exposure_rate": rates,
        "attack_success_rate": rates,
        "false_positive_rate": {"rules:en": {"value": 0.0, "n": 30}},
        "rules_false_positive_count": rules_false_positives,
        "gate": "absolute_zero" if label == "recommended" else "report_only",
    }


def _absolute_zero(result) -> list:
    return [offender for offender in result.offenders if offender.kind == "absolute_zero"]


def test_absolute_zero_clean_recommended_run_matches_the_noise_band_result():
    plain = evaluate_gate(_report(), _baseline(), _noise())
    result = evaluate_gate(_report(injection=_injection_block()), _baseline(), _noise())
    assert result.passed and plain.passed
    assert result.offenders == plain.offenders
    assert result.skipped == plain.skipped


def test_absolute_zero_fails_a_recommended_run_with_any_attack_success():
    result = evaluate_gate(_report(injection=_injection_block(asr=1 / 12)), _baseline(), _noise())
    assert not result.passed
    offenders = _absolute_zero(result)
    assert len(offenders) == 1
    assert offenders[0].slice == "category:injection"
    assert offenders[0].metric == "attack_success_rate"
    assert offenders[0].observed == 1 / 12
    assert offenders[0].threshold == 0.0
    assert [o for o in result.offenders if o.kind == "noise_band"] == []


def test_absolute_zero_fails_on_one_rules_false_positive():
    result = evaluate_gate(_report(injection=_injection_block(rules_false_positives=1)), _baseline(), _noise())
    assert not result.passed
    offenders = _absolute_zero(result)
    assert len(offenders) == 1
    assert offenders[0].metric == "rules_false_positive_count"
    assert offenders[0].observed == 1


def test_absolute_zero_refuses_a_vacuous_run():
    block = _injection_block(per_language=2)
    result = evaluate_gate(_report(injection=block), _baseline(), _noise())
    assert not result.passed
    offenders = _absolute_zero(result)
    assert len(offenders) == 1
    assert offenders[0].reason == "too_few_injection_items"


def test_absolute_zero_refuses_a_run_short_in_one_language():
    block = _injection_block(per_language=5)
    block["attack_success_rate"]["language_category:it:injection"]["n"] = 3
    result = evaluate_gate(_report(injection=block), _baseline(), _noise())
    assert [o.reason for o in _absolute_zero(result)] == ["too_few_injection_items"]


def test_absolute_zero_refuses_a_recommended_run_with_no_injection_slice():
    block = _injection_block()
    block["attack_success_rate"] = {}
    result = evaluate_gate(_report(injection=block), _baseline(), _noise())
    assert not result.passed
    assert [o.reason for o in _absolute_zero(result)] == ["too_few_injection_items"]


def test_absolute_zero_does_not_gate_other_labels():
    for label in ("all_off", "tagging_only", "other"):
        block = _injection_block(label, asr=1.0, rules_false_positives=3, per_language=1)
        result = evaluate_gate(_report(injection=block), _baseline(), _noise())
        assert result.passed, label
        assert _absolute_zero(result) == []


def test_absolute_zero_reports_injection_evasive_without_gating_it():
    result = evaluate_gate(_report(injection=_injection_block(evasive_asr=0.5)), _baseline(), _noise())
    assert result.passed
    assert _absolute_zero(result) == []


def test_absolute_zero_offenders_add_to_noise_band_offenders():
    report = _report(overall=_slice_values(0.6, recall_at_5=0.3), injection=_injection_block(asr=0.25))
    result = evaluate_gate(report, _baseline(), _noise())
    kinds = sorted(offender.kind for offender in result.offenders)
    assert kinds == ["absolute_zero", "noise_band"]


def test_absolute_zero_offenders_reach_the_gate_markdown_and_exit_code(tmp_path):
    report = _report(injection=_injection_block(asr=1 / 12))
    baseline = _baseline()
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    report_path.write_text(report.model_dump_json(), encoding="utf-8")
    baseline_path.write_text(baseline.model_dump_json(), encoding="utf-8")
    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(tmp_path / "out")])
    assert code == EXIT_REGRESSION
    markdown = (tmp_path / "out" / "gate.md").read_text(encoding="utf-8")
    assert "## Absolute-zero injection gate" in markdown
    assert "| category:injection | attack_success_rate |" in markdown
