import hashlib
import json
from pathlib import Path

from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.report import EvalReport

import rag_eval.gate as gate_module
from rag_eval.gate import EXIT_INTERNAL, EXIT_REGRESSION, evaluate_gate, main

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
    assert noise.gated_slice_prefixes == ["overall", "language:"]
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
