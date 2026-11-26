import pytest
from pydantic import ValidationError

import rag_sidecar.contracts as contracts
from rag_sidecar.contracts import (
    CacheCheckRequest,
    CacheCheckResponse,
    CachedAnswer,
    CacheInvalidateRequest,
    CacheInvalidateResponse,
    CacheStoreRequest,
    SemanticCacheCalibration,
)
from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN

TENANT_UUID = "0f0e0d0c-0b0a-4908-8706-050403020100"
KEY_HASH = "ab" * 32


def _citation(**overrides):
    base = {
        "n": 1,
        "alias": "S1",
        "chunkIds": ["chunk-1"],
        "documentId": "doc-1",
        "documentName": "placeholder.md",
        "documentVersion": 2,
        "quote": "placeholder quote",
        "quoteHash": "c" * 64,
        "strategy": "chunk-alias",
    }
    base.update(overrides)
    return base


VERIFIED = {
    "status": "scored",
    "scorer": "hhem_2_1_open",
    "score": 0.9,
    "label": "verified",
    "threshold": 0.5,
    "thresholdSource": "default",
    "latencyMs": 12,
    "checkedAt": "2026-11-25T00:00:00Z",
}
NOT_CHECKED = {"status": "not_checked", "label": "not_checked", "reason": "scorer_unavailable"}
UNRELIABLE = {
    "status": "scored",
    "scorer": "hhem_2_1_open",
    "score": 0.2,
    "label": "possibly_unreliable",
    "threshold": 0.5,
    "thresholdSource": "default",
}
PENDING = {"status": "pending"}


def _answer(**overrides):
    base = {
        "answer_text": "Placeholder answer [S1].",
        "citations": [_citation()],
        "sources": [{"document_id": "doc-1", "name": "placeholder.md", "version": 2}],
        "source_versions": [{"document_id": "doc-1", "version": 2}],
        "answer_language": "en",
        "rag_mode": "strict",
        "is_refusal": False,
        "groundedness": VERIFIED,
        "trace_id": "trace-placeholder-1",
        "created_at": "2026-11-25T00:00:00Z",
    }
    base.update(overrides)
    return base


def _check(**overrides):
    base = {
        "tenant_key": "s:default",
        "key_hash": KEY_HASH,
        "embedding_profile_id": "openai-3-small-1536",
        "vector": [0.1, 0.2, 0.3],
        "max_distance": 0.05,
    }
    base.update(overrides)
    return base


def _store(**overrides):
    base = {
        "tenant_key": f"u:{TENANT_UUID}",
        "key_hash": KEY_HASH,
        "embedding_profile_id": "openai-3-small-1536",
        "query_text_masked": "placeholder masked question",
        "vector": [0.1, 0.2, 0.3],
        "answer": _answer(),
        "ttl_seconds": 3600,
    }
    base.update(overrides)
    return base


def _split(**overrides):
    base = {
        "paraphrase_pairs": 10,
        "near_miss_pairs": 10,
        "paraphrase_hit_rate": 0.8,
        "near_miss_wrong_hit_rate": 0.0,
    }
    base.update(overrides)
    return base


def _cell(**overrides):
    base = {
        "embedding_profile_id": "openai-3-small-1536",
        "max_distance": 0.06,
        "source": "calibrated",
        "fitted_at": "2026-11-25T00:00:00Z",
        "dev": _split(),
        "test": _split(paraphrase_hit_rate=0.7),
    }
    base.update(overrides)
    return base


def test_exports():
    for name in (
        "CachedAnswer",
        "CacheCheckRequest",
        "CacheCheckResponse",
        "CacheStoreRequest",
        "CacheInvalidateRequest",
        "CacheInvalidateResponse",
        "SemanticCacheCalibration",
        "SemanticCacheProfileCalibration",
    ):
        assert name in contracts.__all__


@pytest.mark.parametrize("groundedness", [VERIFIED, NOT_CHECKED])
def test_cached_answer_storable_groundedness_round_trips(groundedness):
    answer = CachedAnswer.model_validate(_answer(groundedness=groundedness))
    dumped = answer.model_dump(mode="json")
    assert CachedAnswer.model_validate(dumped) == answer
    assert dumped["groundedness"] == answer.groundedness.model_dump(mode="json")
    assert answer.groundedness.label == groundedness["label"]


@pytest.mark.parametrize("groundedness", [UNRELIABLE, PENDING])
def test_cached_answer_rejects_unreliable_or_pending(groundedness):
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(_answer(groundedness=groundedness))


def test_cached_answer_citation_documents_need_a_source_version():
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(_answer(citations=[_citation(documentId="doc-2")]))
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(
            _answer(sources=[{"document_id": "doc-2", "name": "other.md", "version": 1}])
        )


def test_cached_answer_rules():
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(_answer(rag_mode="flexible"))
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(_answer(answer_language="fr"))
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(_answer(is_refusal=True))
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(
            _answer(source_versions=[{"document_id": "doc-1", "version": 2}, {"document_id": "doc-1", "version": 3}])
        )
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(_answer(source_versions=[{"document_id": "doc-1", "version": 0}]))
    with pytest.raises(ValidationError):
        CachedAnswer.model_validate(_answer(extra_field=1))
    refusal = CachedAnswer.model_validate(
        _answer(is_refusal=True, citations=[], sources=[], source_versions=[], groundedness=NOT_CHECKED)
    )
    assert refusal.is_refusal is True


@pytest.mark.parametrize(
    "tenant_key",
    ["o:ABC", "x:1", "", f"o:{TENANT_UUID.upper()}", f"u:{TENANT_UUID}\n", "s:Default", f"g:{TENANT_UUID}"],
)
def test_malformed_tenant_keys_fail_in_every_request(tenant_key):
    with pytest.raises(ValidationError):
        CacheCheckRequest.model_validate(_check(tenant_key=tenant_key))
    with pytest.raises(ValidationError):
        CacheStoreRequest.model_validate(_store(tenant_key=tenant_key))
    with pytest.raises(ValidationError):
        CacheInvalidateRequest.model_validate({"tenant_key": tenant_key})


@pytest.mark.parametrize("tenant_key", ["s:default", f"u:{TENANT_UUID}", f"o:{TENANT_UUID}"])
def test_valid_tenant_keys_pass(tenant_key):
    assert CacheCheckRequest.model_validate(_check(tenant_key=tenant_key)).tenant_key == tenant_key
    assert CacheStoreRequest.model_validate(_store(tenant_key=tenant_key)).tenant_key == tenant_key
    assert CacheInvalidateRequest.model_validate({"tenant_key": tenant_key}).tenant_key == tenant_key


def test_tenant_key_pattern_is_one_shared_constant():
    for model in (CacheCheckRequest, CacheStoreRequest, CacheInvalidateRequest):
        schema = model.model_json_schema()
        assert schema["properties"]["tenant_key"]["pattern"] == TENANT_KEY_PATTERN


@pytest.mark.parametrize("key_hash", ["ab" * 31 + "a", "AB" * 32, "g" * 64, "ab" * 32 + "a", ""])
def test_malformed_key_hash_fails(key_hash):
    with pytest.raises(ValidationError):
        CacheCheckRequest.model_validate(_check(key_hash=key_hash))
    with pytest.raises(ValidationError):
        CacheStoreRequest.model_validate(_store(key_hash=key_hash))


def test_check_request_vector_profile_and_distance():
    with pytest.raises(ValidationError):
        CacheCheckRequest.model_validate(_check(vector=[]))
    with pytest.raises(ValidationError):
        CacheCheckRequest.model_validate(_check(vector=[0.1, float("nan")]))
    with pytest.raises(ValidationError):
        CacheCheckRequest.model_validate(_check(max_distance=0.25))
    with pytest.raises(ValidationError):
        CacheCheckRequest.model_validate(_check(max_distance=-0.01))
    with pytest.raises(ValidationError):
        CacheCheckRequest.model_validate(_check(embedding_profile_id="bad profile*"))


def test_check_response_hit_carries_answer_and_distance():
    hit = CacheCheckResponse.model_validate(
        {"hit": True, "entry_id": "entry-1", "distance": 0.01, "answer": _answer()}
    )
    assert hit.answer is not None
    miss = CacheCheckResponse.model_validate({"hit": False})
    assert miss.answer is None and miss.distance is None
    with pytest.raises(ValidationError):
        CacheCheckResponse.model_validate({"hit": True, "entry_id": "entry-1", "distance": 0.01})
    with pytest.raises(ValidationError):
        CacheCheckResponse.model_validate({"hit": False, "answer": _answer()})
    with pytest.raises(ValidationError):
        CacheCheckResponse.model_validate(
            {"hit": True, "entry_id": "entry-1", "distance": 0.01, "answer": _answer(groundedness=UNRELIABLE)}
        )


def test_store_request_requires_text_vector_and_ttl():
    for missing in ("query_text_masked", "vector", "ttl_seconds", "answer"):
        body = _store()
        del body[missing]
        with pytest.raises(ValidationError):
            CacheStoreRequest.model_validate(body)
    with pytest.raises(ValidationError):
        CacheStoreRequest.model_validate(_store(query_text_masked=""))
    for ttl in (0, 86401, -1):
        with pytest.raises(ValidationError):
            CacheStoreRequest.model_validate(_store(ttl_seconds=ttl))
    for ttl in (1, 600, 86400):
        assert CacheStoreRequest.model_validate(_store(ttl_seconds=ttl)).ttl_seconds == ttl


def test_invalidate_request_and_response():
    whole = CacheInvalidateRequest.model_validate({"tenant_key": "s:default"})
    assert whole.document_ids is None
    some = CacheInvalidateRequest.model_validate({"tenant_key": "s:default", "document_ids": ["doc-1"]})
    assert some.document_ids == ["doc-1"]
    with pytest.raises(ValidationError):
        CacheInvalidateRequest.model_validate({"tenant_key": "s:default", "document_ids": []})
    with pytest.raises(ValidationError):
        CacheInvalidateRequest.model_validate({"tenant_key": "s:default", "document_ids": [""]})
    assert CacheInvalidateResponse.model_validate({"deleted": 0}).deleted == 0
    with pytest.raises(ValidationError):
        CacheInvalidateResponse.model_validate({"deleted": -1})


def test_calibration_valid_file_round_trips():
    calibration = SemanticCacheCalibration.model_validate(
        {
            "schema_version": 1,
            "profiles": [
                _cell(),
                _cell(embedding_profile_id="other-profile", source="default", max_distance=0.05, fitted_at=None, dev=None, test=None),
            ],
        }
    )
    assert SemanticCacheCalibration.model_validate(calibration.model_dump(mode="json")) == calibration
    assert SemanticCacheCalibration.model_validate({"schema_version": 1}).profiles == []


def test_calibration_rejects_wide_distance_and_near_miss_hits():
    with pytest.raises(ValidationError):
        SemanticCacheCalibration.model_validate({"profiles": [_cell(max_distance=0.21)]})
    with pytest.raises(ValidationError):
        SemanticCacheCalibration.model_validate({"profiles": [_cell(dev=_split(near_miss_wrong_hit_rate=0.1))]})
    with pytest.raises(ValidationError):
        SemanticCacheCalibration.model_validate({"profiles": [_cell(test=_split(near_miss_wrong_hit_rate=0.05))]})
    with pytest.raises(ValidationError):
        SemanticCacheCalibration.model_validate({"profiles": [_cell(test=None)]})
    with pytest.raises(ValidationError):
        SemanticCacheCalibration.model_validate({"profiles": [_cell(dev=_split(near_miss_pairs=0))]})
    with pytest.raises(ValidationError):
        SemanticCacheCalibration.model_validate({"profiles": [_cell(), _cell(max_distance=0.04)]})
    with pytest.raises(ValidationError):
        SemanticCacheCalibration.model_validate({"profiles": [_cell(dev=_split(paraphrase_hit_rate=1.2))]})


def _pair(**overrides):
    row = {
        "pair_id": "en-cache-paraphrase-009",
        "anchor_id": "en-general-009",
        "category": "cache_paraphrase",
        "split": "dev",
        "language": "en",
        "outcome": "hit",
        "hit": True,
        "distance": 0.02,
    }
    row.update(overrides)
    return row


def test_cache_pairs_run_validates_rows():
    from rag_sidecar.contracts import CachePairsRun

    run = CachePairsRun.model_validate({"source": "fixture", "probe_max_distance": 0.2, "pairs": [_pair()]})
    assert run.pairs[0].hit is True
    bypass = _pair(outcome="bypass", hit=False, distance=None, bypass_reason="protected_tokens", category="cache_near_miss")
    assert CachePairsRun.model_validate({"source": "fixture", "probe_max_distance": 0.2, "pairs": [bypass]}).pairs[0].bypass_reason


@pytest.mark.parametrize(
    "row",
    [
        _pair(hit=False),
        _pair(distance=None),
        _pair(outcome="bypass", hit=False, distance=None),
        _pair(outcome="miss", hit=False, distance=None, bypass_reason="tools"),
        _pair(distance=0.15),
    ],
)
def test_cache_pairs_run_rejects_inconsistent_rows(row):
    from rag_sidecar.contracts import CachePairsRun

    with pytest.raises(ValidationError):
        CachePairsRun.model_validate({"source": "fixture", "probe_max_distance": 0.1, "pairs": [row]})


def test_cache_pairs_run_rejects_duplicate_pairs():
    from rag_sidecar.contracts import CachePairsRun

    with pytest.raises(ValidationError):
        CachePairsRun.model_validate({"source": "fixture", "probe_max_distance": 0.2, "pairs": [_pair(), _pair()]})
