"""Plan 05.2-27: Phase 5.2 trace fields, answer-rule report metrics and report-only answer-check budgets."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import report as report_module
from rag_sidecar.contracts import samples
from rag_sidecar.contracts.baseline import Baseline
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.report import EvalReport, StrategySlice

REPO_ROOT = Path(__file__).resolve().parents[2]
HASH = "a" * 64

NEW_TRACE_FIELDS = {
    "answer_language",
    "sentences",
    "refusal_origin",
    "output_guard",
    "residual_output_findings",
    "version_conflict",
    "mixed_versions",
    "finish_reason",
    "answer_rules_parts",
    "notices",
}

ANSWER_RULE_METRICS = {
    "uncited_sentence_rate",
    "unsupported_addition_rate",
    "covered_part_answered",
    "current_value_rate",
    "mixed_versions_rate",
    "adjacent_repurpose_rate",
    "truncation_rate",
}


def _base_trace() -> dict:
    return samples._trace("Item A takes 4 units. [S1]").model_dump(mode="json")


def _sentence(index: int = 0, **overrides) -> dict:
    base = {
        "index": index,
        "part": 0,
        "start": 0,
        "end": 21,
        "kind": "sentence",
        "text_hash": HASH,
        "factual": True,
        "cited": True,
        "support": "not_checked",
        "reason": "judge_not_configured",
    }
    base.update(overrides)
    return base


def _phase52_trace(**overrides) -> dict:
    trace = _base_trace()
    trace.update(
        {
            "answer_language": "en",
            "sentences": [_sentence(0), _sentence(1, start=22, end=30, kind="truncated", factual=False, cited=False)],
            "refusal_origin": "model_relevance",
            "output_guard": {
                "mode": "enforce",
                "rules_version": "1",
                "links_checked": 2,
                "links_removed": 1,
                "credential_blocked": 0,
                "credential_warned": 0,
                "rule_ids": ["rule-1"],
                "source_chunk_ids": ["chunk-001"],
            },
            "residual_output_findings": {"links": 1, "credential_matches": 0, "rule_ids": ["rule-1"]},
            "version_conflict": {
                "document_ids": ["doc-001", "doc-002"],
                "latest_document_id": "doc-002",
                "group_rule": "title_match",
            },
            "mixed_versions": False,
            "finish_reason": "length",
            "answer_rules_parts": ["relevance", "partial_answer", "concise"],
            "notices": [{"kind": "judge_not_configured", "text": "Notice A.", "language": "en"}],
        }
    )
    trace.update(overrides)
    return trace


def test_trace_with_every_phase52_field_validates():
    trace = RagTrace.model_validate(_phase52_trace())
    assert trace.refusal_origin == "model_relevance"
    assert trace.finish_reason == "length"
    assert trace.sentences[1].kind == "truncated"
    assert trace.residual_output_findings.links == 1
    assert trace.answer_rules_parts == ["relevance", "partial_answer", "concise"]


def test_recorded_trace_without_phase52_fields_still_validates_and_dumps_unchanged():
    payload = _base_trace()
    trace = RagTrace.model_validate(payload)
    dumped = trace.model_dump(mode="json")
    assert not NEW_TRACE_FIELDS & set(dumped)
    assert dumped == payload


def test_injection_trace_sample_still_validates():
    RagTrace.model_validate(samples._injection_trace().model_dump(mode="json"))


@pytest.mark.parametrize("origin", ["server", "model_relevance"])
def test_refusal_origin_values(origin):
    assert RagTrace.model_validate(_phase52_trace(refusal_origin=origin)).refusal_origin == origin


def test_refusal_origin_rejects_other_values():
    with pytest.raises(ValidationError):
        RagTrace.model_validate(_phase52_trace(refusal_origin="model"))


def test_trace_sentence_indexes_must_not_repeat():
    with pytest.raises(ValidationError, match="sentence indexes"):
        RagTrace.model_validate(_phase52_trace(sentences=[_sentence(0), _sentence(0, start=22, end=30)]))


def test_answer_rules_parts_are_ids_without_repeats():
    with pytest.raises(ValidationError):
        RagTrace.model_validate(_phase52_trace(answer_rules_parts=["Relevance rule"]))
    with pytest.raises(ValidationError, match="answer_rules_parts"):
        RagTrace.model_validate(_phase52_trace(answer_rules_parts=["concise", "concise"]))


@pytest.mark.parametrize(
    "findings",
    [{"links": -1, "credential_matches": 0}, {"links": 0, "credential_matches": 0, "text": "leaked"}],
)
def test_residual_findings_are_counts_without_text(findings):
    with pytest.raises(ValidationError):
        RagTrace.model_validate(_phase52_trace(residual_output_findings=findings))


def test_residual_findings_total():
    trace = RagTrace.model_validate(
        _phase52_trace(residual_output_findings={"links": 2, "credential_matches": 1})
    )
    assert trace.residual_output_findings.total == 3


def _metric(value: float | None = 0.0, n: int = 4) -> dict:
    return {"value": value, "n": n}


def _answer_rule_metric() -> dict:
    return {
        "overall": _metric(0.25, 8),
        "by_language": {"en": _metric(0.0, 4), "it": _metric(0.5, 4)},
        "by_category": {"partial_answer": _metric(0.25, 8)},
    }


def _phase52_report(**overrides) -> dict:
    report = samples._eval_report().model_dump(mode="json")
    report["answer_rules"] = {name: _answer_rule_metric() for name in ANSWER_RULE_METRICS}
    report["by_strategy"] = {
        "chunk-alias": {"items": 4, "uncited_sentence_rate": _metric(0.1, 10)},
    }
    report.update(overrides)
    return report


def test_report_with_answer_rule_metrics_validates():
    report = EvalReport.model_validate(_phase52_report())
    assert report.answer_rules is not None
    for name in ANSWER_RULE_METRICS:
        metric = getattr(report.answer_rules, name)
        assert metric.overall.n == 8
        assert set(metric.by_language) == {"en", "it"}
    assert report.by_strategy["chunk-alias"].uncited_sentence_rate.value == 0.1


def test_answer_rules_report_metrics_are_optional():
    report = EvalReport.model_validate(
        _phase52_report(answer_rules={"adjacent_repurpose_rate": _answer_rule_metric()})
    )
    assert report.answer_rules.adjacent_repurpose_rate is not None
    assert report.answer_rules.current_value_rate is None
    assert set(report.answer_rules.model_dump(mode="json")) == {"adjacent_repurpose_rate"}


def test_answer_rules_report_class_lists_the_seven_metrics():
    model = getattr(report_module, "AnswerRulesReport", None)
    assert model is not None
    assert set(model.model_fields) == ANSWER_RULE_METRICS


def test_report_without_phase52_fields_still_validates_and_dumps_unchanged():
    payload = samples._eval_report().model_dump(mode="json")
    dumped = EvalReport.model_validate(payload).model_dump(mode="json")
    assert "answer_rules" not in dumped
    assert dumped == payload


def test_strategy_slice_without_uncited_rate_dumps_unchanged():
    payload = {"items": 2, "citation_coverage": _metric(1.0, 2)}
    dumped = StrategySlice.model_validate(payload).model_dump(mode="json")
    assert "uncited_sentence_rate" not in dumped


def test_injection_report_keeps_its_shape():
    injection = samples._injection_report().model_dump(mode="json")
    assert set(injection) == {
        "config_label",
        "items",
        "exposure_rate",
        "attack_success_rate",
        "false_positive_rate",
        "rules_false_positive_count",
        "gate",
    }


def test_unknown_answer_rule_metric_rejected():
    with pytest.raises(ValidationError):
        EvalReport.model_validate(_phase52_report(answer_rules={"made_up_rate": _answer_rule_metric()}))


@pytest.mark.parametrize(
    "name", ["fixture-baseline.json", "fixture-domain-baseline.json", "fixture-ingest-baseline.json"]
)
def test_committed_baselines_still_validate(name):
    path = REPO_ROOT / "eval" / "baselines" / name
    Baseline.model_validate(json.loads(path.read_text(encoding="utf-8")))


def _budget(p50: float, p95: float) -> dict:
    return {"p50_ms": p50, "p95_ms": p95}


def test_latency_budgets_accept_answer_check_entries():
    payload = samples._latency_budgets().model_dump(mode="json")
    payload["answer_checks"] = {
        "claim_check": _budget(2000, 6000),
        "groundedness_judge": _budget(5000, 10000),
        "output_guard": _budget(0.5, 2),
        "report_only": True,
    }
    budgets = LatencyBudgets.model_validate(payload)
    assert budgets.answer_checks.groundedness_judge.p95_ms == 10000
    assert budgets.answer_checks.report_only is True


def test_answer_check_budgets_are_report_only():
    payload = samples._latency_budgets().model_dump(mode="json")
    payload["answer_checks"] = {"claim_check": _budget(2000, 6000), "report_only": False}
    with pytest.raises(ValidationError):
        LatencyBudgets.model_validate(payload)


def test_answer_check_budget_rejects_unknown_entry():
    payload = samples._latency_budgets().model_dump(mode="json")
    payload["answer_checks"] = {"calc_check": _budget(1, 2)}
    with pytest.raises(ValidationError):
        LatencyBudgets.model_validate(payload)


def test_committed_latency_budgets_still_validate_without_answer_checks():
    path = REPO_ROOT / "eval" / "config" / "latency-budgets.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    budgets = LatencyBudgets.model_validate(payload)
    if "answer_checks" not in payload:
        assert "answer_checks" not in budgets.model_dump(mode="json")


PHASE52_EVAL_VARIANTS = {
    "GoldenItem:partial_answer": "GoldenItem",
    "GoldenItem:stale_version": "GoldenItem",
    "GoldenItem:off_topic_context": "GoldenItem",
    "RagTrace:phase52_answer_fields": "RagTrace",
    "EvalReport:answer_rules": "EvalReport",
    "LatencyBudgets:answer_checks": "LatencyBudgets",
}


def test_phase52_eval_samples_exist_and_validate():
    from rag_sidecar.export_schemas import CONTRACTS

    variants = samples.build_samples()["variants"]
    by_name = {model.__name__: model for model, _mode in CONTRACTS}
    for name, model_name in PHASE52_EVAL_VARIANTS.items():
        assert name in variants, name
        assert variants[name]["model"] == model_name
        by_name[model_name].model_validate(variants[name]["value"])


def test_committed_samples_json_carries_the_phase52_eval_variants():
    payload = json.loads((REPO_ROOT / "tests" / "fixtures" / "contracts" / "samples.json").read_text(encoding="utf-8"))
    assert set(PHASE52_EVAL_VARIANTS) <= set(payload["variants"])
