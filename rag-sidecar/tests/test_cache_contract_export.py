from rag_sidecar.contracts import (
    CacheCheckRequest,
    CacheCheckResponse,
    CachedAnswer,
    CacheInvalidateRequest,
    CacheInvalidateResponse,
    CacheStoreRequest,
    GoldenItem,
    RetrievalParams,
    SemanticCacheCalibration,
)
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS

EXPECTED_MODES = {
    CachedAnswer: "serialization",
    CacheCheckRequest: "validation",
    CacheCheckResponse: "serialization",
    CacheStoreRequest: "validation",
    CacheInvalidateRequest: "validation",
    CacheInvalidateResponse: "serialization",
    SemanticCacheCalibration: "serialization",
}


def test_cache_contracts_are_exported_in_their_modes():
    registered = dict(CONTRACTS)
    for model, mode in EXPECTED_MODES.items():
        assert registered.get(model) == mode, model.__name__


def test_cache_samples_use_placeholder_keys():
    samples = build_samples()["samples"]
    for name in ("CacheCheckRequest", "CacheStoreRequest", "CacheInvalidateRequest"):
        assert samples[name]["tenant_key"] == "s:default"
    for name in ("CacheCheckRequest", "CacheStoreRequest"):
        key_hash = samples[name]["key_hash"]
        assert len(key_hash) == 64 and set(key_hash) <= set("0123456789abcdef")
    answer = CachedAnswer.model_validate(samples["CachedAnswer"])
    assert len(answer.citations) == 1
    hit = CacheCheckResponse.model_validate(samples["CacheCheckResponse"])
    assert hit.hit is True and hit.answer is not None


def test_cache_variants_round_trip():
    variants = build_samples()["variants"]
    miss = CacheCheckResponse.model_validate(variants["CacheCheckResponse:miss"]["value"])
    assert miss.hit is False and miss.answer is None
    near_miss = GoldenItem.model_validate(variants["GoldenItem:cache_near_miss"]["value"])
    assert near_miss.category == "cache_near_miss" and near_miss.pair_of
    params = RetrievalParams.model_validate(variants["RetrievalParams:sub_question_coverage_off"]["value"])
    assert params.sub_question_coverage is False
    whole_tenant = CacheInvalidateRequest.model_validate(variants["CacheInvalidateRequest:whole_tenant"]["value"])
    assert whole_tenant.document_ids is None
