import json
from datetime import date
from pathlib import Path

import pytest
from rag_sidecar.contracts.quality_gates import QualityGates, default_quality_gates
from rag_sidecar.contracts.report import EvalReport, ItemResult
from test_gate import _baseline, _noise, _stat

import rag_eval.absolute_gate as absolute_module
from rag_eval.absolute_gate import EXIT_ABSOLUTE, EXIT_COMPOSITION, evaluate, exit_code_for, main
from rag_eval.gate import EXIT_INTERNAL, evaluate_gate

GATES_PATH = Path(__file__).resolve().parents[1] / "config" / "quality-gates.json"
TODAY = date(2026, 11, 26)
FINGERPRINT = "a" * 64
OTHER_FINGERPRINT = "b" * 64


def _gates(**updates: dict) -> QualityGates:
    data = default_quality_gates().model_dump(mode="json")
    for block, values in updates.items():
        data[block] = {**data[block], **values}
    return QualityGates.model_validate(data)


def _metric(value: float | None, n: int) -> dict:
    return {"value": value, "n": n}


def _slice(*, refused: int = 19, unanswerable: int = 20, false_refusals: int = 0, answerable: int = 80) -> dict:
    correct = refused / unanswerable if unanswerable else None
    return {
        "recall_at_5": _metric(0.6, answerable),
        "recall_at_10": _metric(0.6, answerable),
        "mrr": _metric(0.6, answerable),
        "correct_refusal_rate": _metric(correct, unanswerable),
        "false_refusal_rate": _metric(false_refusals / answerable if answerable else None, answerable),
        "false_answer_rate": _metric(None if correct is None else 1 - correct, unanswerable),
    }


def _row(item_id: str, language: str, category: str, *, refused: bool = False) -> dict:
    answerable = category not in {"no_answer", "small_talk"}
    return {
        "item_id": item_id,
        "language": language,
        "category": category,
        "split": "dev",
        "provenance": "synthetic_fixture",
        "answerable": answerable,
        "refused": refused,
        "span_count": 1 if answerable else 0,
        "spans_hit_at_5": 1 if answerable else 0,
        "spans_hit_at_10": 1 if answerable else 0,
        "first_hit_rank": 1 if answerable else None,
    }


def _rows(language: str, *, total: int = 100, no_answer: int = 20, small_talk: int = 0) -> list[dict]:
    rows = [_row(f"{language}-na-{i:03d}", language, "no_answer", refused=True) for i in range(no_answer)]
    rows += [_row(f"{language}-st-{i:03d}", language, "small_talk", refused=True) for i in range(small_talk)]
    rows += [_row(f"{language}-g-{i:03d}", language, "general") for i in range(total - no_answer - small_talk)]
    return rows


def _report(*, overall: dict | None = None, languages: dict | None = None, items: list[dict] | None = None, **fields):
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
        "overall": overall or _slice(),
        "by_language": languages if languages is not None else {"en": _slice()},
        "by_category": {"general": _slice()},
        "by_language_category": {},
        "by_split": {},
        "items": items if items is not None else _rows("en"),
    }
    data.update(fields)
    return EvalReport.model_validate(data)


def _rows_of(result, check: str) -> dict[str, object]:
    return {row.slice: row for row in result.checks if row.check == check}


def test_three_of_twenty_answered_passes_the_noise_band_and_fails_the_strict_ceiling_with_exit_11():
    seventeen = _slice(refused=17)
    report = _report(overall=seventeen, languages={"en": seventeen})
    baseline = _baseline()
    for name in ("overall", "language:en"):
        baseline.slices[name]["correct_refusal_rate"] = baseline.slices[name]["correct_refusal_rate"].model_copy(
            update={"mean": 0.85, "runs": [0.85, 0.85, 0.85]}
        )
        for metric in ("recall_at_5", "recall_at_10", "mrr", "false_refusal_rate"):
            value = 0.0 if metric == "false_refusal_rate" else 0.6
            baseline.slices[name][metric] = baseline.slices[name][metric].model_validate(_stat(value))
    noise_result = evaluate_gate(report, baseline, _noise())
    assert noise_result.passed, noise_result.offenders

    result = evaluate(report, _gates(), tier="smoke")
    row = _rows_of(result, "false_answer_rate")["overall"]
    assert (row.result, row.measured, row.limit, row.numerator, row.denominator) == ("failed", 0.15, 0.05, 3, 20)
    assert result.passed is False
    assert exit_code_for(result) == EXIT_ABSOLUTE == 11
    assert result.exit_code == 11


def test_report_without_false_answer_rate_is_read_as_one_minus_correct_refusal():
    old = _slice(refused=17)
    del old["false_answer_rate"]
    result = evaluate(_report(overall=old, languages={}), _gates(), tier="smoke")
    row = _rows_of(result, "false_answer_rate")["overall"]
    assert row.result == "failed" and row.measured == pytest.approx(0.15) and row.denominator == 20


def test_language_slice_below_min_n_is_insufficient_n_and_does_not_change_the_verdict():
    small = _slice(refused=5, unanswerable=8)
    result = evaluate(_report(languages={"en": _slice(), "it": small}), _gates(), tier="smoke")
    rows = _rows_of(result, "false_answer_rate")
    assert rows["language:it"].result == "insufficient_n"
    assert rows["language:en"].result == "passed"
    assert rows["overall"].result == "passed"
    assert result.passed and exit_code_for(result) == 0


def test_overall_is_checked_even_below_min_n():
    tiny = _slice(refused=7, unanswerable=8)
    result = evaluate(_report(overall=tiny, languages={}), _gates(), tier="smoke")
    assert _rows_of(result, "false_answer_rate")["overall"].result == "failed"


def test_balanced_run_lists_the_false_answer_ceiling_as_report_only():
    seventeen = _slice(refused=17)
    report = _report(overall=seventeen, languages={"en": seventeen}, rag_mode="balanced")
    result = evaluate(report, _gates(), tier="smoke")
    rows = _rows_of(result, "false_answer_rate")
    assert {row.result for row in rows.values()} == {"report_only"}
    assert rows["overall"].reason == "ceiling_not_set"
    assert result.rag_mode == "balanced" and result.passed


def test_false_refusal_ceiling_uses_the_run_mode():
    many = _slice(false_refusals=24, answerable=80)
    result = evaluate(_report(overall=many, languages={}), _gates(), tier="smoke")
    row = _rows_of(result, "false_refusal_rate")["overall"]
    assert (row.result, row.measured, row.limit) == ("failed", pytest.approx(0.3), 0.25)
    assert exit_code_for(result) == 11


def _composition(result, language: str):
    return next(entry for entry in result.composition.languages if entry.language == language)


def test_language_below_the_no_answer_minimum_fails_with_exit_12():
    result = evaluate(_report(items=_rows("en", no_answer=14) + _rows("zh")), _gates(), tier="smoke")
    entry = _composition(result, "en")
    assert (entry.result, entry.share, entry.no_answer, entry.items) == ("failed", 0.14, 14, 100)
    assert _composition(result, "zh").result == "passed"
    assert exit_code_for(result) == EXIT_COMPOSITION == 12
    assert "no_answer_share_below_min" in result.failed


def test_language_between_minimum_and_target_is_a_warning_and_exits_0():
    result = evaluate(_report(items=_rows("en", no_answer=17)), _gates(), tier="smoke")
    assert _composition(result, "en").result == "warning"
    assert result.passed and exit_code_for(result) == 0


def test_language_with_too_few_items_is_insufficient_n_never_passed():
    result = evaluate(_report(items=_rows("en") + _rows("it", total=10, no_answer=0)), _gates(), tier="smoke")
    assert _composition(result, "it").result == "insufficient_n"
    assert result.passed


def test_small_talk_is_not_counted_as_no_answer_and_kinds_are_listed():
    rows = _rows("en", no_answer=10, small_talk=10)
    result = evaluate(_report(items=rows), _gates(), tier="smoke")
    entry = _composition(result, "en")
    assert (entry.items, entry.no_answer, entry.result) == (90, 10, "failed")
    assert entry.kinds == {"no_answer": 10}
    assert exit_code_for(result) == 12


def test_pooled_share_is_checked_too():
    result = evaluate(_report(items=_rows("en", no_answer=14)), _gates(), tier="smoke")
    pooled = _rows_of(result, "no_answer_share")["overall"]
    assert (pooled.result, pooled.measured, pooled.limit, pooled.limit_kind) == ("failed", 0.14, 0.15, "min")


def test_required_no_answer_kind_with_zero_items_fails():
    gates = _gates(composition={"required_no_answer_kinds": ["off_topic_context"]})
    result = evaluate(_report(), gates, tier="smoke")
    assert result.composition.missing_required_kinds == ["off_topic_context"]
    assert exit_code_for(result) == 12


def test_paraphrased_items_are_not_in_the_composition_population():
    rows = _rows("en", no_answer=20)
    rows += [{**_row(f"en-p-{i:03d}", "en", "general"), "provenance": "paraphrased"} for i in range(40)]
    result = evaluate(_report(items=rows), _gates(), tier="smoke")
    assert (_composition(result, "en").items, _composition(result, "en").result) == (100, "passed")


def test_stale_share_above_the_limit_fails_with_exit_12_and_its_code():
    result = evaluate(_report(stale_count=12, stale_share=0.12), _gates(), tier="smoke")
    assert result.stale_result == "failed" and result.stale_share == 0.12 and result.stale_count == 12
    assert "stale_share_exceeded" in result.failed
    assert exit_code_for(result) == 12


def test_stale_share_at_the_limit_passes():
    result = evaluate(_report(stale_count=10, stale_share=0.10), _gates(), tier="smoke")
    assert result.stale_result == "passed" and result.passed


def test_composition_and_ceiling_failures_together_exit_12_and_list_both():
    seventeen = _slice(refused=17)
    report = _report(overall=seventeen, languages={}, items=_rows("en", no_answer=14))
    result = evaluate(report, _gates(), tier="smoke")
    assert exit_code_for(result) == 12
    assert {"false_answer_rate_exceeded", "no_answer_share_below_min"} <= set(result.failed)


def test_report_mode_lists_failures_but_exits_0():
    seventeen = _slice(refused=17)
    report = _report(overall=seventeen, languages={}, stale_count=12, stale_share=0.12)
    result = evaluate(report, _gates(), tier="smoke", mode="report")
    assert result.passed is False and result.mode == "report"
    assert {"false_answer_rate_exceeded", "stale_share_exceeded"} <= set(result.failed)
    assert exit_code_for(result) == 0 and result.exit_code == 0


def _judge_report(value: float = 0.80, language: str = "en") -> dict:
    metrics = {
        f"{library}.{metric}": {"value": value, "n": 30}
        for library in ("deepeval", "ragas")
        for metric in ("faithfulness", "answer_relevance", "context_recall")
    }
    return {
        "run_id": "run-x",
        "run_config_hash": "r" * 64,
        "judge_model": "judge/model",
        "judge_family": "judge",
        "generator_model": "gen/model",
        "generator_family": "gen",
        "items": [],
        "overall": metrics,
        "by_language": {language: metrics},
        "by_category": {},
    }


def _cell(
    *,
    status: str = "gating",
    fingerprint: str = FINGERPRINT,
    recorded_at: str = "2026-11-20T00:00:00Z",
    library: str = "ragas",
    metric: str = "faithfulness",
    language: str = "en",
) -> dict:
    return {
        "key": f"{fingerprint}|nightly|{language}|{library}.{metric}",
        "fingerprint": fingerprint,
        "role": "nightly",
        "language": language,
        "library": library,
        "metric": metric,
        "status": status,
        "reasons": [] if status == "gating" else ["n_below_minimum"],
        "kappa": 0.74,
        "accuracy": 0.88,
        "n": 60 if status == "gating" else 10,
        "source": "review_queue",
        "labels_human_confirmed": True,
        "recorded_at": recorded_at,
    }


def _calibration(*cells: dict) -> dict:
    return {
        "schema_version": 1,
        "cells": list(cells),
        "running_fingerprints": {"nightly": FINGERPRINT},
        "provenance": {"source": "calibration"},
    }


def _floor(result, library: str = "ragas", metric: str = "faithfulness", language: str = "en"):
    return _rows_of(result, f"floor_{metric}")[f"language:{language}:{library}"]


def _nightly(calibration: dict | None, *, fingerprints: dict | None = None, value: float = 0.80):
    from rag_sidecar.contracts.judge import JudgeReport

    return evaluate(
        _report(tier="nightly"),
        _gates(),
        tier="nightly",
        judge_report=JudgeReport.model_validate(_judge_report(value)),
        calibration=calibration,
        running_fingerprints={"nightly": FINGERPRINT} if fingerprints is None else fingerprints,
        today=TODAY,
    )


def test_nightly_floor_fails_only_for_a_fresh_gating_cell_with_the_running_fingerprint():
    result = _nightly(_calibration(_cell()))
    row = _floor(result)
    assert (row.result, row.measured, row.limit, row.limit_kind) == ("failed", 0.80, 0.85, "min")
    assert "floor_not_met" in result.failed and exit_code_for(result) == 11
    assert _floor(result, library="deepeval").result == "report_only"


def test_nightly_floor_at_or_above_the_floor_passes():
    result = _nightly(_calibration(_cell()), value=0.85)
    assert _floor(result).result == "passed" and result.passed


@pytest.mark.parametrize(
    ("calibration", "fingerprints", "reason"),
    [
        (_calibration(_cell(status="report_only")), None, "calibration_report_only"),
        (_calibration(_cell(recorded_at="2026-10-01T00:00:00Z")), None, "calibration_expired"),
        (_calibration(_cell(fingerprint=OTHER_FINGERPRINT)), None, "fingerprint_mismatch"),
        (_calibration(), None, "uncalibrated"),
        (None, None, "uncalibrated"),
        (_calibration(_cell()), {}, "judge_fingerprint_unknown"),
    ],
)
def test_nightly_floor_is_report_only_for_every_demoted_cell(calibration, fingerprints, reason):
    result = _nightly(calibration, fingerprints=fingerprints)
    row = _floor(result)
    assert (row.result, row.reason) == ("report_only", reason)
    assert row.measured == 0.80
    assert result.passed and exit_code_for(result) == 0


def test_smoke_tier_has_no_floors_and_ignores_the_judge_report():
    from rag_sidecar.contracts.judge import JudgeReport

    result = evaluate(
        _report(),
        _gates(),
        tier="smoke",
        judge_report=JudgeReport.model_validate(_judge_report(0.1)),
        calibration=_calibration(_cell()),
        running_fingerprints={"nightly": FINGERPRINT},
        today=TODAY,
    )
    assert not [row for row in result.checks if row.check.startswith("floor_")]


def test_nightly_floor_without_a_judge_report_is_skipped_not_passed():
    result = evaluate(_report(tier="nightly"), _gates(), tier="nightly", today=TODAY)
    rows = [row for row in result.checks if row.check.startswith("floor_")]
    assert rows and {(row.result, row.reason) for row in rows} == {("skipped", "judge_report_missing")}
    assert result.passed


def _write(path: Path, payload: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload) if not isinstance(payload, str) else payload, encoding="utf-8")
    return path


def test_check_cli_writes_json_and_markdown_and_returns_the_code(tmp_path: Path, capsys):
    seventeen = _slice(refused=17)
    report = _write(tmp_path / "report.json", _report(overall=seventeen, languages={}).model_dump_json())
    out = tmp_path / "out"
    code = main(["check", "--report", str(report), "--gates", str(GATES_PATH), "--tier", "smoke", "--out", str(out)])
    assert code == 11
    data = json.loads((out / "absolute.json").read_text(encoding="utf-8"))
    assert data["exit_code"] == 11 and "false_answer_rate_exceeded" in data["failed"]
    markdown = (out / "absolute.md").read_text(encoding="utf-8")
    assert "## Ceilings" in markdown and "## Stale share" in markdown and "None." in markdown
    assert "false_answer_rate_exceeded" in capsys.readouterr().err


def test_check_cli_report_mode_exits_0(tmp_path: Path):
    seventeen = _slice(refused=17)
    report = _write(tmp_path / "report.json", _report(overall=seventeen, languages={}).model_dump_json())
    code = main(
        ["check", "--report", str(report), "--gates", str(GATES_PATH), "--tier", "smoke", "--mode", "report",
         "--out", str(tmp_path / "out")]
    )
    assert code == 0
    assert json.loads((tmp_path / "out" / "absolute.json").read_text(encoding="utf-8"))["passed"] is False


def test_check_cli_reads_judge_report_and_calibration(tmp_path: Path):
    report = _write(tmp_path / "report.json", _report(tier="nightly").model_dump_json())
    judge = _write(tmp_path / "judge.json", _judge_report(0.80))
    calibration = _write(tmp_path / "calibration.json", _calibration(_cell(recorded_at="2099-01-01T00:00:00Z")))
    code = main(
        ["check", "--report", str(report), "--gates", str(GATES_PATH), "--tier", "nightly", "--judge-report", str(judge),
         "--calibration", str(calibration), "--judge-fingerprint", FINGERPRINT, "--out", str(tmp_path / "out")]
    )
    assert code == 11


def test_check_cli_invalid_input_exits_2(tmp_path: Path):
    bad = _write(tmp_path / "report.json", "{}")
    code = main(["check", "--report", str(bad), "--gates", str(GATES_PATH), "--tier", "smoke", "--out", str(tmp_path)])
    assert code == 2


def test_cli_crash_exits_70_not_a_gate_failure(tmp_path: Path, monkeypatch, capsys):
    report = _write(tmp_path / "report.json", _report().model_dump_json())

    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(absolute_module, "evaluate", boom)
    code = main(["check", "--report", str(report), "--gates", str(GATES_PATH), "--tier", "smoke", "--out", str(tmp_path)])
    assert code == EXIT_INTERNAL == 70
    assert "INTERNAL ERROR" in capsys.readouterr().err


def test_measure_writes_one_record_with_per_tier_checks_and_would_be_codes(tmp_path: Path):
    seventeen = _slice(refused=17)
    failing = _write(tmp_path / "smoke" / "report.json", _report(overall=seventeen, languages={}).model_dump_json())
    passing = _write(tmp_path / "ingest" / "report.json", _report().model_dump_json())
    out = tmp_path / "measure.json"
    code = main(
        ["measure", "--stage", "before", "--tier", f"smoke={failing}", "--tier", f"ingest={passing}",
         "--gates", str(GATES_PATH), "--out", str(out)]
    )
    assert code == 0
    record = json.loads(out.read_text(encoding="utf-8"))
    tiers = {entry["name"]: entry for entry in record["tiers"]}
    assert [entry["name"] for entry in record["tiers"]] == ["ingest", "smoke"]
    assert all(entry["stage"] == "before" for entry in record["tiers"])
    assert tiers["smoke"]["exit_code"] == 11 and tiers["ingest"]["exit_code"] == 0
    assert tiers["smoke"]["out"] == str(Path(failing).parent)
    assert tiers["smoke"]["checks"]
    assert tiers["smoke"]["false_answer_rate"] == pytest.approx(0.15)
    assert tiers["smoke"]["rag_mode"] == "strict" and tiers["smoke"]["composition_result"] in {"passed", "insufficient_n", "failed"}


def test_measure_records_wall_time_gate_exit_and_keeps_other_stages(tmp_path: Path):
    report = _write(tmp_path / "smoke" / "report.json", _report().model_dump_json())
    out = tmp_path / "measure.json"
    markdown = tmp_path / "measure.md"
    base = ["measure", "--tier", f"smoke={report}", "--gates", str(GATES_PATH), "--out", str(out)]
    assert main([*base, "--stage", "before", "--wall-time", "smoke=12.5", "--gate-exit", "smoke=0", "--markdown", str(markdown)]) == 0
    assert main([*base, "--stage", "after"]) == 0
    assert main([*base, "--stage", "before", "--wall-time", "smoke=13"]) == 0
    record = json.loads(out.read_text(encoding="utf-8"))
    assert [(entry["name"], entry["stage"]) for entry in record["tiers"]] == [("smoke", "after"), ("smoke", "before")]
    before = next(entry for entry in record["tiers"] if entry["stage"] == "before")
    assert before["wall_time_s"] == 13.0 and before["gate_exit"] is None
    text = markdown.read_text(encoding="utf-8")
    assert "wall time" in text and "| smoke | before |" in text


def test_measure_rejects_a_wall_time_for_an_unknown_tier(tmp_path: Path):
    report = _write(tmp_path / "report.json", _report().model_dump_json())
    code = main(
        ["measure", "--stage", "before", "--tier", f"smoke={report}", "--wall-time", "other=1", "--gates", str(GATES_PATH),
         "--out", str(tmp_path / "m.json")]
    )
    assert code == 2


def test_measure_rejects_a_malformed_tier_argument(tmp_path: Path):
    code = main(["measure", "--stage", "after", "--tier", "smoke", "--gates", str(GATES_PATH), "--out", str(tmp_path / "m.json")])
    assert code == 2


def test_check_help_lists_mode(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["check", "--help"])
    assert exc.value.code == 0
    assert "--mode" in capsys.readouterr().out


def test_committed_gates_file_evaluates_a_passing_report():
    gates = QualityGates.model_validate_json(GATES_PATH.read_text(encoding="utf-8"))
    result = evaluate(_report(), gates, tier="smoke")
    assert result.passed and exit_code_for(result) == 0


def test_items_of_other_splits_are_not_counted():
    rows = _rows("en") + [{**_row(f"en-t-{i:03d}", "en", "general"), "split": "test"} for i in range(200)]
    result = evaluate(_report(items=rows), _gates(), tier="smoke")
    assert _composition(result, "en").items == 100


def test_items_marked_report_only_are_not_counted():
    rows = _rows("en") + [
        {**_row(f"en-r-{i:03d}", "en", "general"), "report_only_reason": "native_review_pending"} for i in range(200)
    ]
    report = _report(items=rows)
    assert all(isinstance(item, ItemResult) for item in report.items)
    assert _composition(evaluate(report, _gates(), tier="smoke"), "en").items == 100
