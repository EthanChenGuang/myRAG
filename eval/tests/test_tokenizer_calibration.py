import json
import math
import shutil
import socket

import pytest
from rag_sidecar.contracts.prompt_budget import TokenizerCalibration, TokenizerFamilyFactor

from rag_eval.calibrate import __main__ as calibrate_cli
from rag_eval.calibrate import tokenizer as tk
from rag_eval.paths import REPO_ROOT

RUN_A = REPO_ROOT / "eval" / "tests" / "fixtures" / "tokenizer_runs" / "run-a"


def _nearest_rank(values, q):
    ordered = sorted(values)
    return ordered[max(1, math.ceil(q * len(ordered))) - 1]


def _f1_ratios():
    ratios = []
    for line in (RUN_A / "traces.jsonl").read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        budget, usage = row.get("prompt_budget"), row.get("usage")
        if budget and usage and budget["estimator"]["family"] == "f1":
            ratios.append(usage["input_tokens"] / budget["estimated_raw_total"])
    return ratios


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("the tokenizer calibration must not open a network connection")

    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket.socket, "connect", refuse)


def test_load_samples_pairs_estimate_with_reported_usage_and_counts_skips():
    samples, skipped = tk.load_samples([RUN_A])
    assert len(samples) == 30
    assert {s.family for s in samples} == {"f1", "f2"}
    assert all(s.run_id == "run-a" for s in samples)
    assert skipped == {"no_prompt_budget": 1, "no_usage": 1}


def test_fit_factors_takes_the_quantile_and_respects_the_sample_minimum():
    samples, _ = tk.load_samples([RUN_A])
    fitted, under = tk.fit_factors(samples, quantile=0.95, min_samples=20, computed_at="2026-11-27T00:00:00Z")
    assert [cell.family for cell in fitted] == ["f1"]
    cell = fitted[0]
    ratios = _f1_ratios()
    assert len(ratios) == 25 and min(ratios) >= 1.10 and max(ratios) <= 1.30
    assert cell.factor == pytest.approx(math.ceil(_nearest_rank(ratios, 0.95) * 10_000) / 10_000)
    assert cell.factor >= _nearest_rank(ratios, 0.95)
    assert cell.source == "measured"
    assert cell.samples == 25
    assert cell.quantile == 0.95
    assert cell.run_ids == ["run-a"]
    assert cell.computed_at == "2026-11-27T00:00:00Z"
    assert under == {"f2": 5}


def test_run_writes_a_valid_file_and_keeps_unmeasured_families(tmp_path):
    out = tmp_path / "tokenizer-calibration.json"
    kept = TokenizerFamilyFactor(
        family="f3", factor=1.07, quantile=0.95, samples=40, source="measured", run_ids=["run-old"],
        computed_at="2026-10-01T00:00:00Z",
    )
    old_f2 = TokenizerFamilyFactor(family="f2", factor=1.25, quantile=0.95, samples=0, source="default")
    existing = TokenizerCalibration(version=1, default_factor=1.3, families=[kept, old_f2], written_by="default")
    out.write_text(existing.model_dump_json(), encoding="utf-8")

    result = tk.run_tokenizer_calibration([RUN_A], out)

    assert result.written is True
    written = TokenizerCalibration.model_validate_json(out.read_text(encoding="utf-8"))
    assert written.written_by == "rag_eval.calibrate tokenizer"
    assert written.default_factor == 1.3
    by_family = {cell.family: cell for cell in written.families}
    assert by_family["f3"] == kept
    assert by_family["f2"] == old_f2
    assert by_family["f1"].source == "measured" and by_family["f1"].samples == 25
    assert by_family["f1"].computed_at
    assert [cell.family for cell in written.families] == sorted(by_family)
    assert result.skipped == {"no_prompt_budget": 1, "no_usage": 1}
    assert result.under_sampled == {"f2": 5}


def test_run_without_an_existing_file_uses_the_default_factor(tmp_path):
    out = tmp_path / "nested" / "tokenizer-calibration.json"
    tk.run_tokenizer_calibration([RUN_A], out)
    written = TokenizerCalibration.model_validate_json(out.read_text(encoding="utf-8"))
    assert written.default_factor == tk.DEFAULT_FACTOR == 1.25
    assert written.version == 1
    assert [cell.family for cell in written.families] == ["f1"]


def test_under_sampled_family_never_becomes_measured(tmp_path):
    out = tmp_path / "cal.json"
    tk.run_tokenizer_calibration([RUN_A], out, min_samples=26)
    written = TokenizerCalibration.model_validate_json(out.read_text(encoding="utf-8"))
    assert written.families == []


def test_two_runs_pool_samples_and_record_both_run_ids(tmp_path):
    run_b = tmp_path / "run-b"
    shutil.copytree(RUN_A, run_b)
    (run_b / "manifest.json").write_text(json.dumps({"run_id": "run-b-0001"}), encoding="utf-8")
    out = tmp_path / "cal.json"
    result = tk.run_tokenizer_calibration([RUN_A, run_b], out, min_samples=10)
    cells = {cell.family: cell for cell in result.calibration.families}
    assert cells["f1"].samples == 50 and cells["f1"].run_ids == ["run-a", "run-b-0001"]
    assert cells["f2"].samples == 10 and cells["f2"].source == "measured"


def test_dry_run_writes_nothing(tmp_path):
    out = tmp_path / "cal.json"
    result = tk.run_tokenizer_calibration([RUN_A], out, write=False)
    assert result.written is False
    assert not out.exists()
    assert [cell.family for cell in result.calibration.families] == ["f1"]


def test_missing_traces_file_is_an_error(tmp_path):
    with pytest.raises(tk.CalibrationError):
        tk.run_tokenizer_calibration([tmp_path / "absent"], tmp_path / "cal.json")


def test_invalid_existing_file_is_not_overwritten(tmp_path):
    out = tmp_path / "cal.json"
    out.write_text('{"version": 1, "default_factor": 0.2, "written_by": "hand"}', encoding="utf-8")
    with pytest.raises(tk.CalibrationError):
        tk.run_tokenizer_calibration([RUN_A], out)
    assert json.loads(out.read_text(encoding="utf-8"))["written_by"] == "hand"


def test_bad_quantile_or_minimum_is_an_error(tmp_path):
    with pytest.raises(tk.CalibrationError):
        tk.run_tokenizer_calibration([RUN_A], tmp_path / "cal.json", quantile=1.5)
    with pytest.raises(tk.CalibrationError):
        tk.run_tokenizer_calibration([RUN_A], tmp_path / "cal.json", min_samples=0)


def test_cli_writes_into_a_temporary_path(tmp_path, capsys):
    out = tmp_path / "cal.json"
    code = calibrate_cli.main(["tokenizer", "--runs", str(RUN_A), "--out", str(out), "--min-samples", "5"])
    assert code == calibrate_cli.EXIT_OK
    written = TokenizerCalibration.model_validate_json(out.read_text(encoding="utf-8"))
    assert sorted(cell.family for cell in written.families) == ["f1", "f2"]
    assert "tokenizer calibration" in capsys.readouterr().out


def test_cli_dry_run_prints_cells_and_writes_nothing(tmp_path, capsys):
    out = tmp_path / "cal.json"
    code = calibrate_cli.main(["tokenizer", "--runs", str(RUN_A), "--out", str(out), "--dry-run"])
    assert code == calibrate_cli.EXIT_OK
    assert not out.exists()
    printed = capsys.readouterr().out
    assert '"family": "f1"' in printed
    assert "dry run" in printed


def test_cli_reports_a_usage_error(tmp_path, capsys):
    code = calibrate_cli.main(["tokenizer", "--runs", str(tmp_path / "absent"), "--out", str(tmp_path / "cal.json")])
    assert code == calibrate_cli.EXIT_USAGE
    assert "error:" in capsys.readouterr().err
