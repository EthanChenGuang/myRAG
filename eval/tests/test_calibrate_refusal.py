import math
import random

import pytest
from rag_sidecar.contracts.eval_run import RagTrace, TraceCandidate, TraceRetrievalVersions
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
) -> RagTrace:
    base = _trace("zh-general-001", [])
    return base.model_copy(
        update={
            "candidates": [_candidate(i, score, lang) for i, (score, lang) in enumerate(scores, start=1)],
            "query_language": query_language,
            "retrieval_versions": TraceRetrievalVersions(lexical=versions[0], rerank_text=versions[1]) if versions else None,
            "retrieval_config_hash": config_hash,
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
