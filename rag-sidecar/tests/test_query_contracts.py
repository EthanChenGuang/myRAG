import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from rag_sidecar import contracts
from rag_sidecar.contracts import query as query_module

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLES_PATH = REPO_ROOT / "tests" / "fixtures" / "contracts" / "samples.json"
RETRIEVAL_PARAMS_PATH = REPO_ROOT / "eval" / "config" / "retrieval-params.json"

LLM_OUTPUT_MODELS = ["CondensedQuery", "QueryVariants", "HypotheticalDocument", "SubQuestions", "QueryTranslation"]
NEW_STAGES = ["query_gate", "condense", "normalize_dates", "expand", "hyde", "decompose", "semantic_cache"]


def _model(name: str) -> type[BaseModel] | None:
    found = getattr(query_module, name, None) or getattr(contracts, name, None)
    return found if isinstance(found, type) and issubclass(found, BaseModel) else None


def accepts(model: type[BaseModel] | None, payload: dict[str, Any]) -> bool:
    if model is None:
        return False
    try:
        model.model_validate(payload)
    except (ValidationError, ValueError):
        return False
    return True


def rejects(model: type[BaseModel] | None, payload: dict[str, Any]) -> bool:
    return model is not None and not accepts(model, payload)


def _gate(**overrides: Any) -> dict[str, Any]:
    base = {
        "rewrite": True,
        "transforms": ["condense_history"],
        "reasons": ["R1_PRONOUN"],
        "lang": "zh",
        "protected_tokens": ["ERR_TIMEOUT"],
    }
    base.update(overrides)
    return base


def _variant(**overrides: Any) -> dict[str, Any]:
    base = {
        "text": "placeholder query text",
        "language": "en",
        "kind": "original",
        "sub_question_index": None,
        "protected_ok": True,
    }
    base.update(overrides)
    return base


def _plan(**overrides: Any) -> dict[str, Any]:
    base = {
        "original": "placeholder original",
        "standalone": "placeholder standalone",
        "language": "en",
        "gate": _gate(lang="en"),
        "date_range": {
            "from_date": "2026-01-01",
            "to_date": "2026-01-31",
            "include_undated": False,
            "time_zone": "UTC",
        },
        "variants": [_variant(), _variant(kind="sub_question", sub_question_index=0)],
        "sub_questions": ["placeholder sub question"],
        "skipped": [{"transform": "hyde", "reason": "timeout"}],
        "framework": "llamaindex",
    }
    base.update(overrides)
    return base


# --- Task 1: RewriteGateResult


def test_gate_accepts_spec_example_with_history():
    gate = _model("RewriteGateResult")
    assert accepts(gate, _gate())
    assert gate is not None and gate.model_validate(_gate()).skip_retrieval is False


def test_gate_rejects_unknown_transform_and_language():
    gate = _model("RewriteGateResult")
    assert rejects(gate, _gate(transforms=["summarize"]))
    assert rejects(gate, _gate(lang="fr"))


def test_gate_name_does_not_collide_with_eval_gate_result():
    assert _model("RewriteGateResult") is not None
    assert contracts.GateResult is not _model("RewriteGateResult")
    assert "RewriteGateResult" in contracts.__all__


# --- Task 1: QueryPlan


def test_query_plan_accepts_full_plan_for_both_frameworks():
    plan = _model("QueryPlan")
    assert accepts(plan, _plan())
    assert accepts(plan, _plan(framework="langchain", date_range=None, sub_questions=[], variants=[_variant()]))


def test_query_plan_rejects_more_than_four_sub_questions():
    assert rejects(_model("QueryPlan"), _plan(sub_questions=["q1", "q2", "q3", "q4", "q5"]))


def test_query_plan_rejects_unknown_variant_kind():
    assert rejects(_model("QueryPlan"), _plan(variants=[_variant(kind="paraphrase")]))


def test_query_plan_rejects_sub_question_variant_without_index():
    assert rejects(_model("QueryPlan"), _plan(variants=[_variant(kind="sub_question", sub_question_index=None)]))


def test_query_plan_rejects_sub_question_index_beyond_sub_questions():
    assert rejects(_model("QueryPlan"), _plan(variants=[_variant(kind="sub_question", sub_question_index=3)]))


def test_query_plan_rejects_unknown_framework():
    assert rejects(_model("QueryPlan"), _plan(framework="haystack"))


def test_query_plan_rejects_unknown_skip_reason():
    assert rejects(_model("QueryPlan"), _plan(skipped=[{"transform": "expand", "reason": "bored"}]))


def test_query_plan_accepts_every_variant_kind():
    plan = _model("QueryPlan")
    for kind in ["original", "condensed", "expanded", "hyde", "translated"]:
        assert accepts(plan, _plan(variants=[_variant(kind=kind)])), kind


def test_date_range_rejects_reversed_dates():
    assert rejects(
        _model("QueryPlan"),
        _plan(date_range={"from_date": "2026-02-01", "to_date": "2026-01-01", "include_undated": False, "time_zone": "UTC"}),
    )


# --- Task 1: LLM output models (strict structured output)


def test_llm_output_schemas_are_strict_output_safe():
    for name in LLM_OUTPUT_MODELS:
        model = _model(name)
        assert model is not None, name
        schema = model.model_json_schema()
        properties = set(schema.get("properties", {}))
        assert properties, name
        assert set(schema.get("required", [])) == properties, name
        assert schema.get("additionalProperties") is False, name


def test_llm_output_models_have_no_defaults():
    for name in LLM_OUTPUT_MODELS:
        model = _model(name)
        assert model is not None, name
        assert all(field.is_required() for field in model.model_fields.values()), name


def test_query_variants_cap_at_four():
    variants = _model("QueryVariants")
    assert accepts(variants, {"queries": ["a", "b", "c", "d"]})
    assert rejects(variants, {"queries": ["a", "b", "c", "d", "e"]})


def test_sub_questions_cap_at_four():
    sub = _model("SubQuestions")
    assert accepts(sub, {"questions": ["a", "b", "c", "d"]})
    assert rejects(sub, {"questions": ["a", "b", "c", "d", "e"]})


def test_query_translation_carries_target_language_and_text():
    translation = _model("QueryTranslation")
    assert accepts(translation, {"target_language": "it", "text": "placeholder"})
    assert rejects(translation, {"target_language": "fr", "text": "placeholder"})
    assert rejects(translation, {"text": "placeholder"})


def test_condensed_and_hypothetical_shapes():
    assert accepts(_model("CondensedQuery"), {"standalone": "placeholder", "unchanged": False})
    assert rejects(_model("CondensedQuery"), {"standalone": "placeholder"})
    assert accepts(_model("HypotheticalDocument"), {"passage": "placeholder passage"})
    assert rejects(_model("HypotheticalDocument"), {"passage": "placeholder", "extra": 1})


# --- Task 1: QueryParams


def test_query_params_defaults_validate():
    params = _model("QueryParams")
    assert accepts(params, {})
    assert params is not None
    data = params().model_dump(mode="json")
    assert data["max_llm_variants"] == 2
    assert data["max_translations"] == 2
    assert data["max_sub_questions"] == 4
    assert data["max_searches"] == 8
    assert data["variant_max_chars"] == 500
    assert data["variant_max_ratio"] == 4.0
    assert data["history_turns"] == 6
    assert data["history_turn_chars"] == 1000
    assert data["group_deadline_ms"] == 900
    assert data["query_budget_ms"] == {"chat": 1200, "embed": 1200, "voice": 300}


def test_query_params_enforce_d08_upper_limits():
    params = _model("QueryParams")
    assert rejects(params, {"max_llm_variants": 3})
    assert rejects(params, {"max_translations": 3})
    assert rejects(params, {"max_sub_questions": 5})
    assert rejects(params, {"max_searches": 9})


# --- Task 2: stage names, run options, trace


def test_new_stage_names_are_accepted_everywhere():
    from rag_sidecar.contracts.eval_run import RagRunOptions, StageTimeoutsMs

    for stage in NEW_STAGES:
        assert accepts(StageTimeoutsMs, {stage: 500}), stage
        assert accepts(RagRunOptions, {"disabled_stages": [stage]}), stage


def test_disabled_stages_accepts_the_full_stage_set():
    from typing import get_args

    from rag_sidecar.contracts.eval_run import RagRunOptions, StageName

    stages = list(get_args(StageName))
    assert set(NEW_STAGES) <= set(stages)
    assert accepts(RagRunOptions, {"disabled_stages": stages})


def test_run_options_accept_query_layer_overrides():
    from rag_sidecar.contracts.eval_run import RagRunOptions

    payload = {
        "query_framework": "langchain",
        "query_layer": True,
        "query_transforms": {"expand": False, "hyde": True},
        "semantic_cache": "pgvector",
        "query_params": {"max_sub_questions": 2},
        "cache_seed_answer": "placeholder answer",
    }
    assert accepts(RagRunOptions, payload)
    options = RagRunOptions()
    for field in ["query_framework", "query_layer", "query_transforms", "semantic_cache", "query_params", "cache_seed_answer"]:
        assert getattr(options, field, "missing") is None, field


def test_run_options_reject_bad_query_overrides():
    from rag_sidecar.contracts.eval_run import RagRunOptions

    assert rejects(RagRunOptions, {"query_params": {"max_sub_questions": 5}})
    assert rejects(RagRunOptions, {"query_params": {"max_searches": 9}})
    assert rejects(RagRunOptions, {"query_params": {"unknown_knob": 1}})
    assert rejects(RagRunOptions, {"query_framework": "other"})
    assert rejects(RagRunOptions, {"query_transforms": {"summarize": True}})
    assert rejects(RagRunOptions, {"semantic_cache": "memcached"})
    assert rejects(RagRunOptions, {"cache_seed_answer": "x" * 4001})
    assert accepts(RagRunOptions, {"cache_seed_answer": "x" * 4000})


def test_rag_trace_accepts_query_plan_none_and_full():
    from rag_sidecar.contracts.eval_run import RagTrace

    sample = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))["samples"]["RagTrace"]
    assert "query_plan" in RagTrace.model_fields
    assert RagTrace.model_validate(sample).query_plan is None
    assert accepts(RagTrace, {**sample, "query_plan": None})
    assert accepts(RagTrace, {**sample, "query_plan": _plan()})


def test_every_committed_sample_still_validates():
    from rag_sidecar.export_schemas import CONTRACTS

    by_name = {model.__name__: model for model, _mode in CONTRACTS}
    payload = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))
    for name, value in payload["samples"].items():
        assert accepts(by_name[name], value), name
    for key, variant in payload["variants"].items():
        assert accepts(by_name[variant["model"]], variant["value"]), key


# --- Task 2: retrieval fields


def test_retrieval_params_sub_question_coverage_defaults_true():
    from rag_sidecar.contracts.retrieval import RetrievalParams

    assert getattr(RetrievalParams(), "sub_question_coverage", None) is True
    assert accepts(RetrievalParams, {"sub_question_coverage": False})


def test_committed_retrieval_params_validates():
    from rag_sidecar.contracts.retrieval import RetrievalParams

    model = RetrievalParams.model_validate_json(RETRIEVAL_PARAMS_PATH.read_text(encoding="utf-8"))
    assert getattr(model, "sub_question_coverage", None) is True


def test_date_range_include_undated_defaults_false():
    from rag_sidecar.contracts.retrieval import RetrievalFilters

    filters = RetrievalFilters.model_validate({"date_range": {"from": "2026-01-01", "to": "2026-01-31"}})
    assert filters.date_range is not None
    assert getattr(filters.date_range, "include_undated", None) is False
    with_undated = RetrievalFilters.model_validate(
        {"date_range": {"from": "2026-01-01", "to": "2026-01-31", "include_undated": True}}
    )
    assert getattr(with_undated.date_range, "include_undated", None) is True


def test_trace_query_transform_carries_transform_status_and_reason() -> None:
    from rag_sidecar.contracts.eval_run import TraceQueryTransform

    assert accepts(TraceQueryTransform, {"kind": "rewrite", "text": "neutral text"})
    assert accepts(
        TraceQueryTransform,
        {"kind": "none", "text": "", "transform": "expand", "status": "disabled", "reason": "disabled"},
    )
    assert accepts(
        TraceQueryTransform,
        {"kind": "sub_question", "text": "neutral text", "transform": "decompose", "status": "ok", "reason": None},
    )
    assert rejects(TraceQueryTransform, {"kind": "none", "text": "", "transform": "summarize"})
    assert rejects(TraceQueryTransform, {"kind": "none", "text": "", "status": "pending"})
    assert rejects(TraceQueryTransform, {"kind": "none", "text": "", "reason": "x" * 65})
