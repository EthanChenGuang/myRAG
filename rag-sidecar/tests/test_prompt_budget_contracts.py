import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.answer_checks import AnswerChecks
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.prompt_budget import (
    PromptBudgetConfig,
    PromptBudgetSummary,
    PromptBudgetTrace,
    TokenizerCalibration,
)
from rag_sidecar.contracts.samples import build_samples

HASH = "d" * 64


def _config(**overrides):
    base = {
        "version": 1,
        "default_window": 8192,
        "margin_ratio": 0.05,
        "margin_tokens": 256,
        "near_limit_ratio": 0.9,
        "mcp_tool_reserve": 2000,
        "voice_document_budget": 1500,
        "voice_system_reserve": 800,
        "voice_answer_reserve": 300,
        "refine_max_calls": 2,
    }
    base.update(overrides)
    return base


def _parts():
    return {"system": 400, "rules": 120, "tools": 300, "history": 900, "question": 30, "documents": 3000, "reserve": 800}


def _trace(**overrides):
    base = {
        "parts": _parts(),
        "estimated_raw_total": 5550,
        "window": 8192,
        "window_source": "model",
        "context_length_unknown": False,
        "estimator": {"encoding": "cl100k_base", "family": "family_a", "factor": 1.1, "factor_source": "measured"},
        "dropped_documents": 2,
        "dropped_history_turns": 1,
        "near_limit": False,
        "overflow_mode": "truncate",
        "status": "ok",
        "standalone_kept": True,
    }
    base.update(overrides)
    return base


def _span(quote):
    return {"document": "document-a.md", "section": "Section 1", "quote": quote}


def _item(category, **fields):
    base = {
        "id": f"item-{category.replace('_', '-')}",
        "question": "What is the total for item A and item B?",
        "language": "en",
        "category": category,
        "answerable": True,
        "expected_answer": "The total is 9 units.",
        "gold_evidence": [_span("Item A takes 4 units."), _span("Item B takes 5 units.")],
        "review_status": "approved",
        "provenance": "synthetic_fixture",
        "split": "dev",
    }
    base.update(fields)
    return base


CALC = {"expected_value": "9", "unit": "units", "tolerance": "0", "paraphrase_group": "calc-group-a"}
OVERFLOW = {"kind": "ranked_evidence", "must_keep": [_span("Item A takes 4 units."), _span("Item B takes 5 units.")]}


def test_config_bounds():
    assert PromptBudgetConfig.model_validate(_config()).refine_max_calls == 2
    for bad in ({"near_limit_ratio": 1.1}, {"margin_ratio": 0.6}, {"default_window": 512}, {"refine_max_calls": 5}):
        with pytest.raises(ValidationError):
            PromptBudgetConfig.model_validate(_config(**bad))
    with pytest.raises(ValidationError):
        PromptBudgetConfig.model_validate({**_config(), "extra": 1})


def test_tokenizer_calibration():
    family = {"family": "family_a", "factor": 1.12, "quantile": 0.95, "samples": 40, "source": "measured",
              "run_ids": ["run-0001"], "computed_at": "2026-11-01T00:00:00Z"}
    calibration = {"version": 1, "encoding": "cl100k_base", "default_factor": 1.25, "families": [family],
                   "written_by": "rag_eval.calibrate tokenizer"}
    assert TokenizerCalibration.model_validate(calibration).families[0].factor == 1.12
    with pytest.raises(ValidationError):
        TokenizerCalibration.model_validate({**calibration, "families": [{**family, "factor": 0.4}]})
    with pytest.raises(ValidationError):
        TokenizerCalibration.model_validate({**calibration, "families": [{**family, "source": "guessed"}]})
    with pytest.raises(ValidationError):
        TokenizerCalibration.model_validate({**calibration, "default_factor": 0.9})
    with pytest.raises(ValidationError):
        TokenizerCalibration.model_validate({**calibration, "encoding": "o200k_base"})
    with pytest.raises(ValidationError):
        TokenizerCalibration.model_validate({**calibration, "families": [family, family]})


def test_budget_trace_and_summary():
    trace = PromptBudgetTrace.model_validate(_trace(status="exceeded", overflow_mode="refine"))
    assert trace.status == "exceeded"
    with pytest.raises(ValidationError):
        PromptBudgetTrace.model_validate(_trace(window_source="guess"))
    with pytest.raises(ValidationError):
        PromptBudgetTrace.model_validate(_trace(parts={**_parts(), "documents": -1}))
    summary = PromptBudgetSummary.model_validate(
        {"parts": _parts(), "window": 8192, "dropped_documents": 0, "dropped_history_turns": 0,
         "near_limit": True, "status": "ok"}
    )
    assert summary.near_limit is True


def test_answer_checks_with_and_without_new_members():
    assert AnswerChecks.model_validate({}).calc is None
    check = {"status": "verified", "recomputed": "9", "unit": "units", "trace_hash": HASH, "origin": "tool"}
    checks = AnswerChecks.model_validate(
        {
            "calc": check,
            "calc_items": [check, {"status": "not_verified", "reason": "trace_missing"}],
            "prompt_budget": {"parts": _parts(), "window": 8192, "dropped_documents": 1,
                              "dropped_history_turns": 0, "near_limit": False, "status": "ok"},
        }
    )
    assert checks.calc.status == "verified"
    assert len(checks.calc_items) == 2
    assert "calc" not in AnswerChecks().model_dump(mode="json")


def test_golden_calc_and_overflow_structures():
    assert GoldenItem.model_validate(_item("multi_step_calc", calc=CALC)).calc.expected_value == "9"
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("multi_step_calc"))
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("general", calc=CALC))
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("multi_step_calc", calc={**CALC, "expected_value": "nine"}))
    item = GoldenItem.model_validate(_item("context_overflow", overflow=OVERFLOW))
    assert len(item.overflow.must_keep) == 2
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("context_overflow"))
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("general", overflow=OVERFLOW))
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(
            _item("context_overflow", overflow={"kind": "ranked_evidence", "must_keep": [_span("Not gold text.")]})
        )
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(
            _item("context_overflow", overflow={"kind": "ranked_evidence", "must_keep": [_span("Item A takes 4 units.")] * 7})
        )
    assert "calc" not in GoldenItem.model_validate(_item("general")).model_dump(mode="json")


def test_trace_without_and_with_new_members():
    sample = build_samples()["samples"]["RagTrace"]
    for key in ("calc", "calc_observed", "prompt_budget", "usage", "answer_error"):
        sample.pop(key, None)
    trace = RagTrace.model_validate(sample)
    assert trace.prompt_budget is None
    extended = RagTrace.model_validate(
        {
            **sample,
            "calc": [{"status": "not_verified", "reason": "stated_not_found"}],
            "calc_observed": {"stated": "9", "steps_listed": True, "tool_used": False, "origin": "trailing_block"},
            "prompt_budget": _trace(),
            "usage": {"input_tokens": 5000, "output_tokens": 120},
            "answer_error": "context_length_exceeded",
        }
    )
    assert extended.usage.output_tokens == 120
    with pytest.raises(ValidationError):
        RagTrace.model_validate({**sample, "answer_error": "The provider said: too long"})
    with pytest.raises(ValidationError):
        RagTrace.model_validate({**sample, "calc_observed": {"stated": "nine", "steps_listed": True, "tool_used": False}})
