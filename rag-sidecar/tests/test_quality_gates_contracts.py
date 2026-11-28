import copy

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.quality_gates import (
    METRIC_FORMS,
    AbsoluteGateResult,
    CompositionResult,
    GateCheckRow,
    QualityGates,
)

D04 = {
    "schema_version": 1,
    "composition": {
        "no_answer_share_min": 0.15,
        "no_answer_share_target": 0.20,
        "excluded_categories": ["small_talk"],
        "required_no_answer_kinds": [],
        "min_items_per_language": 20,
    },
    "ceilings": {
        "false_answer_rate": {"strict": 0.05, "balanced": None, "flexible": None},
        "false_refusal_rate": {"strict": 0.25, "balanced": 0.25, "flexible": 0.25},
        "min_n": 10,
    },
    "floors": {"smoke": {}, "nightly": {"faithfulness": 0.85, "answer_relevance": 0.75}},
    "judge": {
        "kappa_floor": 0.6,
        "accuracy_floor": 0.8,
        "min_labels_per_language": 100,
        "seed_min_labels_per_language": 50,
        "pass_threshold": {"faithfulness": 0.8, "answer_relevance": 0.7},
        "length_bias_max_delta": 0.1,
        "perturbation_max_delta": 0.1,
        "max_age_days": 35,
    },
    "lifecycle": {"max_stale_share": 0.10, "re_review_days": 90},
    "provenance": {"source": "defaults"},
}


def _gates(**patch):
    data = copy.deepcopy(D04)
    for dotted, value in patch.items():
        node = data
        keys = dotted.split("__")
        for key in keys[:-1]:
            node = node[key]
        node[keys[-1]] = value
    return data


def test_d04_shape_validates_and_round_trips():
    gates = QualityGates.model_validate(D04)
    assert gates.ceilings.false_answer_rate["strict"] == 0.05
    assert gates.ceilings.false_answer_rate["balanced"] is None
    assert gates.floors.nightly == {"faithfulness": 0.85, "answer_relevance": 0.75}
    assert gates.provenance.source == "defaults"
    assert QualityGates.model_validate(gates.model_dump(mode="json")) == gates


def test_null_ceiling_is_report_only_and_accepted():
    gates = QualityGates.model_validate(_gates(ceilings__false_refusal_rate={"strict": None}))
    assert gates.ceilings.false_refusal_rate["strict"] is None


@pytest.mark.parametrize(
    "patch",
    [
        {"schema_version": 2},
        {"composition__no_answer_share_min": 1.5},
        {"composition__no_answer_share_target": -0.1},
        {"composition__no_answer_share_min": 0.3, "composition__no_answer_share_target": 0.2},
        {"ceilings__false_answer_rate": {"strict": 0.05, "turbo": 0.1}},
        {"ceilings__false_refusal_rate": {"strict": 1.2}},
        {"lifecycle__max_stale_share": 2},
        {"judge__kappa_floor": 1.5},
    ],
)
def test_invalid_values_rejected(patch):
    with pytest.raises(ValidationError):
        QualityGates.model_validate(_gates(**patch))


def test_unknown_key_rejected():
    with pytest.raises(ValidationError):
        QualityGates.model_validate({**D04, "smuggled": 1})


def test_holistic_metric_cannot_carry_a_floor():
    assert METRIC_FORMS["holistic_quality"] == "holistic"
    with pytest.raises(ValidationError, match="holistic"):
        QualityGates.model_validate(_gates(floors__nightly={"faithfulness": 0.85, "holistic_quality": 0.6}))
    with pytest.raises(ValidationError, match="holistic"):
        QualityGates.model_validate(_gates(floors__smoke={"holistic_quality": 0.6}))


def test_unknown_metric_cannot_carry_a_floor():
    with pytest.raises(ValidationError, match="unknown"):
        QualityGates.model_validate(_gates(floors__nightly={"made_up_metric": 0.5}))


def test_holistic_metric_cannot_carry_a_judge_pass_threshold():
    with pytest.raises(ValidationError, match="holistic"):
        QualityGates.model_validate(_gates(judge__pass_threshold={"holistic_quality": 0.6}))


def _row(**overrides):
    base = {
        "check": "false_answer_rate",
        "slice": "overall",
        "measured": 0.15,
        "numerator": 3,
        "denominator": 20,
        "limit": 0.05,
        "limit_kind": "max",
        "result": "failed",
        "reason": None,
    }
    base.update(overrides)
    return base


@pytest.mark.parametrize("result", ["passed", "failed", "insufficient_n", "report_only", "skipped"])
def test_gate_check_row_results(result):
    assert GateCheckRow.model_validate(_row(result=result)).result == result


@pytest.mark.parametrize("result", ["ok", "pass", "warning", ""])
def test_gate_check_row_rejects_other_results(result):
    with pytest.raises(ValidationError):
        GateCheckRow.model_validate(_row(result=result))


def test_gate_check_row_reason_is_a_code():
    assert GateCheckRow.model_validate(_row(result="insufficient_n", reason="below_min_n")).reason == "below_min_n"
    with pytest.raises(ValidationError):
        GateCheckRow.model_validate(_row(reason="The model answered three questions it should refuse"))


def _composition():
    return {
        "languages": [
            {
                "language": "en",
                "items": 40,
                "no_answer": 8,
                "share": 0.2,
                "min": 0.15,
                "target": 0.2,
                "result": "passed",
                "kinds": {"no_answer": 8},
            }
        ],
        "missing_required_kinds": [],
    }


def _absolute(**overrides):
    base = {
        "passed": True,
        "mode": "enforce",
        "rag_mode": "strict",
        "checks": [
            _row(result="skipped", reason="no_judge_report", measured=None, numerator=None, denominator=None),
            _row(result="insufficient_n", reason="below_min_n", slice="language:it", numerator=1, denominator=4),
        ],
        "composition": _composition(),
        "stale_count": 0,
        "stale_share": 0.0,
        "stale_result": "passed",
        "failed": [],
        "exit_code": 0,
    }
    base.update(overrides)
    return base


def test_absolute_result_keeps_skipped_and_insufficient_n_apart_from_passed():
    result = AbsoluteGateResult.model_validate(_absolute())
    assert [row.result for row in result.checks] == ["skipped", "insufficient_n"]
    assert AbsoluteGateResult.model_validate(result.model_dump(mode="json")) == result


def test_composition_result_validates():
    assert CompositionResult.model_validate(_composition()).languages[0].share == 0.2


def test_absolute_result_report_mode_never_exits_non_zero():
    with pytest.raises(ValidationError):
        AbsoluteGateResult.model_validate(_absolute(mode="report", exit_code=11))


def test_absolute_result_rejects_unknown_exit_code():
    with pytest.raises(ValidationError):
        AbsoluteGateResult.model_validate(_absolute(exit_code=10))


def test_no_model_has_a_free_text_field():
    text_like = {"question", "answer", "text", "content", "query", "message", "context", "document"}
    for model in (QualityGates, GateCheckRow, CompositionResult, AbsoluteGateResult):
        assert not text_like & set(model.model_fields), model.__name__
