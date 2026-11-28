import json
import os
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import TraceCandidate
from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig

import rag_eval.calibrate.refusal as refusal_module
from rag_eval.calibrate.__main__ import main as cli_main
from rag_eval.calibrate.refusal import (
    CalibrationError,
    fit_similarity_floor,
    run_refusal_calibration,
)
from rag_eval.golden_io import golden_sha256, load_golden, write_golden
from rag_eval.harness_runner import HarnessRun
from test_calibrate_refusal import V2_RECOMMENDED, _calibration_trace, _empty_thresholds, _golden_item, _ids

CONFIG = RefusalCalibrationConfig()
DAY = "2026-11-25"

DEV_ANSWERABLE = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55]
DEV_NO_ANSWER = [0.10, 0.12, 0.33]
TEST_ANSWERABLE = [0.01, 0.02]
TEST_NO_ANSWER = [0.90]


def _similarity_trace(item_id: str, similarities: list[float | None], *, image: float | None = None):
    trace = _calibration_trace([(0.5, "zh")], item_id=item_id)
    candidates = [
        TraceCandidate(rank=i, chunk_id=f"c{i}", document_id=f"d{i}", content="t", similarity=s, has_image=False, rerank_score=0.5, language="zh")
        for i, s in enumerate(similarities, start=1)
        if s is not None
    ]
    if image is not None:
        candidates.append(
            TraceCandidate(rank=len(candidates) + 1, chunk_id="img", document_id="dimg", content="t", similarity=image, has_image=True, rerank_score=0.1, language="zh")
        )
    return trace.model_copy(update={"candidates": candidates})


def _world(tmp_path: Path):
    items, sims = [], {}
    for split, answerable, values, prefix in [
        ("dev", True, DEV_ANSWERABLE, "zh-fl-a"),
        ("dev", False, DEV_NO_ANSWER, "zh-fl-n"),
        ("test", True, TEST_ANSWERABLE, "zh-fl-ta"),
        ("test", False, TEST_NO_ANSWER, "zh-fl-tn"),
    ]:
        for item_id, value in zip(_ids(split, len(values), prefix), values):
            items.append(_golden_item(item_id, split, answerable))
            sims[item_id] = value
    path = tmp_path / "golden.jsonl"
    write_golden(path, items)
    return path, items, sims


class _FloorRunner:
    def __init__(self, sims):
        self.sims = sims

    def __call__(self, **kwargs):
        golden = load_golden(Path(kwargs["golden"]))
        traces = [_similarity_trace(item.id, [self.sims[item.id], self.sims[item.id] / 2]) for item in golden]
        return HarnessRun(
            out_dir=Path(kwargs["out"]),
            golden_path=Path(kwargs["golden"]),
            run_config_path=Path(kwargs["run_config"]),
            argv=[],
            traces=traces,
        )


def _run(tmp_path: Path, golden: Path, sims, **kwargs):
    kwargs.setdefault("thresholds_path", _empty_thresholds(tmp_path))
    kwargs.setdefault("floor_path", tmp_path / "fixture-score-calibration.json")
    return run_refusal_calibration(V2_RECOMMENDED, tmp_path / "out", golden=golden, runner=_FloorRunner(sims), now=DAY, **kwargs)


def test_floor_is_fitted_on_dev_only_at_the_target_from_the_best_dense_similarity(tmp_path):
    _, items, sims = _world(tmp_path)
    traces = [_similarity_trace(i.id, [sims[i.id], 0.05]) for i in items]
    fit = fit_similarity_floor(traces, items, CONFIG, environment="fixture")
    assert fit.status == "calibrated"
    assert fit.context_threshold == pytest.approx((0.12 + 0.30) / 2)
    assert (fit.dev.answerable_count, fit.dev.no_answer_count) == (6, 3)
    assert fit.dev.false_refusal_rate == 0.0
    assert fit.dev.correct_refusal_rate == pytest.approx(2 / 3)
    assert 0 < fit.dev.false_refusal_rate_upper_bound < 1
    assert fit.target_false_refusal == CONFIG.target_false_refusal


def test_floor_never_reads_a_test_split_score(tmp_path):
    _, items, sims = _world(tmp_path)
    poisoned = {**sims, **{i.id: (0.99 if i.answerable else 0.0) for i in items if i.split == "test"}}
    base = fit_similarity_floor([_similarity_trace(i.id, [sims[i.id]]) for i in items], items, CONFIG, environment="fixture")
    other = fit_similarity_floor([_similarity_trace(i.id, [poisoned[i.id]]) for i in items], items, CONFIG, environment="fixture")
    assert base == other


def test_an_image_chunk_above_the_image_floor_counts_as_answered(tmp_path):
    _, items, sims = _world(tmp_path)
    rescued = {i.id for i in items if i.split == "dev" and not i.answerable and sims[i.id] == 0.10}
    traces = [_similarity_trace(i.id, [sims[i.id]], image=0.3 if i.id in rescued else None) for i in items]
    fit = fit_similarity_floor(traces, items, CONFIG, environment="fixture")
    assert fit.dev.correct_refusal_rate == pytest.approx(1 / 3)


def test_items_without_a_dense_similarity_are_excluded_and_counted(tmp_path):
    _, items, sims = _world(tmp_path)
    blank = next(i.id for i in items if i.split == "dev" and i.answerable)
    traces = [_similarity_trace(i.id, [] if i.id == blank else [sims[i.id]]) for i in items]
    fit = fit_similarity_floor(traces, items, CONFIG, environment="fixture")
    assert fit.dev.answerable_count == 5
    assert fit.excluded_no_similarity == 1


def test_floor_below_the_dev_minimums_is_insufficient_data_without_a_threshold(tmp_path):
    _, items, sims = _world(tmp_path)
    few = [i for i in items if i.answerable or sims[i.id] != 0.10]
    few = [i for i in few if not (not i.answerable and sims[i.id] == 0.12)]
    fit = fit_similarity_floor([_similarity_trace(i.id, [sims[i.id]]) for i in few], few, CONFIG, environment="fixture")
    assert fit.status == "insufficient_data"
    assert fit.context_threshold is None


def test_write_records_a_fixture_score_calibration_file_with_only_the_context_threshold(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    result = _run(tmp_path, golden, sims, write=True, floor_path=floor)
    written = json.loads(floor.read_text(encoding="utf-8"))
    assert written["schema_version"] == 2 and written["source"] == "fixture"
    assert list(written["modes"]) == ["prechunked"]
    entry = written["modes"]["prechunked"]
    assert list(entry["score_calibration"]) == ["context_threshold"]
    assert entry["score_calibration"]["context_threshold"] == pytest.approx((0.12 + 0.30) / 2)
    assert entry["status"] == "calibrated"
    assert entry["golden_sha256"] == golden_sha256(golden)
    assert result.floor_written is True
    assert result.similarity_floor is not None and result.similarity_floor.status == "calibrated"
    report = (tmp_path / "out" / "report.md").read_text(encoding="utf-8")
    assert "## Fixture similarity floor" in report
    assert "dev split only" in report


OTHER_ENTRY = {
    "dev": None,
    "golden_sha256": "a" * 64,
    "score_calibration": {"context_threshold": 0.2345678901234567},
    "status": "calibrated",
    "target_false_refusal": 0.05,
}


def _seed_floor(path: Path, modes: dict) -> None:
    path.write_text(json.dumps({"modes": modes, "schema_version": 2, "source": "fixture"}, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def _entry_text(path: Path, mode: str) -> str:
    return json.dumps(json.loads(path.read_text(encoding="utf-8"))["modes"][mode], sort_keys=True, indent=2)


def test_write_floor_writes_only_its_mode_and_keeps_the_other_entry_byte_for_byte(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    _seed_floor(floor, {"ingest": OTHER_ENTRY})
    before = _entry_text(floor, "ingest")
    result = _run(tmp_path, golden, sims, write_floor=True, floor_path=floor, fixture_mode="prechunked")
    written = json.loads(floor.read_text(encoding="utf-8"))
    assert sorted(written["modes"]) == ["ingest", "prechunked"]
    assert _entry_text(floor, "ingest") == before
    assert '"context_threshold": 0.2345678901234567' in floor.read_text(encoding="utf-8")
    assert written["modes"]["prechunked"]["score_calibration"]["context_threshold"] == pytest.approx((0.12 + 0.30) / 2)
    assert result.floor_written is True and result.thresholds_written is False


def test_write_floor_never_opens_the_thresholds_file_for_writing(tmp_path):
    golden, _, sims = _world(tmp_path)
    thresholds = tmp_path / "thresholds-copy.json"
    thresholds.write_bytes(_empty_thresholds(tmp_path).read_bytes())
    os.utime(thresholds, ns=(1_000_000_000_000_000_000, 1_000_000_000_000_000_000))
    before = (thresholds.read_bytes(), thresholds.stat().st_mtime_ns)
    result = _run(tmp_path, golden, sims, write_floor=True, thresholds_path=thresholds, fixture_mode="ingest")
    assert (thresholds.read_bytes(), thresholds.stat().st_mtime_ns) == before
    assert result.thresholds_written is False and result.floor_written is True


def test_a_single_entry_file_is_read_as_its_mode_and_upgraded_on_the_next_write(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    old = {"fixture_mode": "prechunked", "schema_version": 1, "source": "fixture", **OTHER_ENTRY}
    floor.write_text(json.dumps(old, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    _run(tmp_path, golden, sims, write_floor=True, floor_path=floor, fixture_mode="ingest")
    written = json.loads(floor.read_text(encoding="utf-8"))
    assert written["schema_version"] == 2
    assert written["modes"]["prechunked"] == OTHER_ENTRY
    assert written["modes"]["ingest"]["status"] == "calibrated"


def test_write_thresholds_merges_the_floor_file_instead_of_replacing_it(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    thresholds = tmp_path / "thresholds-copy.json"
    thresholds.write_bytes(_empty_thresholds(tmp_path).read_bytes())
    _seed_floor(floor, {"ingest": OTHER_ENTRY})
    before = _entry_text(floor, "ingest")
    result = _run(tmp_path, golden, sims, write=True, floor_path=floor, thresholds_path=thresholds)
    assert result.thresholds_written is True
    assert _entry_text(floor, "ingest") == before
    assert "prechunked" in json.loads(floor.read_text(encoding="utf-8"))["modes"]


def test_write_floor_is_refused_for_a_live_run(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    with pytest.raises(CalibrationError):
        _run(tmp_path, golden, sims, write_floor=True, floor_path=floor, base_url="https://app.example.test")
    assert not floor.exists()


def test_cli_write_floor_reports_a_fit_that_is_not_calibrated(tmp_path, monkeypatch, capsys):
    golden, _, sims = _world(tmp_path)
    flat = {key: 0.5 for key in sims}
    monkeypatch.setattr(refusal_module, "_default_runner", _FloorRunner(flat))
    floor = tmp_path / "fixture-score-calibration.json"
    monkeypatch.setattr(refusal_module, "FLOOR_PATH", floor)
    thresholds = tmp_path / "thresholds-copy.json"
    thresholds.write_bytes(_empty_thresholds(tmp_path).read_bytes())
    monkeypatch.setattr(refusal_module, "THRESHOLDS_PATH", thresholds)
    before = thresholds.read_bytes()
    code = cli_main(
        ["refusal", "--run-config", str(V2_RECOMMENDED), "--out", str(tmp_path / "d"), "--golden", str(golden), "--fixture-mode", "ingest", "--write-floor"]
    )
    assert code == 0
    entry = json.loads(floor.read_text(encoding="utf-8"))["modes"]["ingest"]
    assert entry["status"] != "calibrated" and entry["score_calibration"] == {}
    out = capsys.readouterr().out
    assert "wrote the ingest fixture floor" in out
    assert "no threshold was written" in out
    assert thresholds.read_bytes() == before


def test_cli_write_floor_with_a_base_url_is_a_usage_error(tmp_path, monkeypatch):
    golden, _, sims = _world(tmp_path)
    monkeypatch.setattr(refusal_module, "_default_runner", _FloorRunner(sims))
    monkeypatch.setattr(refusal_module, "FLOOR_PATH", tmp_path / "fixture-score-calibration.json")
    code = cli_main(
        ["refusal", "--run-config", str(V2_RECOMMENDED), "--out", str(tmp_path / "d"), "--golden", str(golden), "--base-url", "https://app.example.test", "--write-floor"]
    )
    assert code == 2
    assert not (tmp_path / "fixture-score-calibration.json").exists()


def test_without_write_the_floor_file_is_left_alone(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    floor.write_text("{}\n", encoding="utf-8")
    result = _run(tmp_path, golden, sims, floor_path=floor)
    assert floor.read_text(encoding="utf-8") == "{}\n"
    assert result.floor_written is False


def test_a_live_run_never_writes_the_fixture_floor(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    result = _run(tmp_path, golden, sims, write=True, floor_path=floor, base_url="https://app.example.test")
    assert not floor.exists()
    assert result.floor_written is False


def test_rerun_with_unchanged_inputs_leaves_the_floor_file_byte_identical(tmp_path):
    golden, _, sims = _world(tmp_path)
    floor = tmp_path / "fixture-score-calibration.json"
    _run(tmp_path, golden, sims, write=True, floor_path=floor)
    first = floor.read_bytes()
    _run(tmp_path, golden, sims, write=True, floor_path=floor)
    assert floor.read_bytes() == first
    assert str(tmp_path) not in json.dumps(json.loads(first))


def test_calibration_runs_install_no_fixture_floor(tmp_path):
    golden, _, sims = _world(tmp_path)
    calls: list[dict] = []

    class _Recording(_FloorRunner):
        def __call__(self, **kwargs):
            calls.append(kwargs)
            return super().__call__(**kwargs)

    run_refusal_calibration(
        V2_RECOMMENDED,
        tmp_path / "out",
        golden=golden,
        runner=_Recording(sims),
        now=DAY,
        thresholds_path=_empty_thresholds(tmp_path),
        floor_path=tmp_path / "fixture-score-calibration.json",
    )
    assert [call.get("fixture_floor") for call in calls] == [False]


def test_run_harness_passes_no_fixture_floor_only_when_asked(tmp_path):
    from types import SimpleNamespace

    from rag_eval.harness_runner import HarnessError, run_harness

    golden, _, _ = _world(tmp_path)
    seen: list[list[str]] = []

    def spawner(argv, cwd):
        seen.append(list(argv))
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    config = tmp_path / "base.json"
    config.write_text(json.dumps({"name": "x", "env": {}}), encoding="utf-8")
    for floor in (True, False):
        with pytest.raises(HarnessError):
            run_harness(run_config=config, golden=golden, out=tmp_path / f"run-{floor}", spawner=spawner, fixture_floor=floor)
    assert ["--no-fixture-floor" in argv for argv in seen] == [False, True]
