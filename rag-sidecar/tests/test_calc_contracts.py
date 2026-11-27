import json

import pytest
from pydantic import TypeAdapter, ValidationError

from rag_sidecar.contracts.calc import (
    CalcCheck,
    CalcLimits,
    CalcOperand,
    CalcRequest,
    CalcResult,
    CalcRounding,
    CalcSource,
    CalcStep,
    CalcTrace,
)
from rag_sidecar.contracts.review import ReviewReason

HASH = "c" * 64


def _request(**overrides):
    base = {
        "operands": [
            {"name": "count_a", "value": "3", "unit": "units", "source": {"kind": "question"}},
            {"name": "count_b", "value": "4.5", "unit": "units", "source": {"kind": "question"}},
            {"name": "rate", "value": "2", "unit": "units", "source": {"kind": "chunk", "alias": "S2"}},
        ],
        "steps": [
            {"id": "total", "op": "sum", "args": ["count_a", "count_b", "rate"]},
            {"id": "rounded", "op": "round", "args": ["total"], "rounding": {"mode": "half_even", "places": 0}},
        ],
        "result": "rounded",
    }
    base.update(overrides)
    return base


def _walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def test_valid_request_with_question_and_chunk_operands():
    request = CalcRequest.model_validate(_request())
    assert request.result == "rounded"
    assert request.operands[2].source.alias == "S2"


@pytest.mark.parametrize("arg", ["12", "x+1", "count_a()", "Count_a", "1e3"])
def test_literal_or_code_like_step_argument_fails(arg):
    body = _request()
    body["steps"][0]["args"] = ["count_a", arg]
    with pytest.raises(ValidationError):
        CalcRequest.model_validate(body)


def test_argument_must_name_an_operand_or_an_earlier_step():
    body = _request()
    body["steps"][0]["args"] = ["count_a", "rounded"]
    with pytest.raises(ValidationError):
        CalcRequest.model_validate(body)
    body = _request()
    body["steps"][0]["args"] = ["count_a", "unknown_name"]
    with pytest.raises(ValidationError):
        CalcRequest.model_validate(body)


@pytest.mark.parametrize("name", ["constructor", "prototype", "valueof", "tostring", "hasownproperty"])
def test_reserved_operand_names_fail(name):
    body = _request()
    body["operands"][0]["name"] = name
    body["steps"][0]["args"][0] = name
    with pytest.raises(ValidationError):
        CalcRequest.model_validate(body)


def test_unknown_top_level_and_nested_fields_fail():
    with pytest.raises(ValidationError):
        CalcRequest.model_validate({**_request(), "expression": "1+1"})
    body = _request()
    body["steps"][0]["code"] = "return 1"
    with pytest.raises(ValidationError):
        CalcRequest.model_validate(body)


def test_result_must_be_an_existing_step():
    with pytest.raises(ValidationError):
        CalcRequest.model_validate(_request(result="count_a"))


def test_duplicate_names_fail():
    body = _request()
    body["steps"][1]["id"] = "count_a"
    body["result"] = "count_a"
    with pytest.raises(ValidationError):
        CalcRequest.model_validate(body)


def test_source_rules():
    with pytest.raises(ValidationError):
        CalcSource.model_validate({"kind": "chunk"})
    with pytest.raises(ValidationError):
        CalcSource.model_validate({"kind": "question", "alias": "S1"})
    with pytest.raises(ValidationError):
        CalcSource.model_validate({"kind": "chunk", "alias": "S1", "tool": "facts"})
    with pytest.raises(ValidationError):
        CalcSource.model_validate({"kind": "fact_tool", "tool": "facts"})
    with pytest.raises(ValidationError):
        CalcSource.model_validate({"kind": "chunk", "alias": "s1"})
    assert CalcSource.model_validate({"kind": "fact_tool", "tool": "facts", "key": "item.a"}).key == "item.a"
    assert CalcSource.model_validate({"kind": "chunk", "alias": "S12"}).alias == "S12"


def test_operand_value_rules():
    source = {"kind": "question"}
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "value": "1", "values": ["2"], "source": source})
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "source": source})
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "value": "1", "unit_from": "m", "source": source})
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "value": 1, "source": source})
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "value": "1,5", "source": source})
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "value": "2025-02-30", "source": source})
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "value": "1", "unit": "x;y", "source": source})
    with pytest.raises(ValidationError):
        CalcOperand.model_validate({"name": "a", "values": ["1"] * 201, "source": source})
    assert CalcOperand.model_validate({"name": "a", "value": "2025-02-28", "source": source}).value == "2025-02-28"
    assert CalcOperand.model_validate(
        {"name": "a", "value": "-12.50", "unit_from": "€", "unit_to": "units/day", "source": source}
    ).unit_to == "units/day"


def test_step_rules():
    with pytest.raises(ValidationError):
        CalcStep.model_validate({"id": "r", "op": "round", "args": ["a"]})
    with pytest.raises(ValidationError):
        CalcStep.model_validate({"id": "d", "op": "sum", "args": ["a"], "date_unit": "days"})
    with pytest.raises(ValidationError):
        CalcStep.model_validate({"id": "d", "op": "add", "args": ["a", "b"], "inclusive": True})
    with pytest.raises(ValidationError):
        CalcStep.model_validate({"id": "d", "op": "eval", "args": ["a"]})
    with pytest.raises(ValidationError):
        CalcStep.model_validate({"id": "d", "op": "sum", "args": []})
    with pytest.raises(ValidationError):
        CalcStep.model_validate({"id": "d", "op": "subtract", "args": ["a"]})
    with pytest.raises(ValidationError):
        CalcStep.model_validate({"id": "d", "op": "sum", "args": ["a"], "label": "total {x}"})
    step = CalcStep.model_validate(
        {"id": "d", "op": "date_diff", "args": ["a", "b"], "date_unit": "days", "inclusive": True}
    )
    assert step.inclusive is True


def test_rounding_modes_and_documentation():
    assert CalcRounding.model_validate({"mode": "half_up", "places": 2}).places == 2
    with pytest.raises(ValidationError):
        CalcRounding.model_validate({"mode": "nearest", "places": 2})
    with pytest.raises(ValidationError):
        CalcRounding.model_validate({"mode": "up", "places": 21})
    doc = CalcRounding.__doc__ or ""
    for phrase in ("ties away from zero", "ties to even", "away from zero", "toward zero"):
        assert phrase in doc


def test_request_schema_has_no_union_and_strict_objects():
    schema = CalcRequest.model_json_schema(mode="validation")
    text = json.dumps(schema)
    assert "anyOf" not in text
    assert "oneOf" not in text
    objects = [node for node in _walk(schema) if node.get("type") == "object" and "properties" in node]
    assert objects
    assert all(node.get("additionalProperties") is False for node in objects)


def test_result_and_check_rules():
    ok = CalcResult.model_validate(
        {
            "status": "ok",
            "value": "10",
            "unit": "units",
            "steps": [
                {"id": "total", "op": "sum", "inputs": ["3", "7"], "exact": "10/1", "display": "10",
                 "display_rounded": False}
            ],
        }
    )
    assert ok.value == "10"
    with pytest.raises(ValidationError):
        CalcResult.model_validate({"status": "ok"})
    with pytest.raises(ValidationError):
        CalcResult.model_validate({"status": "rejected", "value": "1", "reject_reason": "mixed_units"})
    with pytest.raises(ValidationError):
        CalcResult.model_validate({"status": "rejected", "reject_reason": "syntax_error"})
    assert CalcResult.model_validate({"status": "rejected", "reject_reason": "division_by_zero"}).value is None
    with pytest.raises(ValidationError):
        CalcCheck.model_validate({"status": "not_verified"})
    with pytest.raises(ValidationError):
        CalcCheck.model_validate({"status": "verified", "recomputed": "1", "trace_hash": "x" * 64, "origin": "tool"})
    check = CalcCheck.model_validate(
        {
            "status": "corrected",
            "stated": "11",
            "recomputed": "10",
            "unit": "units",
            "trace_hash": HASH,
            "origin": "tool",
            "stated_span": {"start": 4, "end": 6},
        }
    )
    assert check.stated_span.end == 6
    with pytest.raises(ValidationError):
        CalcCheck.model_validate({**check.model_dump(), "stated_span": {"start": 6, "end": 6}})


def test_trace_and_limits():
    trace = CalcTrace.model_validate({"origin": "trailing_block", "request": _request(), "anchor_offset": 12})
    assert trace.result is None
    with pytest.raises(ValidationError):
        CalcTrace.model_validate({"origin": "model", "request": _request()})
    limits = CalcLimits.model_validate(
        {
            "version": 1,
            "max_operands": 50,
            "max_list_items": 200,
            "max_steps": 30,
            "max_depth": 30,
            "max_digits": 30,
            "max_round_places": 20,
            "max_bits": 4096,
        }
    )
    assert limits.max_bits == 4096
    with pytest.raises(ValidationError):
        CalcLimits.model_validate({**limits.model_dump(), "max_operands": 0})


def test_review_reason_accepts_calc_values_and_every_earlier_value():
    adapter = TypeAdapter(ReviewReason)
    for value in (
        "sampled",
        "feedback_negative",
        "groundedness_flagged",
        "refusal_disputed",
        "refused_high_score",
        "zero_results",
        "low_score",
        "no_source_opened",
        "claim_unsupported",
        "output_guard",
        "version_conflict",
        "representative",
        "re_review",
        "calc_mismatch",
        "calc_unverified",
    ):
        assert adapter.validate_python(value) == value
