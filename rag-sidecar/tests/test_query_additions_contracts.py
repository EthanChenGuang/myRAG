"""Phase 6.2 contract additions (06.2-01, D-04, D-05, D-09, D-10, D-12, D-13, D-14, D-16, D-17, D-18, D-20 to D-23,
D-26, D-27, D-29). Every value is a neutral synthetic string."""

import importlib
import json
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import ValidationError

REPO = Path(__file__).resolve().parents[2]


def _symbol(module: str, name: str) -> Any:
    try:
        loaded = importlib.import_module(f"rag_sidecar.contracts.{module}")
    except ImportError:
        pytest.fail(f"contract module {module} is missing")
    value = getattr(loaded, name, None)
    assert value is not None, f"{module}.{name} is missing"
    return value


def _rejects(model: Any, data: dict[str, Any]) -> bool:
    try:
        model.model_validate(data)
    except ValidationError:
        return True
    return False


# --- query.py -----------------------------------------------------------------------------------------------------


def test_sub_question_filter_accepts_exactly_the_four_fields():
    sub_filter = _symbol("query", "SubQuestionFilter")
    value = sub_filter.model_validate(
        {
            "date_range": {"from": "2025-01-01", "to": "2025-12-31"},
            "scopes": {"region": ["north"]},
            "doc_types": ["general"],
            "languages": ["en"],
        }
    )
    assert value.scopes == {"region": ["north"]}
    assert set(sub_filter.model_fields) == {"date_range", "scopes", "doc_types", "languages"}


@pytest.mark.parametrize(
    "extra",
    [
        {"tenant": "s:default"},
        {"document_ids": ["00000000-0000-4000-8000-000000000001"]},
        {"sources": ["alpha"]},
        {"include_undated": True},
        {"include_untagged": True},
        {"versions": {"mode": "current"}},
    ],
)
def test_sub_question_filter_rejects_unknown_keys(extra):
    sub_filter = _symbol("query", "SubQuestionFilter")
    base = {"date_range": None, "scopes": None, "doc_types": None, "languages": None}
    assert _rejects(sub_filter, {**base, **extra})


@pytest.mark.parametrize(
    "field,value",
    [("doc_types", []), ("languages", []), ("scopes", {"region": []}), ("scopes", {"unknown_dimension": ["a"]})],
)
def test_sub_question_filter_rejects_empty_lists_and_unknown_dimensions(field, value):
    sub_filter = _symbol("query", "SubQuestionFilter")
    base = {"date_range": None, "scopes": None, "doc_types": None, "languages": None}
    assert _rejects(sub_filter, {**base, field: value})


def test_sub_question_filter_rejects_reversed_dates():
    sub_filter = _symbol("query", "SubQuestionFilter")
    base = {"scopes": None, "doc_types": None, "languages": None}
    assert _rejects(sub_filter, {**base, "date_range": {"from": "2025-12-31", "to": "2025-01-01"}})


def test_sub_questions_with_filters_requires_every_field():
    with_filters = _symbol("query", "SubQuestionsWithFilters")
    assert with_filters.model_validate({"questions": [{"text": "alpha part one", "filter": None}]})
    assert _rejects(with_filters, {})
    assert _rejects(with_filters, {"questions": [{"text": "alpha part one"}]})
    assert _rejects(with_filters, {"questions": [{"filter": None}]})
    assert _rejects(
        with_filters,
        {"questions": [{"text": "alpha", "filter": {"date_range": None, "scopes": None, "doc_types": None}}]},
    )


def test_sub_questions_is_unchanged():
    sub_questions = _symbol("query", "SubQuestions")
    assert set(sub_questions.model_fields) == {"questions"}


def _plan(**update: Any) -> dict[str, Any]:
    plan = {
        "original": "alpha and beta",
        "standalone": "alpha and beta",
        "language": "en",
        "gate": {"rewrite": True, "transforms": ["decompose"], "reasons": [], "lang": "en", "protected_tokens": []},
        "variants": [],
        "sub_questions": ["alpha part", "beta part"],
        "framework": "llamaindex",
    }
    plan.update(update)
    return plan


def test_query_plan_without_new_fields_validates_and_dumps_unchanged():
    plan_model = _symbol("query", "QueryPlan")
    plan = plan_model.model_validate(_plan())
    for field in ("sub_question_specs", "completeness", "language_detection", "filter_trace"):
        assert field in plan_model.model_fields, field
    dumped = plan.model_dump(mode="json")
    for field in ("sub_question_specs", "completeness", "language_detection", "filter_trace"):
        assert field not in dumped, field


def test_query_plan_specs_must_match_sub_questions():
    plan_model = _symbol("query", "QueryPlan")
    specs = [{"text": "alpha part", "filter": None}, {"text": "beta part", "filter": None}]
    assert plan_model.model_validate(_plan(sub_question_specs=specs)).sub_question_specs[1].text == "beta part"
    wrong = [{"text": "alpha part", "filter": None}, {"text": "gamma part", "filter": None}]
    assert _rejects(plan_model, _plan(sub_question_specs=wrong))
    assert _rejects(plan_model, _plan(sub_question_specs=specs[:1]))


def test_query_plan_carries_completeness_detection_and_filter_trace():
    plan_model = _symbol("query", "QueryPlan")
    plan = plan_model.model_validate(
        _plan(
            completeness={"required_count": 2, "missing_count": 1, "action": "added"},
            language_detection={"language": "en", "confidence": 0.9, "source": "detector"},
            filter_trace=[
                {"index": 0, "status": "applied", "retried": False, "retry_skipped_cap": False},
                {"index": 1, "status": "dropped_empty_intersection", "retried": True, "retry_skipped_cap": False},
            ],
        )
    )
    assert plan.completeness.action == "added"
    assert plan.filter_trace[1].status == "dropped_empty_intersection"


def test_completeness_result_is_counts_only():
    completeness = _symbol("query", "CompletenessResult")
    assert set(completeness.model_fields) == {"required_count", "missing_count", "action"}
    assert _rejects(completeness, {"required_count": 1, "missing_count": 0, "action": "repaired"})
    assert _rejects(completeness, {"required_count": 1, "missing_count": 0, "action": "ok", "terms": ["alpha"]})


@pytest.mark.parametrize("confidence", [-0.1, 1.1])
def test_language_detection_confidence_is_bounded(confidence):
    detection = _symbol("query", "LanguageDetection")
    assert _rejects(detection, {"language": "en", "confidence": confidence, "source": "detector"})


def test_language_detection_sources():
    detection = _symbol("query", "LanguageDetection")
    for source in ("single_language", "detector", "sidecar", "llm", "previous_turn", "ui_language", "primary"):
        assert detection.model_validate({"language": None, "confidence": 0.0, "source": source}).source == source
    assert _rejects(detection, {"language": "en", "confidence": 0.5, "source": "guess"})


def test_filter_trace_statuses():
    trace = _symbol("query", "SubQuestionFilterTrace")
    statuses = (
        "applied",
        "dropped_invalid",
        "dropped_empty_intersection",
        "dropped_unknown_values",
        "stripped_switch_off",
    )
    for status in statuses:
        assert trace.model_validate({"index": 0, "status": status, "retried": False, "retry_skipped_cap": False})
    assert _rejects(trace, {"index": 0, "status": "widened", "retried": False, "retry_skipped_cap": False})


def test_literal_additions():
    query = importlib.import_module("rag_sidecar.contracts.query")
    assert "history_fallback" in get_args(query.VariantKind)
    assert "glossary_term_lost" in get_args(query.SkipReason)
    variant = query.QueryVariantOut.model_validate(
        {"text": "alpha", "language": "en", "kind": "history_fallback", "protected_ok": True}
    )
    assert variant.filter_applied is False
    assert "filter_applied" not in variant.model_dump(mode="json")


def test_condensed_and_translation_language_fields_are_required_nullable():
    condensed = _symbol("query", "CondensedQuery")
    translation = _symbol("query", "QueryTranslation")
    assert condensed.model_validate({"standalone": "alpha", "unchanged": True, "language": None}).language is None
    assert _rejects(condensed, {"standalone": "alpha", "unchanged": True})
    assert translation.model_validate({"target_language": "en", "text": "alpha", "source_language": "it"})
    assert _rejects(translation, {"target_language": "en", "text": "alpha"})


def test_query_params_defaults():
    params = _symbol("query", "QueryParams")()
    assert params.language_confidence_threshold == 0.6
    assert params.routing_fast_max_context_tokens == 2000
    assert params.subq_filter_vocab_cap == 20
    assert params.langid_timeout_ms == 30


# --- eval_run.py --------------------------------------------------------------------------------------------------


def test_eval_run_additions():
    eval_run = importlib.import_module("rag_sidecar.contracts.eval_run")
    assert "scope_gate" in get_args(eval_run.StageName)
    assert eval_run.StageTimeoutsMs(scope_gate=5).scope_gate == 5
    assert "out_of_scope" in get_args(eval_run.RefusalReason)
    options = eval_run.RagRunOptions()
    assert options.entry_profile == "eval"
    assert options.selected_model is None
    assert eval_run.RagRunOptions(entry_profile="voice").entry_profile == "voice"
    assert _rejects(eval_run.RagRunOptions, {"entry_profile": "embed"})
    for field in ("scope_gate", "model_route", "speculative", "answer_structure", "searches_counted"):
        assert field in eval_run.RagTrace.model_fields, field


# --- new modules --------------------------------------------------------------------------------------------------


def test_scope_gate_result():
    result = _symbol("scope_gate", "ScopeGateResult")
    value = result.model_validate(
        {
            "label": "unsure",
            "score": None,
            "negative_score": None,
            "reason": "no_centroids",
            "centroid_count": 0,
            "latency_ms": 1.5,
        }
    )
    assert value.label == "unsure"
    assert _rejects(result, {**value.model_dump(mode="json"), "label": "maybe"})
    assert _rejects(result, {**value.model_dump(mode="json"), "query": "alpha"})


def _calibration_cell(**update: Any) -> dict[str, Any]:
    cell = {
        "embedding_profile_id": "fixture-profile",
        "rag_mode": "strict",
        "threshold": 0.4,
        "margin": 0.05,
        "false_refusal_rate": 0.0,
        "false_refusal_n": 10,
        "correct_refusal_rate": 0.5,
        "correct_refusal_n": 4,
        "status": "calibrated",
    }
    cell.update(update)
    return cell


def test_scope_gate_calibration():
    calibration = _symbol("scope_gate", "ScopeGateCalibration")
    value = calibration.model_validate(
        {
            "schema_version": 1,
            "recorded_at": "2026-11-27T00:00:00Z",
            "source": "fixture",
            "cells": [_calibration_cell(), _calibration_cell(rag_mode="balanced", status="uncalibrated")],
        }
    )
    assert value.cells[1].status == "uncalibrated"
    assert value.cells[0].false_refusal_upper_95 is None
    assert _rejects(calibration, {**value.model_dump(mode="json"), "source": "guess"})
    assert _rejects(
        calibration,
        {**value.model_dump(mode="json"), "cells": [_calibration_cell(), _calibration_cell()]},
    )


def test_langid_request_and_response():
    request = _symbol("langid", "LangidRequest")
    response = _symbol("langid", "LangidResponse")
    assert request.model_validate({"text": "alpha", "candidates": ["en", "it"]})
    assert _rejects(request, {"text": "a" * 1001, "candidates": ["en"]})
    assert _rejects(request, {"text": "alpha", "candidates": []})
    assert _rejects(request, {"text": "", "candidates": ["en"]})
    assert response.model_validate({"language": None, "confidence": 0.0, "model": "fixture"})
    assert _rejects(response, {"language": "en", "confidence": 1.5, "model": "fixture"})


def test_model_route_speculative_and_answer_structure():
    route = _symbol("query_additions", "ModelRoute")
    speculative = _symbol("query_additions", "SpeculativeTrace")
    structure = _symbol("query_additions", "AnswerStructure")
    assert route.model_validate({"tier": "fast", "rule": "short_lookup", "selection": "auto"})
    assert _rejects(route, {"tier": "medium", "rule": "short_lookup", "selection": "auto"})
    assert speculative.model_validate(
        {"started_ms": 1.0, "overlap_ms": 0.5, "cancelled_by_cache": False, "wasted_searches": 0}
    )
    assert structure.model_validate({"parts": 2, "cited_parts": None, "uncovered_parts": 0})
    assert _rejects(structure, {"parts": -1, "cited_parts": None, "uncovered_parts": 0})


def test_rag_turn_metadata_caps_the_standalone_query():
    metadata = _symbol("query_additions", "RagTurnMetadata")
    assert metadata.model_validate({"standaloneQuery": "alpha beta", "queryLanguage": None})
    assert _rejects(metadata, {"standaloneQuery": "a" * 1001, "queryLanguage": None})
    assert _rejects(metadata, {"standaloneQuery": "alpha", "queryLanguage": None, "filters": {}})
    assert set(metadata.model_fields) == {"standaloneQuery", "queryLanguage", "scopeGate"}


def test_rag_turn_metadata_scope_gate_is_the_label_only():
    metadata = _symbol("query_additions", "RagTurnMetadata")
    labelled = metadata.model_validate(
        {"standaloneQuery": "alpha", "queryLanguage": "en", "scopeGate": "out_of_scope"}
    )
    assert labelled.scopeGate == "out_of_scope"
    unlabelled = metadata.model_validate({"standaloneQuery": "alpha", "queryLanguage": None})
    assert "scopeGate" not in unlabelled.model_dump()
    base = {"standaloneQuery": "alpha", "queryLanguage": None}
    assert _rejects(metadata, {**base, "scopeGate": "outside"})
    assert _rejects(metadata, {**base, "scopeGate": {"label": "out_of_scope", "score": 0.1}})


def test_decision_record():
    record = _symbol("query_additions", "QueryAdditionsDecisionRecord")
    value = record.model_validate(
        {
            "schema_version": 1,
            "recorded_at": "2026-11-27T00:00:00Z",
            "report_hash": "a" * 64,
            "source": "fixture",
            "switches": [
                {"name": "RAG_SCOPE_GATE", "eligible": False, "improved_slices": [], "regressions": [], "notes": ""}
            ],
        }
    )
    assert value.decided_by == "rag_eval.compare query-additions"
    assert value.d31_checklist == []
    checked = record.model_validate(
        {
            **value.model_dump(mode="json"),
            "d31_checklist": [{"letter": "a", "passed": True, "evidence": "fixture run"}],
        }
    )
    assert checked.d31_checklist[0].letter == "a"
    assert _rejects(record, {**value.model_dump(mode="json"), "decided_by": "someone"})
    assert _rejects(
        record,
        {**value.model_dump(mode="json"), "d31_checklist": [{"letter": "j", "passed": True, "evidence": "x"}]},
    )
    assert _rejects(
        record,
        {
            **value.model_dump(mode="json"),
            "d31_checklist": [
                {"letter": "a", "passed": True, "evidence": "x"},
                {"letter": "a", "passed": False, "evidence": "y"},
            ],
        },
    )


# --- golden.py ----------------------------------------------------------------------------------------------------


def _span(quote: str) -> dict[str, str]:
    return {"document": "doc-alpha.md", "section": "Part", "quote": quote}


def _golden(category: str, **update: Any) -> dict[str, Any]:
    item = {
        "id": "en-q62-001",
        "question": "How do alpha and beta compare?",
        "language": "en",
        "category": category,
        "answerable": True,
        "expected_answer": "Alpha is one, beta is two.",
        "gold_evidence": [_span("alpha is one"), _span("beta is two")],
        "review_status": "draft",
        "provenance": "synthetic_fixture",
        "split": "dev",
        "sub_questions": [
            {"index": 0, "gold_spans": [_span("alpha is one")]},
            {"index": 1, "gold_spans": [_span("beta is two")]},
        ],
    }
    item.update(update)
    return item


@pytest.mark.parametrize("category", ["version_compare", "scoped_compound"])
def test_golden_multi_part_categories_need_two_sub_questions(category):
    item_model = _symbol("golden", "GoldenItem")
    assert item_model.model_validate(_golden(category)).sub_questions[1].index == 1
    assert _rejects(item_model, _golden(category, sub_questions=[{"index": 0, "gold_spans": [_span("alpha is one")]}]))
    assert _rejects(item_model, _golden(category, sub_questions=[]))


def test_golden_glossary_category_exists():
    golden = importlib.import_module("rag_sidecar.contracts.golden")
    for category in ("version_compare", "scoped_compound", "glossary"):
        assert category in get_args(golden.Category), category


def test_golden_sub_question_spans_must_be_gold_evidence():
    item_model = _symbol("golden", "GoldenItem")
    stray = [{"index": 0, "gold_spans": [_span("alpha is one")]}, {"index": 1, "gold_spans": [_span("gamma")]}]
    assert _rejects(item_model, _golden("scoped_compound", sub_questions=stray))


@pytest.mark.parametrize("indexes", [[0, 0], [1, 2]])
def test_golden_sub_question_indexes_are_unique_from_zero(indexes):
    item_model = _symbol("golden", "GoldenItem")
    subs = [{"index": index, "gold_spans": [_span("alpha is one")]} for index in indexes]
    assert _rejects(item_model, _golden("scoped_compound", sub_questions=subs))


def test_golden_sub_questions_dump_absent_when_empty():
    item_model = _symbol("golden", "GoldenItem")
    item = item_model.model_validate(_golden("compound", sub_questions=[]))
    assert "sub_questions" not in item.model_dump(mode="json")


def test_every_golden_line_validates_unchanged():
    from rag_sidecar.contracts.golden import GoldenItem

    path = REPO / "eval" / "fixtures" / "golden.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        raw = json.loads(line)
        assert GoldenItem.model_validate(raw).model_dump(mode="json", exclude_none=False) is not None
        assert "sub_questions" not in GoldenItem.model_validate(raw).model_dump(mode="json")


# --- report.py ----------------------------------------------------------------------------------------------------


def test_report_metric_additions_default_to_none_and_are_omitted():
    report = importlib.import_module("rag_sidecar.contracts.report")
    for field in ("all_evidence_recall_at_5", "all_evidence_recall_at_10", "subq_coverage_at_5", "subq_coverage_at_10"):
        assert field in report.SliceMetrics.model_fields, field
    for field in ("subq_total", "subq_hit_at_5", "subq_hit_at_10"):
        assert field in report.ItemResult.model_fields, field
    metric = {"value": 0.5, "n": 2}
    metrics = report.SliceMetrics.model_validate(
        {
            "recall_at_5": metric,
            "recall_at_10": metric,
            "mrr": metric,
            "correct_refusal_rate": metric,
            "false_refusal_rate": metric,
        }
    )
    assert metrics.subq_coverage_at_5 is None
    assert "subq_coverage_at_5" not in metrics.model_dump(mode="json")


# --- terminology.py and languages.py ------------------------------------------------------------------------------


def _term(**update: Any) -> dict[str, Any]:
    entry = {
        "layer": "shared",
        "canonical": "term alpha",
        "variants": ["termine alfa"],
        "language": "it",
        "kind": "translation",
        "source_language": "it",
        "target_language": "en",
    }
    entry.update(update)
    return entry


def test_term_target_language_rules():
    entry = _symbol("terminology", "TerminologyEntry")
    assert entry.model_validate(_term()).target_language == "en"
    assert _rejects(entry, _term(target_language=None))
    assert _rejects(entry, _term(target_language="it"))
    assert _rejects(entry, _term(kind="synonym", source_language=None, language="en"))


def test_language_pack_query_layer_texts_are_optional():
    languages = importlib.import_module("rag_sidecar.contracts.languages")
    texts = _symbol("languages", "QueryLayerTexts")
    keys = (
        "decomposed_answer_intro",
        "decomposed_answer_parts",
        "decomposed_answer_compare_order",
        "decomposed_answer_cite_own",
        "decomposed_answer_block_label",
        "scope_gate_notice",
        "scope_gate_prompt_rule",
    )
    assert tuple(texts.model_fields) == keys
    assert languages.LanguageTexts.model_fields["query_layer"].default is None
    registry = languages.load_language_registry()
    for pack in registry.packs:
        assert languages.pack_missing_parts(pack) == [], pack.code
        assert not any(key.startswith("query_layer.") for key in languages.TEXT_KEYS)
    assert texts.model_validate({"scope_gate_notice": "Outside the documents."}).scope_gate_notice
    assert _rejects(texts, {"scope_gate_notice": ""})
    assert _rejects(texts, {"scope_gate_notice": "Outside {topic}."})


def test_sub_question_date_range_round_trips_with_the_from_key():
    sub_filter = _symbol("query", "SubQuestionFilter")
    raw = {"date_range": {"from": "2025-01-01", "to": "2025-06-30"}, "scopes": None, "doc_types": None, "languages": None}
    dumped = sub_filter.model_validate(raw).model_dump(mode="json")
    assert dumped["date_range"] == {"from": "2025-01-01", "to": "2025-06-30"}
    assert sub_filter.model_validate(dumped) == sub_filter.model_validate(raw)
