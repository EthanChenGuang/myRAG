import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import TraceCandidate
from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig

from rag_eval.calibrate.refusal import (
    FixtureScoreCalibration,
    fit_similarity_floor,
    run_refusal_calibration,
)
from rag_eval.golden_io import load_golden, write_golden
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
    written = FixtureScoreCalibration.model_validate_json(floor.read_text(encoding="utf-8"))
    assert written.source == "fixture"
    assert written.fixture_mode == "prechunked"
    assert list(written.score_calibration) == ["context_threshold"]
    assert written.score_calibration["context_threshold"] == pytest.approx((0.12 + 0.30) / 2)
    assert written.status == "calibrated"
    assert result.floor_written is True
    assert result.similarity_floor is not None and result.similarity_floor.status == "calibrated"
    report = (tmp_path / "out" / "report.md").read_text(encoding="utf-8")
    assert "## Fixture similarity floor" in report
    assert "dev split only" in report


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
