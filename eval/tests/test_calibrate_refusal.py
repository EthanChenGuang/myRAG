import math
import random

import pytest
from rag_sidecar.contracts.eval_run import RagTrace, TraceCandidate, TraceRefusal, TraceRetrievalVersions
from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig

from rag_eval.calibrate.refusal import (
    Assignment,
    CalibrationRow,
    Exclusion,
    RerankerIdentity,
    assign_cell,
    fit_cells,
    fit_threshold,
)
from test_report_runner import _trace

RERANKER = RerankerIdentity("cohere", "fake-quality-v1")
HASH = "a" * 64
CONFIG = RefusalCalibrationConfig()


def _candidate(rank: int, score: float | None, language: str | None) -> TraceCandidate:
    return TraceCandidate(
        rank=rank,
        chunk_id=f"c{rank}",
        document_id=f"d{rank}",
        content="text",
        similarity=0.4,
        has_image=False,
        rerank_score=score,
        language=language,
    )


def _calibration_trace(
    scores: list[tuple[float | None, str | None]],
    *,
    query_language: str | None = "zh",
    versions: tuple[int, int] | None = (3, 2),
    config_hash: str | None = HASH,
    item_id: str = "zh-general-001",
    refusal: TraceRefusal | None = None,
) -> RagTrace:
    base = _trace(item_id, [])
    return base.model_copy(
        update={
            "candidates": [_candidate(i, score, lang) for i, (score, lang) in enumerate(scores, start=1)],
            "query_language": query_language,
            "retrieval_versions": TraceRetrievalVersions(lexical=versions[0], rerank_text=versions[1]) if versions else None,
            "retrieval_config_hash": config_hash,
            "refusal": refusal,
        }
    )


def _row(item_id: str, split: str, answerable: bool, score: float, *, language: str = "zh", pairing: str = "same") -> CalibrationRow:
    return CalibrationRow(
        item_id=item_id,
        split=split,
        answerable=answerable,
        score=score,
        key=f"cohere|fake-quality-v1|{language}|{pairing}",
        provider="cohere",
        model="fake-quality-v1",
        query_language=language,
        pairing=pairing,
        tokenizer_version=3,
        rerank_text_version=2,
        config_hash=HASH,
    )


def _dev_rows(answerable: list[float], no_answer: list[float], *, language: str = "zh") -> list[CalibrationRow]:
    rows = [_row(f"dev-a-{i}", "dev", True, s, language=language) for i, s in enumerate(answerable)]
    rows += [_row(f"dev-n-{i}", "dev", False, s, language=language) for i, s in enumerate(no_answer)]
    return rows


def test_assign_cell_cross_when_top_candidate_language_differs_from_the_query():
    trace = _calibration_trace([(0.8, "it"), (0.4, "zh")], query_language="zh")
    result = assign_cell(trace, RERANKER)
    assert isinstance(result, Assignment)
    assert (result.provider, result.model, result.query_language, result.pairing) == ("cohere", "fake-quality-v1", "zh", "cross")
    assert result.key == "cohere|fake-quality-v1|zh|cross"
    assert result.top_score == 0.8


def test_assign_cell_same_when_top_candidate_language_matches():
    result = assign_cell(_calibration_trace([(0.8, "zh")], query_language="zh"), RERANKER)
    assert isinstance(result, Assignment)
    assert result.pairing == "same"


def test_assign_cell_null_candidate_language_counts_as_same():
    result = assign_cell(_calibration_trace([(0.8, None)], query_language="en"), RERANKER)
    assert isinstance(result, Assignment)
    assert (result.query_language, result.pairing) == ("en", "same")


def test_assign_cell_top_candidate_is_the_highest_rerank_score_not_the_first_listed():
    result = assign_cell(_calibration_trace([(0.2, "zh"), (0.9, "it"), (0.5, "zh")], query_language="zh"), RERANKER)
    assert isinstance(result, Assignment)
    assert result.top_score == 0.9
    assert result.pairing == "cross"


@pytest.mark.parametrize(
    "scores",
    [
        [],
        [(None, "zh"), (None, "zh")],
        [(math.nan, "zh")],
    ],
)
def test_assign_cell_excludes_a_trace_without_a_usable_rerank_score(scores):
    result = assign_cell(_calibration_trace(scores), RERANKER)
    assert result == Exclusion("no_rerank_score")


def test_assign_cell_a_missing_score_is_never_treated_as_low():
    result = assign_cell(_calibration_trace([(None, "zh"), (0.3, "zh")]), RERANKER)
    assert isinstance(result, Assignment)
    assert result.top_score == 0.3


def test_assign_cell_excludes_unknown_or_missing_query_language():
    assert assign_cell(_calibration_trace([(0.5, "zh")], query_language=None), RERANKER) == Exclusion("no_query_language")
    assert assign_cell(_calibration_trace([(0.5, "zh")], query_language="fr"), RERANKER) == Exclusion("no_query_language")


def test_fit_threshold_separable_scores_give_the_midpoint():
    fit = fit_threshold([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5], 0.05)
    assert fit.threshold == pytest.approx(0.525)
    assert fit.false_refusal == 0.0
    assert fit.correct_refusal == 1.0


def test_fit_threshold_returns_never_refuse_when_no_threshold_refuses_anything_safely():
    fit = fit_threshold([0.2, 0.3, 0.4], [0.8, 0.9], 0.05)
    assert fit.threshold == -math.inf
    assert fit.false_refusal == 0.0
    assert fit.correct_refusal == 0.0


def test_fit_threshold_respects_the_false_refusal_target():
    answerable = [0.1] + [0.5 + 0.02 * i for i in range(19)]
    no_answer = [0.05, 0.3, 0.6]
    strict = fit_threshold(answerable, no_answer, 0.0)
    assert strict.false_refusal == 0.0
    assert strict.threshold < 0.1
    relaxed = fit_threshold(answerable, no_answer, 0.05)
    assert relaxed.false_refusal == pytest.approx(0.05)
    assert relaxed.correct_refusal == pytest.approx(2 / 3)


def test_fit_threshold_picks_the_lowest_threshold_among_equal_correct_refusal():
    fit = fit_threshold([0.9, 0.8, 0.7], [0.1, 0.2], 0.34)
    assert fit.threshold == pytest.approx(0.45)
    assert fit.correct_refusal == 1.0


def test_fit_threshold_rejects_empty_inputs():
    with pytest.raises(ValueError):
        fit_threshold([], [0.1], 0.05)
    with pytest.raises(ValueError):
        fit_threshold([0.1], [], 0.05)


def test_fit_cells_fits_each_cell_on_dev_rows():
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5])
    fits = fit_cells(rows, CONFIG, environment="fixture")
    assert list(fits) == ["cohere|fake-quality-v1|zh|same"]
    fit = fits["cohere|fake-quality-v1|zh|same"]
    assert fit.status == "fitted"
    assert fit.threshold == pytest.approx(0.525)
    assert fit.dev.answerable_count == 5
    assert fit.dev.no_answer_count == 3
    assert fit.dev.false_refusal_rate == 0.0
    assert fit.dev.correct_refusal_rate == 1.0
    assert (fit.tokenizer_version, fit.rerank_text_version, fit.config_hash) == (3, 2, HASH)


def test_fit_cells_cell_under_the_dev_minimums_is_insufficient_data_without_a_threshold():
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3])
    fit = fit_cells(rows, CONFIG, environment="fixture")["cohere|fake-quality-v1|zh|same"]
    assert fit.status == "insufficient_data"
    assert fit.threshold is None
    assert fit.dev.no_answer_count == 2


def test_fit_cells_live_minimums_are_larger_than_fixture_minimums():
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5])
    fit = fit_cells(rows, CONFIG, environment="live")["cohere|fake-quality-v1|zh|same"]
    assert fit.status == "insufficient_data"


def test_fit_cells_never_refuse_fit_is_recorded_without_a_threshold():
    rows = _dev_rows([0.2, 0.3, 0.4, 0.45, 0.5], [0.8, 0.9, 0.95])
    fit = fit_cells(rows, CONFIG, environment="fixture")["cohere|fake-quality-v1|zh|same"]
    assert fit.status == "no_separation"
    assert fit.threshold is None
    assert fit.dev.correct_refusal_rate == 0.0


def test_fit_cells_keeps_cells_apart():
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5], language="zh")
    rows += _dev_rows([0.95, 0.85, 0.75, 0.65, 0.35], [0.1, 0.15, 0.25], language="en")
    fits = fit_cells(rows, CONFIG, environment="fixture")
    assert sorted(fits) == ["cohere|fake-quality-v1|en|same", "cohere|fake-quality-v1|zh|same"]
    assert fits["cohere|fake-quality-v1|en|same"].threshold == pytest.approx(0.3)


def test_fit_cells_dev_false_refusal_carries_the_clopper_pearson_bound():
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5])
    dev = fit_cells(rows, CONFIG, environment="fixture")["cohere|fake-quality-v1|zh|same"].dev
    assert dev.false_refusal_rate_upper_bound == pytest.approx(1 - 0.05 ** (1 / 5), abs=1e-6)


def test_fit_cells_ignores_test_rows_even_when_they_are_extreme():
    dev = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5])
    test = [_row(f"test-a-{i}", "test", True, 0.4 + 0.05 * i) for i in range(6)]
    test += [_row(f"test-n-{i}", "test", False, 0.3 + 0.1 * i) for i in range(3)]
    baseline = fit_cells(dev, CONFIG, environment="fixture")

    for poison in (0.0, 1.0, -5.0, 1e9):
        poisoned = [
            CalibrationRow(**{**row.__dict__, "score": poison}) if row.split == "test" else row for row in dev + test
        ]
        fits = fit_cells(poisoned, CONFIG, environment="fixture")
        assert {k: (v.threshold, v.dev, v.status) for k, v in fits.items()} == {
            k: (v.threshold, v.dev, v.status) for k, v in baseline.items()
        }
    assert fit_cells(dev + test, CONFIG, environment="fixture").keys() == baseline.keys()


def test_fit_cells_a_cell_with_only_test_rows_does_not_exist_in_the_fit():
    test_only = [_row(f"test-a-{i}", "test", True, 0.9, language="it") for i in range(6)]
    assert fit_cells(test_only, CONFIG, environment="fixture") == {}


def test_fit_cells_is_independent_of_row_order():
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5])
    shuffled = list(rows)
    random.Random(7).shuffle(shuffled)
    assert fit_cells(shuffled, CONFIG, environment="fixture") == fit_cells(rows, CONFIG, environment="fixture")


# ---------------------------------------------------------------------------
# Task 3: collect_rows, run config, runner, thresholds file, report, CLI
# ---------------------------------------------------------------------------

import json
from pathlib import Path
from types import SimpleNamespace

from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.retrieval import RefusalThresholds

import rag_eval.calibrate.refusal as refusal_module
from rag_eval.bounds import upper_bound
from rag_eval.calibrate.__main__ import main as cli_main
from rag_eval.calibrate.refusal import (
    CalibrationError,
    calibrate_cells,
    calibration_run_config,
    collect_rows,
    compare_cross_same,
    merge_thresholds,
    render_report,
    reranker_identity,
    run_refusal_calibration,
)
from rag_eval.config_files import finalize_config, write_config_atomically
from rag_eval.golden_io import load_golden, write_golden
from rag_eval.harness_runner import HarnessError, HarnessRun, run_harness
from rag_eval.split import assign_split
from test_report_runner import _item

REPO = Path(__file__).resolve().parents[2]
V2_RECOMMENDED = REPO / "eval" / "config" / "runs" / "v2-recommended.json"
COMMITTED_THRESHOLDS = REPO / "eval" / "config" / "refusal-thresholds.json"
KEY_ZH_SAME = "cohere|fake-quality-v1|zh|same"
DAY = "2026-11-24"


def _ids(split: str, count: int, prefix: str) -> list[str]:
    found: list[str] = []
    n = 0
    while len(found) < count:
        candidate = f"{prefix}-{n:03d}"
        if assign_split(candidate) == split:
            found.append(candidate)
        n += 1
    return found


def _golden_item(item_id: str, split: str, answerable: bool, language: str = "zh") -> GoldenItem:
    return _item(item_id, language, answerable=answerable).model_copy(update={"split": split})


DEV_ANSWERABLE = [0.9, 0.8, 0.7, 0.6, 0.55, 0.95]
DEV_NO_ANSWER = [0.2, 0.3, 0.5]
TEST_ANSWERABLE = [0.9, 0.8, 0.7, 0.3]
TEST_NO_ANSWER = [0.1, 0.4]


def _world(tmp_path: Path):
    """A golden file plus the score every item will get from the stub runner."""
    items: list[GoldenItem] = []
    scores: dict[str, tuple[float | None, str | None]] = {}
    layout = [
        ("dev", True, DEV_ANSWERABLE, "zh-dev-a"),
        ("dev", False, DEV_NO_ANSWER, "zh-dev-n"),
        ("test", True, TEST_ANSWERABLE, "zh-test-a"),
        ("test", False, TEST_NO_ANSWER, "zh-test-n"),
    ]
    for split, answerable, values, prefix in layout:
        for item_id, score in zip(_ids(split, len(values), prefix), values):
            items.append(_golden_item(item_id, split, answerable))
            scores[item_id] = (score, "zh")
    path = tmp_path / "golden.jsonl"
    write_golden(path, items)
    return path, items, scores


class _Runner:
    def __init__(self, scores, *, refusal: TraceRefusal | None = None, query_language: str | None = "zh", versions=(3, 2)):
        self.scores = scores
        self.refusal = refusal
        self.query_language = query_language
        self.versions = versions
        self.calls: list[dict] = []
        self.config_seen: list[dict] = []
        self.golden_ids_seen: list[list[str]] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        self.config_seen.append(json.loads(Path(kwargs["run_config"]).read_text(encoding="utf-8")))
        golden = load_golden(Path(kwargs["golden"]))
        self.golden_ids_seen.append([g.id for g in golden])
        traces = []
        for item in golden:
            score, lang = self.scores.get(item.id, (None, None))
            traces.append(
                _calibration_trace(
                    [] if score is None else [(score, lang)],
                    query_language=self.query_language,
                    versions=self.versions,
                    item_id=item.id,
                    refusal=self.refusal,
                )
            )
        return HarnessRun(
            out_dir=Path(kwargs["out"]),
            golden_path=Path(kwargs["golden"]),
            run_config_path=Path(kwargs["run_config"]),
            argv=[],
            traces=traces,
        )


def _calibrate(tmp_path: Path, runner, golden: Path, **kwargs):
    return run_refusal_calibration(
        V2_RECOMMENDED, tmp_path / "out", golden=golden, runner=runner, now=DAY, **kwargs
    )


def test_reranker_identity_reads_provider_from_env_and_model_from_the_overrides():
    base = json.loads(V2_RECOMMENDED.read_text(encoding="utf-8"))
    assert reranker_identity(base) == RerankerIdentity("cohere", "fake-quality-v1")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c: c["env"].pop("RAG_RERANKER"),
        lambda c: c["env"].update({"RAG_RERANKER": "none"}),
        lambda c: c.pop("overrides"),
    ],
)
def test_reranker_identity_needs_a_reranker_that_is_on_and_a_named_model(mutate):
    base = json.loads(V2_RECOMMENDED.read_text(encoding="utf-8"))
    mutate(base)
    with pytest.raises(CalibrationError):
        reranker_identity(base)


def test_calibration_run_config_forces_refusal_off_and_keeps_the_reranker_on():
    base = json.loads(V2_RECOMMENDED.read_text(encoding="utf-8"))
    assert base["env"]["RAG_REFUSAL_THRESHOLD"] == "true"
    forced = calibration_run_config(base)
    assert forced["env"]["RAG_REFUSAL_THRESHOLD"] == "false"
    assert forced["env"]["RAG_RERANKER"] == "cohere"
    assert forced["overrides"] == base["overrides"]
    assert base["env"]["RAG_REFUSAL_THRESHOLD"] == "true"


def test_collect_rows_builds_rows_and_counts_exclusions_by_reason(tmp_path):
    _, items, scores = _world(tmp_path)
    traces = [
        _calibration_trace([scores[i.id]] if scores[i.id][0] is not None else [], item_id=i.id) for i in items
    ]
    missing = items[0].id
    traces[0] = _calibration_trace([], item_id=missing)
    traces.append(_calibration_trace([(0.5, "zh")], item_id="unknown-item-000"))
    traces[1] = _calibration_trace([(0.5, "zh")], item_id=items[1].id, versions=None)
    rows, excluded = collect_rows(traces, items, RERANKER)
    assert excluded == {"no_rerank_score": 1, "unknown_item": 1, "no_retrieval_versions": 1}
    assert len(rows) == len(items) - 2
    by_id = {r.item_id: r for r in rows}
    sample = next(r for r in rows if r.split == "test" and not r.answerable)
    assert (sample.key, sample.tokenizer_version, sample.rerank_text_version, sample.config_hash) == (KEY_ZH_SAME, 3, 2, HASH)
    assert by_id[items[2].id].answerable is True


def test_collect_rows_drops_items_whose_split_field_disagrees_with_the_rule():
    dev_id = _ids("dev", 1, "zh-split")[0]
    liar = _golden_item(dev_id, "test", True)
    rows, excluded = collect_rows([_calibration_trace([(0.5, "zh")], item_id=dev_id)], [liar], RERANKER)
    assert rows == []
    assert excluded == {"split_mismatch": 1}


def test_run_writes_result_and_report_and_leaves_the_committed_thresholds_alone(tmp_path):
    golden, _, scores = _world(tmp_path)
    before = COMMITTED_THRESHOLDS.read_bytes()
    runner = _Runner(scores)
    result = _calibrate(tmp_path, runner, golden)
    out = tmp_path / "out"
    assert (out / "refusal-calibration-result.json").is_file()
    assert (out / "report.md").is_file()
    assert COMMITTED_THRESHOLDS.read_bytes() == before
    assert result.thresholds_written is False
    (record,) = result.cells
    assert record.cell.key == KEY_ZH_SAME
    assert record.cell.status == "calibrated"
    assert record.cell.source == "fixture"
    assert record.cell.holdout_evaluations == 1
    on_disk = json.loads((out / "refusal-calibration-result.json").read_text(encoding="utf-8"))
    assert on_disk["dev_only_fit"] is True
    assert on_disk["cells"][0]["cell"]["threshold"] == pytest.approx(0.525)


def test_run_hands_the_harness_a_refusal_off_run_config_and_both_splits(tmp_path):
    golden, items, scores = _world(tmp_path)
    runner = _Runner(scores)
    _calibrate(tmp_path, runner, golden)
    (call,) = runner.calls
    (config,) = runner.config_seen
    assert config["env"]["RAG_REFUSAL_THRESHOLD"] == "false"
    assert config["env"]["RAG_RERANKER"] == "cohere"
    assert config["overrides"]["rerank_model"] == "fake-quality-v1"
    assert sorted(runner.golden_ids_seen[0]) == sorted(i.id for i in items)
    assert call["base_url"] is None
    assert Path(call["out"]) == tmp_path / "out" / "harness"


def test_run_with_a_base_url_labels_the_cells_live(tmp_path):
    golden, _, scores = _world(tmp_path)
    runner = _Runner(scores)
    result = _calibrate(tmp_path, runner, golden, base_url="https://app.example.test")
    assert runner.calls[0]["base_url"] == "https://app.example.test"
    assert result.source == "live"
    assert {r.cell.source for r in result.cells} == {"live"}


def test_run_refuses_traces_that_were_produced_with_refusal_on(tmp_path):
    golden, _, scores = _world(tmp_path)
    refused = TraceRefusal(decision="refuse", basis="rerank_threshold", reason="below_threshold", top_score=0.1, threshold=0.5, cell_key=KEY_ZH_SAME)
    with pytest.raises(CalibrationError, match="refusal"):
        _calibrate(tmp_path, _Runner(scores, refusal=refused), golden)


def test_run_refuses_traces_where_the_threshold_gate_answered(tmp_path):
    golden, _, scores = _world(tmp_path)
    answered = TraceRefusal(decision="answer", basis="none", reason="above_threshold", top_score=0.9, threshold=0.5, cell_key=KEY_ZH_SAME)
    with pytest.raises(CalibrationError, match="refusal"):
        _calibrate(tmp_path, _Runner(scores, refusal=answered), golden)


@pytest.mark.parametrize(
    "floor",
    [
        TraceRefusal(decision="refuse", basis="similarity_floor", reason="below_similarity_floor", top_score=0.3, threshold=0.65, cell_key=None),
        TraceRefusal(decision="answer", basis="none", reason="above_similarity_floor", top_score=0.7, threshold=0.65, cell_key=None),
    ],
)
def test_run_accepts_traces_decided_by_the_fallback_similarity_floor(tmp_path, floor):
    golden, _, scores = _world(tmp_path)
    result = _calibrate(tmp_path, _Runner(scores, refusal=floor), golden)
    assert [r.cell.status for r in result.cells] == ["calibrated"]


def test_run_accepts_traces_where_the_gate_recorded_not_applied(tmp_path):
    golden, _, scores = _world(tmp_path)
    off = TraceRefusal(decision="not_applied", basis="none", reason="switch_off", top_score=None, threshold=None, cell_key=None)
    assert _calibrate(tmp_path, _Runner(scores, refusal=off), golden).cells


def test_run_counts_excluded_traces_without_scores(tmp_path):
    golden, items, scores = _world(tmp_path)
    scores = {**scores, items[0].id: (None, None)}
    result = _calibrate(tmp_path, _Runner(scores), golden)
    assert result.excluded == {"no_rerank_score": 1}


def test_run_twice_with_unchanged_inputs_is_a_byte_identical_no_op(tmp_path):
    golden, _, scores = _world(tmp_path)
    out = tmp_path / "out"
    _calibrate(tmp_path, _Runner(scores), golden)
    first = {n: (out / n).read_bytes() for n in ("refusal-calibration-result.json", "report.md")}
    again = run_refusal_calibration(V2_RECOMMENDED, out, golden=golden, runner=_Runner(scores), now="2027-02-02")
    second = {n: (out / n).read_bytes() for n in ("refusal-calibration-result.json", "report.md")}
    assert first == second
    assert again.cells[0].cell.holdout_evaluations == 1


def _existing_thresholds(tmp_path: Path) -> Path:
    rows = _dev_rows(DEV_ANSWERABLE, DEV_NO_ANSWER) + [
        _row(f"t{i}", "test", a, s) for i, (a, s) in enumerate([(True, 0.9), (True, 0.8), (False, 0.1)])
    ]
    (base,) = calibrate_cells(rows, CONFIG, source="fixture", noise_floor=0.02, now="2026-01-01")
    cells = [
        base.cell.model_copy(update={"threshold": 0.11}),
        base.cell.model_copy(update={"key": "cohere|fake-quality-v1|en|same", "query_language": "en"}),
        base.cell.model_copy(update={"key": "cohere|fake-quality-v1|it|same", "query_language": "it", "tokenizer_version": 1}),
    ]
    path = tmp_path / "thresholds.json"
    write_config_atomically(path, finalize_config(RefusalThresholds(cells=cells), provenance_source="calibration"))
    return path


def test_write_thresholds_merges_replaces_same_keys_and_drops_stale_cells(tmp_path):
    golden, _, scores = _world(tmp_path)
    target = _existing_thresholds(tmp_path)
    result = _calibrate(tmp_path, _Runner(scores), golden, write=True, thresholds_path=target)
    written = RefusalThresholds.model_validate_json(target.read_text(encoding="utf-8"))
    by_key = {c.key: c for c in written.cells}
    assert sorted(by_key) == ["cohere|fake-quality-v1|en|same", KEY_ZH_SAME]
    assert by_key[KEY_ZH_SAME].threshold == pytest.approx(0.525)
    assert by_key[KEY_ZH_SAME].source == "fixture"
    assert by_key["cohere|fake-quality-v1|en|same"].tokenizer_version == 3
    assert written.provenance.source == "calibration"
    assert written.config_hash is not None
    assert result.thresholds_written is True
    assert result.stale_cells == ["cohere|fake-quality-v1|it|same"]


def test_stale_cells_are_marked_in_the_report_even_without_write(tmp_path):
    golden, _, scores = _world(tmp_path)
    target = _existing_thresholds(tmp_path)
    before = target.read_bytes()
    result = _calibrate(tmp_path, _Runner(scores), golden, thresholds_path=target)
    assert target.read_bytes() == before
    report = (tmp_path / "out" / "report.md").read_text(encoding="utf-8")
    assert "stale" in report.lower()
    assert "cohere|fake-quality-v1|it|same" in report
    assert result.stale_cells == ["cohere|fake-quality-v1|it|same"]


def test_holdout_evaluations_continue_from_an_existing_thresholds_cell(tmp_path):
    golden, _, scores = _world(tmp_path)
    target = _existing_thresholds(tmp_path)
    result = _calibrate(tmp_path, _Runner(scores), golden, write=True, thresholds_path=target)
    assert result.cells[0].cell.holdout_evaluations == 2


def test_merge_thresholds_validates_the_result():
    rows = _dev_rows(DEV_ANSWERABLE, DEV_NO_ANSWER) + [_row("t0", "test", True, 0.9), _row("t1", "test", True, 0.8), _row("t2", "test", False, 0.1)]
    records = calibrate_cells(rows, CONFIG, source="live", noise_floor=0.02, now=DAY)
    merged = merge_thresholds(RefusalThresholds(cells=[]), [r.cell for r in records], tokenizer_version=3, rerank_text_version=2)
    assert [c.key for c in merged.cells] == [KEY_ZH_SAME]
    assert merged.config_hash is not None
    RefusalThresholds.model_validate(merged.model_dump(mode="json"))


def _cross_rows(rows):
    return [
        CalibrationRow(**{**r.__dict__, "key": "cohere|fake-quality-v1|zh|cross", "pairing": "cross"}) for r in rows
    ]


def _same_and_cross_records(same_test: list[float], cross_test: list[float]):
    def block(test_answerable: list[float]):
        dev = _dev_rows(DEV_ANSWERABLE, DEV_NO_ANSWER)
        test = [_row(f"t-a-{i}", "test", True, s) for i, s in enumerate(test_answerable)] + [_row("t-n-0", "test", False, 0.1)]
        return dev + test

    rows = block(same_test) + _cross_rows(block(cross_test))
    return calibrate_cells(rows, CONFIG, source="fixture", noise_floor=0.02, now=DAY)


def test_compare_cross_same_flags_a_gap_larger_than_the_noise_band():
    records = _same_and_cross_records([0.9, 0.8, 0.7, 0.6], [0.9, 0.8, 0.7, 0.3])
    (cmp,) = compare_cross_same(records, 0.02)
    assert cmp.comparable is True
    assert cmp.basis == "holdout"
    assert cmp.same_false_refusal == 0.0
    assert cmp.cross_false_refusal == 0.25
    assert cmp.gap == pytest.approx(0.25)
    assert cmp.exceeds_noise_band is True
    assert (cmp.same_key, cmp.cross_key) == (KEY_ZH_SAME, "cohere|fake-quality-v1|zh|cross")


def test_compare_cross_same_equal_rates_do_not_exceed_the_band():
    records = _same_and_cross_records([0.9, 0.8, 0.7, 0.6], [0.9, 0.8, 0.7, 0.6])
    (cmp,) = compare_cross_same(records, 0.02)
    assert cmp.exceeds_noise_band is False
    assert cmp.gap == 0.0


def test_compare_cross_same_a_gap_inside_the_band_does_not_count():
    records = _same_and_cross_records([0.9, 0.8, 0.7, 0.6], [0.9, 0.8, 0.7, 0.3])
    (cmp,) = compare_cross_same(records, 0.30)
    assert cmp.exceeds_noise_band is False


def test_compare_cross_same_missing_or_thresholdless_cells_are_not_comparable():
    rows = _dev_rows(DEV_ANSWERABLE, DEV_NO_ANSWER) + [_row("t0", "test", True, 0.9), _row("t1", "test", True, 0.8), _row("t2", "test", False, 0.1)]
    only_same = calibrate_cells(rows, CONFIG, source="fixture", noise_floor=0.02, now=DAY)
    (cmp,) = compare_cross_same(only_same, 0.02)
    assert cmp.comparable is False
    assert cmp.exceeds_noise_band is None
    assert "cross" in cmp.note

    thin = _cross_rows(_dev_rows(DEV_ANSWERABLE, [0.2, 0.3]))
    mixed = calibrate_cells(rows + thin, CONFIG, source="fixture", noise_floor=0.02, now=DAY)
    (cmp2,) = compare_cross_same(mixed, 0.02)
    assert cmp2.comparable is False


def test_report_has_the_cell_table_with_bounds_and_the_xlg_03_section(tmp_path):
    golden, _, scores = _world(tmp_path)
    result = _calibrate(tmp_path, _Runner(scores), golden)
    report = (tmp_path / "out" / "report.md").read_text(encoding="utf-8")
    assert report == render_report(result)
    assert KEY_ZH_SAME.replace("|", "\\|") in report
    assert "calibrated" in report
    assert "0.525" in report
    assert f"{upper_bound(1, 4):.3f}" in report
    assert "XLG-03" in report
    assert "noise band" in report
    assert "dev split only" in report.lower()
    assert "fixture" in report.lower()


def test_report_states_whether_cross_exceeds_same_by_more_than_the_noise_band():
    records = _same_and_cross_records([0.9, 0.8, 0.7, 0.6], [0.9, 0.8, 0.7, 0.3])
    result = refusal_module.CalibrationResult(
        cells=records,
        noise_floor=0.02,
        cross_vs_same=compare_cross_same(records, 0.02),
    )
    report = render_report(result)
    assert "exceeds the same-language rate by more than the noise band" in report
    flat = _same_and_cross_records([0.9, 0.8, 0.7, 0.6], [0.9, 0.8, 0.7, 0.6])
    ok = render_report(refusal_module.CalibrationResult(cells=flat, noise_floor=0.02, cross_vs_same=compare_cross_same(flat, 0.02)))
    assert "does not exceed the same-language rate by more than the noise band" in ok


def test_harness_runner_hands_over_both_splits_only_when_asked(tmp_path):
    golden, items, _ = _world(tmp_path)
    seen: dict[str, list[str]] = {}

    def spawner(argv, cwd):
        path = Path(argv[argv.index("--golden") + 1])
        seen[path.name] = [g.id for g in load_golden(path)]
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    config = tmp_path / "base.json"
    config.write_text(json.dumps({"name": "x", "env": {}}), encoding="utf-8")
    with pytest.raises(HarnessError):
        run_harness(run_config=config, golden=golden, out=tmp_path / "dev-run", spawner=spawner)
    with pytest.raises(HarnessError):
        run_harness(run_config=config, golden=golden, out=tmp_path / "both-run", spawner=spawner, splits=("dev", "test"))
    dev_ids = sorted(i.id for i in items if i.split == "dev")
    assert sorted(seen["golden.dev.jsonl"]) == dev_ids
    assert sorted(seen["golden.dev-test.jsonl"]) == sorted(i.id for i in items)


def _patch_cli(monkeypatch, tmp_path: Path, scores, *, thresholds: Path | None = None):
    runner = _Runner(scores)
    monkeypatch.setattr(refusal_module, "_default_runner", runner)
    if thresholds is not None:
        monkeypatch.setattr(refusal_module, "THRESHOLDS_PATH", thresholds)
    return runner


def test_cli_refusal_writes_outputs_and_leaves_the_committed_thresholds_unchanged(tmp_path, monkeypatch):
    golden, _, scores = _world(tmp_path)
    _patch_cli(monkeypatch, tmp_path, scores)
    before = COMMITTED_THRESHOLDS.read_bytes()
    code = cli_main(["refusal", "--run-config", str(V2_RECOMMENDED), "--out", str(tmp_path / "d"), "--golden", str(golden)])
    assert code == 0
    assert (tmp_path / "d" / "refusal-calibration-result.json").is_file()
    assert (tmp_path / "d" / "report.md").is_file()
    assert COMMITTED_THRESHOLDS.read_bytes() == before


def test_cli_write_thresholds_writes_a_valid_file(tmp_path, monkeypatch):
    golden, _, scores = _world(tmp_path)
    target = tmp_path / "thresholds.json"
    write_config_atomically(target, finalize_config(RefusalThresholds(cells=[])))
    _patch_cli(monkeypatch, tmp_path, scores, thresholds=target)
    code = cli_main(["refusal", "--run-config", str(V2_RECOMMENDED), "--out", str(tmp_path / "d"), "--golden", str(golden), "--write-thresholds"])
    assert code == 0
    written = RefusalThresholds.model_validate_json(target.read_text(encoding="utf-8"))
    assert [(c.key, c.source, c.status) for c in written.cells] == [(KEY_ZH_SAME, "fixture", "calibrated")]


def test_cli_usage_and_harness_errors_have_distinct_exit_codes(tmp_path, monkeypatch, capsys):
    golden, _, scores = _world(tmp_path)
    bad = tmp_path / "missing.json"
    assert cli_main(["refusal", "--run-config", str(bad), "--out", str(tmp_path / "d"), "--golden", str(golden)]) == 2

    def failing(**_kwargs):
        raise HarnessError("harness exited with exit code 1", exit_code=1)

    monkeypatch.setattr(refusal_module, "_default_runner", failing)
    assert cli_main(["refusal", "--run-config", str(V2_RECOMMENDED), "--out", str(tmp_path / "d2"), "--golden", str(golden)]) == 3
    assert "harness" in capsys.readouterr().err


def test_run_records_the_thresholds_path_relative_to_the_repo_root(tmp_path, monkeypatch):
    import rag_eval.paths as paths

    golden, _, scores = _world(tmp_path)
    target = _existing_thresholds(tmp_path)
    monkeypatch.setattr(paths, "REPO_ROOT", tmp_path)
    result = _calibrate(tmp_path, _Runner(scores), golden, write=True, thresholds_path=target)
    assert result.thresholds_path == "thresholds.json"
    written = (tmp_path / "out" / "refusal-calibration-result.json").read_text(encoding="utf-8")
    assert str(tmp_path) not in written
