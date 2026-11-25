from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS

QUERY_CONTRACTS = {
    "RewriteGateResult": "validation",
    "QueryPlan": "serialization",
    "CondensedQuery": "validation",
    "QueryVariants": "validation",
    "HypotheticalDocument": "validation",
    "SubQuestions": "validation",
    "QueryTranslation": "validation",
    "QueryParams": "validation",
}

LLM_OUTPUTS = ["CondensedQuery", "QueryVariants", "HypotheticalDocument", "SubQuestions", "QueryTranslation"]


def _registered() -> dict[str, tuple[type, str]]:
    return {model.__name__: (model, mode) for model, mode in CONTRACTS}


def test_query_contracts_are_exported_in_the_planned_mode():
    registered = _registered()
    for name, mode in QUERY_CONTRACTS.items():
        assert name in registered, name
        assert registered[name][1] == mode, name


def test_llm_output_schemas_are_strict_structured_output_compatible():
    registered = _registered()
    for name in LLM_OUTPUTS:
        assert name in registered, name
        model, mode = registered[name]
        schema = model.model_json_schema(mode=mode)
        assert schema["additionalProperties"] is False, name
        assert sorted(schema["required"]) == sorted(schema["properties"]), name
        assert "$defs" not in schema, name


def test_query_samples_validate_and_keep_protected_tokens():
    built = build_samples()
    registered = _registered()
    for name in QUERY_CONTRACTS:
        assert name in built["samples"], name
        model, _mode = registered[name]
        value = built["samples"][name]
        assert model.model_validate(value).model_dump(mode="json") == value
    assert "ERR_TIMEOUT" in built["samples"]["CondensedQuery"]["standalone"]
    assert "ERR_TIMEOUT" in built["samples"]["RewriteGateResult"]["protected_tokens"]


def test_trace_and_request_variants_carry_query_layer_fields():
    built = build_samples()
    registered = _registered()
    assert "RagTrace:query_plan" in built["variants"]
    assert "RagRunRequest:query_overrides" in built["variants"]

    trace_value = built["variants"]["RagTrace:query_plan"]["value"]
    trace = registered["RagTrace"][0].model_validate(trace_value)
    assert trace.query_plan is not None
    assert {variant.kind for variant in trace.query_plan.variants} >= {"original", "sub_question"}

    request_value = built["variants"]["RagRunRequest:query_overrides"]["value"]
    options = registered["RagRunRequest"][0].model_validate(request_value).options
    assert options.query_framework is not None
    assert options.query_layer is not None
    assert options.query_transforms is not None
    assert options.semantic_cache is not None
    assert options.query_params is not None
