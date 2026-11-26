"""Calibration status in the judge report (D-30): which judge rows count and why the others do not."""

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from judge_stubs import StubDeepEvalLLM, StubEmbeddings, StubRagasLLM
from rag_sidecar.contracts.judge_calibration import JudgeCalibration, JudgeCalibrationCell
from rag_sidecar.contracts.quality_gates import default_quality_gates
from rag_sidecar.contracts.retrieval import ConfigProvenance
from test_judge_offline import _cli_inputs, _run, _six

import rag_eval.judge.run as run_module
from rag_eval.judge.config import load_judge_config
from rag_eval.judge.run import LIBRARIES, METRICS, main, render_markdown
from rag_eval.judge_calibration import judge_fingerprint

TODAY = date(2026, 11, 26)
RUNNING = "a" * 64
OTHER = "b" * 64
LANGUAGES = ("en", "it", "zh")


def _cell(
    language: str,
    library: str,
    metric: str,
    *,
    fingerprint: str = RUNNING,
    recorded_at: str = "2026-11-20T00:00:00Z",
    status: str = "gating",
    reasons: tuple[str, ...] = (),
) -> JudgeCalibrationCell:
    return JudgeCalibrationCell(
        key=f"{fingerprint}|nightly|{language}|{library}.{metric}",
        fingerprint=fingerprint,
        role="nightly",
        language=language,
        library=library,
        metric=metric,
        status=status,
        reasons=list(reasons),
        kappa=0.8,
        accuracy=0.9,
        n=120,
        source="review_queue",
        labels_human_confirmed=True,
        recorded_at=recorded_at,
    )


def _calibration(*cells: JudgeCalibrationCell, running: str = RUNNING) -> JudgeCalibration:
    return JudgeCalibration(
        cells=list(cells), running_fingerprints={"nightly": running}, provenance=ConfigProvenance(source="calibration")
    )


def _status(calibration: JudgeCalibration, *, running: str | None = RUNNING) -> dict[tuple[str, str, str], Any]:
    rows = run_module.calibration_status(LANGUAGES, calibration, default_quality_gates(), running, TODAY)
    return {(row.language, row.library, row.metric): row for row in rows}


def test_only_the_gating_cell_is_enforced():
    rows = _status(_calibration(_cell("en", "deepeval", "faithfulness")))
    assert len(rows) == len(LANGUAGES) * len(LIBRARIES) * len(METRICS)
    assert rows[("en", "deepeval", "faithfulness")].status == "Enforced"
    for key, row in rows.items():
        if key == ("en", "deepeval", "faithfulness"):
            continue
        if key[2] == "context_recall":
            assert row.status == "Reported only"
            assert row.reasons == ("no_pass_threshold",)
        else:
            assert row.status == "Report only", key
            assert row.reasons == ("no_cell",)


def test_metric_without_a_pass_threshold_is_never_enforced():
    cell = _cell("en", "deepeval", "answer_relevance")
    gates = default_quality_gates()
    judge = gates.judge.model_copy(update={"pass_threshold": {"faithfulness": 0.8}})
    gates = gates.model_copy(update={"judge": judge})
    rows = run_module.calibration_status(("en",), _calibration(cell), gates, RUNNING, TODAY)
    row = next(row for row in rows if row.library == "deepeval" and row.metric == "answer_relevance")
    assert row.status == "Reported only"


def test_other_fingerprint_or_expired_cell_is_out_of_date():
    rows = _status(
        _calibration(
            _cell("en", "deepeval", "faithfulness", fingerprint=OTHER),
            _cell("it", "deepeval", "faithfulness", recorded_at="2026-09-01T00:00:00Z"),
        )
    )
    assert rows[("en", "deepeval", "faithfulness")].status == "Out of date"
    assert rows[("en", "deepeval", "faithfulness")].reasons == ("fingerprint_mismatch",)
    assert rows[("it", "deepeval", "faithfulness")].status == "Out of date"
    assert rows[("it", "deepeval", "faithfulness")].reasons == ("expired",)


def test_report_only_cell_carries_its_reasons():
    cell = _cell("zh", "ragas", "faithfulness", status="report_only", reasons=("kappa_below_floor", "n_below_minimum"))
    row = _status(_calibration(cell))[("zh", "ragas", "faithfulness")]
    assert row.status == "Report only"
    assert row.reasons == ("kappa_below_floor", "n_below_minimum")


def test_report_text_says_report_only_unless_calibrated():
    golden, traces = _six()
    report = _run(golden, traces)
    text = render_markdown(report)
    assert "report-only unless calibrated" in text
    assert "do not gate in Phase 1" not in text
    assert "No calibration file was given" in text
    rows = run_module.calibration_status(
        ("en",), _calibration(_cell("en", "deepeval", "faithfulness")), default_quality_gates(), RUNNING, TODAY
    )
    with_status = render_markdown(report, rows)
    assert "## Calibration status" in with_status
    assert "| en | deepeval | faithfulness | Enforced | - |" in with_status
    assert "| en | ragas | faithfulness | Report only | no_cell |" in with_status


@pytest.fixture
def stubbed_judge(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "placeholder-openrouter-key")
    monkeypatch.setenv("OPENAI_API_KEY", "placeholder-openai-key")
    original = run_module.run_judge

    def stub(traces, golden, _deepeval, _ragas, _embeddings, config, **kwargs):
        return original(traces, golden, StubDeepEvalLLM(), StubRagasLLM(), StubEmbeddings(), config, **kwargs)

    monkeypatch.setattr(run_module, "run_judge", stub)


def test_cli_without_calibration_behaves_as_today(tmp_path: Path, stubbed_judge, capsys):
    assert main(_cli_inputs(tmp_path)) == 0
    out = capsys.readouterr().out
    assert [line for line in out.splitlines() if "calibration" in line] == [
        "no calibration file was given; judge metrics are report-only"
    ]
    assert (tmp_path / "out" / "judge.json").is_file()
    assert "No calibration file was given" in (tmp_path / "out" / "judge.md").read_text(encoding="utf-8")


def test_cli_with_calibration_prints_the_status_table(tmp_path: Path, stubbed_judge, capsys):
    running = judge_fingerprint("nightly", load_judge_config())
    stamp = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    path = tmp_path / "judge-calibration.json"
    calibration = _calibration(_cell("en", "deepeval", "faithfulness", fingerprint=running, recorded_at=stamp))
    path.write_text(calibration.model_dump_json(indent=2), encoding="utf-8")
    assert main([*_cli_inputs(tmp_path), "--calibration", str(path)]) == 0
    out = capsys.readouterr().out
    assert "calibration en deepeval.faithfulness: Enforced" in out
    assert "calibration it deepeval.faithfulness: Report only (no_cell)" in out
    assert "calibration en ragas.context_recall: Reported only (no_pass_threshold)" in out
    report = (tmp_path / "out" / "judge.md").read_text(encoding="utf-8")
    assert "| en | deepeval | faithfulness | Enforced | - |" in report


def test_cli_with_an_invalid_calibration_file_exits_2(tmp_path: Path, stubbed_judge):
    path = tmp_path / "judge-calibration.json"
    path.write_text('{"cells": "nope"}', encoding="utf-8")
    assert main([*_cli_inputs(tmp_path), "--calibration", str(path)]) == 2
    assert not (tmp_path / "out").exists()


def test_cli_with_a_missing_gates_file_exits_2(tmp_path: Path, stubbed_judge):
    path = tmp_path / "judge-calibration.json"
    path.write_text(_calibration().model_dump_json(), encoding="utf-8")
    argv = [*_cli_inputs(tmp_path), "--calibration", str(path), "--gates", str(tmp_path / "missing.json")]
    assert main(argv) == 2
