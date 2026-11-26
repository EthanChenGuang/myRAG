import pytest
from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig

from rag_eval.bounds import upper_bound
from rag_eval.calibrate.refusal import (
    CalibrationRow,
    PreviousCell,
    calibrate_cells,
    fit_cells,
    holdout_check,
)
from test_calibrate_refusal import HASH, _dev_rows, _row

CONFIG = RefusalCalibrationConfig()
KEY = "cohere|fake-quality-v1|zh|same"
NOW = "2026-11-24"
NOISE = 0.02


def _fit(threshold_scores: tuple[list[float], list[float]] | None = None):
    answerable, no_answer = threshold_scores or ([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5])
    return fit_cells(_dev_rows(answerable, no_answer), CONFIG, environment="fixture")[KEY]


def _test_rows(answerable: list[float], no_answer: list[float]) -> list[CalibrationRow]:
    rows = [_row(f"test-a-{i}", "test", True, s) for i, s in enumerate(answerable)]
    rows += [_row(f"test-n-{i}", "test", False, s) for i, s in enumerate(no_answer)]
    return rows


def _check(fit, test_rows, *, environment: str = "fixture", noise: float = NOISE):
    return holdout_check(fit, test_rows, config=CONFIG, environment=environment, noise_floor=noise)


def test_holdout_check_returns_counts_and_rates_only():
    result = _check(_fit(), _test_rows([0.9, 0.8, 0.7, 0.3], [0.1]))
    dumped = result.model_dump()
    assert result.metrics.answerable_count == 4
    assert result.metrics.no_answer_count == 1

    def scalars(value):
        if isinstance(value, dict):
            return all(scalars(v) for v in value.values())
        return isinstance(value, (int, float, str, bool, type(None)))

    assert scalars(dumped)


def test_holdout_check_one_false_refusal_of_four_passes_the_pass_rule():
    result = _check(_fit(), _test_rows([0.9, 0.8, 0.7, 0.3], [0.1]))
    assert result.pass_limit == pytest.approx(0.05 + max(0.02, 0.25))
    assert result.false_refusal_count == 1
    assert result.metrics.false_refusal_rate == 0.25
    assert result.metrics.correct_refusal_rate == 1.0
    assert result.status == "calibrated"


def test_holdout_check_two_false_refusals_of_four_fail():
    result = _check(_fit(), _test_rows([0.9, 0.8, 0.3, 0.2], [0.1]))
    assert result.metrics.false_refusal_rate == 0.5
    assert result.status == "failed_holdout"


def test_holdout_check_the_pass_limit_is_inclusive():
    at_limit = _check(_fit(), _test_rows([0.9] * 18 + [0.1] * 2, [0.1]))
    assert at_limit.metrics.false_refusal_rate == pytest.approx(0.10)
    assert at_limit.pass_limit == pytest.approx(0.10)
    assert at_limit.status == "calibrated"
    over = _check(_fit(), _test_rows([0.9] * 17 + [0.1] * 3, [0.1]))
    assert over.status == "failed_holdout"


def test_holdout_check_noise_floor_wins_when_larger_than_one_item():
    answerable = [0.9] * 92 + [0.1] * 8
    result = _check(_fit(), _test_rows(answerable, [0.1]), noise=0.08)
    assert result.pass_limit == pytest.approx(0.05 + 0.08)
    assert result.status == "calibrated"
    tight = _check(_fit(), _test_rows(answerable, [0.1]), noise=0.02)
    assert tight.pass_limit == pytest.approx(0.05 + 0.02)
    assert tight.status == "failed_holdout"


def test_holdout_check_under_the_holdout_minimums_is_insufficient_data():
    fit = _fit()
    assert _check(fit, _test_rows([0.9], [0.1])).status == "insufficient_data"
    assert _check(fit, _test_rows([0.9, 0.8], [])).status == "insufficient_data"
    assert _check(fit, _test_rows([0.9, 0.8], [0.1])).status == "calibrated"


def test_holdout_check_live_minimums_are_larger():
    fit = _fit()
    assert _check(fit, _test_rows([0.9, 0.8], [0.1]), environment="live").status == "insufficient_data"
    ok = _check(fit, _test_rows([0.9] * 6, [0.1] * 3), environment="live")
    assert ok.status == "calibrated"


def test_holdout_check_carries_the_upper_bound_of_the_false_refusal_rate():
    result = _check(_fit(), _test_rows([0.9, 0.8, 0.7, 0.3], [0.1]))
    assert result.metrics.false_refusal_rate_upper_bound == pytest.approx(upper_bound(1, 4))
    zero = _check(_fit(), _test_rows([0.9, 0.8, 0.7, 0.6], [0.1]))
    assert zero.metrics.false_refusal_rate_upper_bound == pytest.approx(1 - 0.05 ** (1 / 4), abs=1e-6)


def test_holdout_check_reports_the_one_sided_binomial_p_value_against_the_target():
    result = _check(_fit(), _test_rows([0.9, 0.8, 0.7, 0.3], [0.1]))
    assert result.false_refusal_p_value == pytest.approx(1 - 0.95**4)
    none = _check(_fit(), _test_rows([0.9, 0.8, 0.7, 0.6], [0.1]))
    assert none.false_refusal_p_value == 1.0


def test_holdout_check_never_reads_a_dev_row():
    with pytest.raises(ValueError):
        _check(_fit(), [_row("dev-a-0", "dev", True, 0.9), *_test_rows([0.9, 0.8], [0.1])])


def test_holdout_check_ignores_test_rows_of_other_cells():
    other = [_row(f"test-it-{i}", "test", True, 0.0, language="it") for i in range(6)]
    result = _check(_fit(), [*_test_rows([0.9, 0.8, 0.7, 0.3], [0.1]), *other])
    assert result.metrics.answerable_count == 4


def _records(rows, previous=None, *, now=NOW, source="fixture"):
    return calibrate_cells(rows, CONFIG, source=source, noise_floor=NOISE, previous=previous, now=now)


def _all_rows(test_answerable=(0.9, 0.8, 0.7, 0.3), test_no_answer=(0.1,)):
    return _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3, 0.5]) + _test_rows(list(test_answerable), list(test_no_answer))


def test_calibrate_cells_builds_a_valid_calibrated_cell_with_all_metadata():
    (record,) = _records(_all_rows())
    cell = record.cell
    assert cell.key == KEY
    assert cell.status == "calibrated"
    assert cell.threshold == pytest.approx(0.525)
    assert cell.source == "fixture"
    assert cell.config_hash == HASH
    assert (cell.tokenizer_version, cell.rerank_text_version) == (3, 2)
    assert cell.holdout_evaluations == 1
    assert cell.recorded_at == NOW
    assert cell.dev.false_refusal_rate == 0.0
    assert cell.dev.false_refusal_rate_upper_bound == pytest.approx(upper_bound(0, 5))
    assert cell.holdout.answerable_count == 4
    assert cell.holdout.false_refusal_rate_upper_bound == pytest.approx(upper_bound(1, 4))
    assert record.holdout_pass_limit == pytest.approx(0.30)


def test_calibrate_cells_failed_holdout_keeps_the_threshold_for_the_record():
    (record,) = _records(_all_rows(test_answerable=(0.9, 0.8, 0.3, 0.2)))
    assert record.cell.status == "failed_holdout"
    assert record.cell.threshold == pytest.approx(0.525)


def test_calibrate_cells_insufficient_holdout_keeps_the_threshold_too():
    (record,) = _records(_all_rows(test_answerable=(0.9,), test_no_answer=(0.1,)))
    assert record.cell.status == "insufficient_data"
    assert record.cell.threshold == pytest.approx(0.525)
    assert record.cell.holdout_evaluations == 1


def test_calibrate_cells_cell_short_on_dev_data_never_reads_the_test_split():
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3]) + _test_rows([0.9, 0.8, 0.7, 0.3], [0.1])
    (record,) = _records(rows)
    assert record.cell.status == "insufficient_data"
    assert record.cell.threshold is None
    assert record.cell.holdout_evaluations == 0
    assert record.cell.holdout.answerable_count == 0
    assert record.cell.holdout.no_answer_count == 0
    changed = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55], [0.2, 0.3]) + _test_rows([0.1, 0.2, 0.3], [0.9])
    assert _records(changed)[0].input_hash == record.input_hash


def test_calibrate_cells_a_fit_that_never_refuses_is_uncalibrated_without_a_holdout_read():
    rows = _dev_rows([0.2, 0.3, 0.4, 0.45, 0.5], [0.8, 0.9, 0.95]) + _test_rows([0.9, 0.8], [0.1])
    (record,) = _records(rows)
    assert record.cell.status == "uncalibrated"
    assert record.cell.threshold is None
    assert record.fit_status == "no_separation"
    assert record.cell.holdout_evaluations == 0


def test_calibrate_cells_thresholds_do_not_depend_on_test_scores():
    baseline = _records(_all_rows())[0].cell.threshold
    for poison in (0.0, 1.0):
        rows = [CalibrationRow(**{**r.__dict__, "score": poison}) if r.split == "test" else r for r in _all_rows()]
        assert _records(rows)[0].cell.threshold == baseline


def test_calibrate_cells_rerun_with_the_same_inputs_is_a_no_op():
    first = _records(_all_rows())
    previous = {r.cell.key: PreviousCell(holdout_evaluations=r.cell.holdout_evaluations, input_hash=r.input_hash, recorded_at=r.cell.recorded_at) for r in first}
    second = _records(_all_rows(), previous, now="2027-01-01")
    assert second[0].cell.holdout_evaluations == 1
    assert [r.model_dump_json() for r in second] == [r.model_dump_json() for r in first]


def test_calibrate_cells_changed_inputs_count_another_evaluation():
    first = _records(_all_rows())
    previous = {r.cell.key: PreviousCell(holdout_evaluations=r.cell.holdout_evaluations, input_hash=r.input_hash, recorded_at=r.cell.recorded_at) for r in first}
    changed = _records(_all_rows(test_answerable=(0.9, 0.8, 0.7, 0.6)), previous, now="2027-01-01")
    assert changed[0].cell.holdout_evaluations == 2
    assert changed[0].cell.recorded_at == "2027-01-01"
    assert changed[0].input_hash != first[0].input_hash


def test_calibrate_cells_a_changed_config_hash_counts_as_changed_input():
    first = _records(_all_rows())
    previous = {r.cell.key: PreviousCell(holdout_evaluations=1, input_hash=r.input_hash, recorded_at=NOW) for r in first}
    rows = [CalibrationRow(**{**r.__dict__, "config_hash": "b" * 64}) for r in _all_rows()]
    assert _records(rows, previous)[0].cell.holdout_evaluations == 2


def test_calibrate_cells_a_failed_cell_is_never_refitted_on_test():
    rows = _all_rows(test_answerable=(0.9, 0.8, 0.3, 0.2))
    first = _records(rows)
    previous = {r.cell.key: PreviousCell(holdout_evaluations=1, input_hash=r.input_hash, recorded_at=NOW) for r in first}
    again = _records(rows, previous)
    assert again[0].cell.status == "failed_holdout"
    assert again[0].cell.threshold == first[0].cell.threshold
    harsher = _records(_all_rows(test_answerable=(0.9, 0.8, 0.3, 0.2), test_no_answer=(0.1, 0.4)), previous)
    assert harsher[0].cell.threshold == first[0].cell.threshold


def test_calibrate_cells_records_are_sorted_by_key_and_validate():
    rows = _all_rows()
    rows += [CalibrationRow(**{**r.__dict__, "key": "cohere|fake-quality-v1|en|same", "query_language": "en"}) for r in _all_rows()]
    keys = [r.cell.key for r in _records(rows)]
    assert keys == ["cohere|fake-quality-v1|en|same", "cohere|fake-quality-v1|zh|same"]


# Phase 4.2 plan 07: mode cells (D-23, D-24)

from rag_sidecar.contracts.retrieval import RefusalModeTargets

MODE_CONFIG = RefusalCalibrationConfig(
    targets_by_mode={
        "strict": RefusalModeTargets(max_false_answer=0.05),
        "balanced": RefusalModeTargets(),
        "flexible": RefusalModeTargets(),
    }
)


def _mode_fit(mode: str):
    rows = _dev_rows([0.9, 0.8, 0.7, 0.6, 0.55, 0.4], [0.2, 0.3, 0.5])
    return fit_cells(rows, MODE_CONFIG, environment="fixture")[f"{KEY}|{mode}"]


def test_holdout_check_a_mode_cell_reads_the_test_rows_of_its_base_cell():
    result = holdout_check(_mode_fit("balanced"), _test_rows([0.9, 0.8, 0.7, 0.3], [0.1]), config=MODE_CONFIG, environment="fixture", noise_floor=NOISE)
    assert result.metrics.answerable_count == 4
    assert result.metrics.no_answer_count == 1


def test_holdout_check_strict_judges_false_answers_against_the_cap():
    fit = _mode_fit("strict")
    assert fit.threshold == pytest.approx(0.525)
    passing = holdout_check(fit, _test_rows([0.9, 0.8, 0.3], [0.1, 0.2, 0.6]), config=MODE_CONFIG, environment="fixture", noise_floor=NOISE)
    assert passing.basis == "false_answer"
    assert passing.false_answer_count == 1
    assert passing.pass_limit == pytest.approx(0.05 + max(NOISE, 1 / 3))
    assert passing.status == "calibrated"
    failing = holdout_check(fit, _test_rows([0.9, 0.8], [0.6, 0.7, 0.1]), config=MODE_CONFIG, environment="fixture", noise_floor=NOISE)
    assert failing.false_answer_count == 2
    assert failing.status == "failed_holdout"
    assert failing.false_answer_p_value == pytest.approx(1 - sum(
        __import__("math").comb(3, k) * 0.05**k * 0.95 ** (3 - k) for k in range(2)
    ))


def test_holdout_check_base_cell_keeps_the_false_refusal_basis():
    result = _check(_fit(), _test_rows([0.9, 0.8, 0.7, 0.3], [0.1]))
    assert result.basis == "false_refusal"
