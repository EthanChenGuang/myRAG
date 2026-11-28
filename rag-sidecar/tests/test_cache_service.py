import importlib.util
import json

import pytest

from rag_sidecar.cache import INDEX_PREFIX, CacheService, CacheVectorMismatch, RefusalNotCached
from rag_sidecar.contracts import (
    CacheCheckRequest,
    CacheCheckResponse,
    CachedAnswer,
    CacheInvalidateRequest,
    CacheInvalidateResponse,
    CacheStoreRequest,
)

TENANT_A = "o:0f0e0d0c-0b0a-4908-8706-050403020100"
TENANT_B = "u:1a2b3c4d-5e6f-4a0b-8c1d-2e3f4a5b6c7d"
KEY_HASH = "ab" * 32
OTHER_KEY_HASH = "cd" * 32
VECTOR = [0.1, 0.2, 0.3]
REDISVL = importlib.util.find_spec("redisvl") is not None


def _answer(**overrides) -> dict:
    base = {
        "answer_text": "Placeholder answer [S1].",
        "citations": [
            {
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
        ],
        "sources": [{"document_id": "doc-1", "name": "placeholder.md", "version": 2}],
        "source_versions": [{"document_id": "doc-1", "version": 2}],
        "answer_language": "en",
        "rag_mode": "strict",
        "is_refusal": False,
        "groundedness": {"status": "not_checked", "label": "not_checked", "reason": "scorer_unavailable"},
        "trace_id": "trace-1",
        "created_at": "2026-11-25T00:00:00Z",
    }
    base.update(overrides)
    return base


def _store(tenant=TENANT_A, key_hash=KEY_HASH, profile="p1", vector=VECTOR, **answer) -> CacheStoreRequest:
    return CacheStoreRequest(
        tenant_key=tenant,
        key_hash=key_hash,
        embedding_profile_id=profile,
        query_text_masked="placeholder masked question",
        vector=vector,
        answer=CachedAnswer.model_validate(_answer(**answer)),
        ttl_seconds=600,
    )


def _check(tenant=TENANT_A, key_hash=KEY_HASH, profile="p1", vector=VECTOR, max_distance=0.1) -> CacheCheckRequest:
    return CacheCheckRequest(
        tenant_key=tenant, key_hash=key_hash, embedding_profile_id=profile, vector=vector, max_distance=max_distance
    )


class FakeQueries:
    def check_filter(self, tenant_key, key_hash):
        return ("and", ("tenant_key", tenant_key), ("key_hash", key_hash))

    def tenant_query(self, tenant_key, page_size):
        return ("tenant", tenant_key, page_size)


def _matches(expr, entry) -> bool:
    if expr[0] == "and":
        return all(_matches(part, entry) for part in expr[1:])
    field, value = expr
    return entry[field] == value


class FakeRedis:
    """One keyspace shared by every fake index, as in Redis."""

    def __init__(self):
        self.entries: dict[str, dict] = {}


class FakeIndex:
    def __init__(self, redis: FakeRedis, name: str):
        self.redis = redis
        self.name = name
        self.queries: list = []
        self.dropped: list[list[str]] = []

    def _own(self):
        return {key: entry for key, entry in self.redis.entries.items() if key.startswith(self.name)}

    def query(self, query):
        self.queries.append(query)
        _, tenant_key, page_size = query
        rows = [{"id": key} for key, entry in self._own().items() if entry["tenant_key"] == tenant_key]
        return rows[:page_size]

    def drop_keys(self, keys):
        self.dropped.append(list(keys))
        removed = 0
        for key in keys:
            if self.redis.entries.pop(key, None) is not None:
                removed += 1
        return removed


class FakeSemanticCache:
    def __init__(self, redis: FakeRedis, name: str, dims: int):
        self.name = name
        self.dims = dims
        self.redis = redis
        self.index = FakeIndex(redis, name)
        self.check_calls: list[dict] = []
        self.store_calls: list[dict] = []

    def check(self, **kwargs):
        self.check_calls.append(kwargs)
        hits = []
        for key, entry in self.index._own().items():
            if _matches(kwargs["filter_expression"], entry):
                distance = 0.0 if entry["vector"] == kwargs["vector"] else 0.5
                if distance <= kwargs["distance_threshold"]:
                    hits.append(
                        {
                            "key": key,
                            "entry_id": entry["entry_id"],
                            "prompt": entry["prompt"],
                            "response": entry["response"],
                            "vector_distance": distance,
                            "metadata": entry["metadata"],
                            "tenant_key": entry["tenant_key"],
                            "key_hash": entry["key_hash"],
                        }
                    )
        return hits[: kwargs["num_results"]]

    def store(self, **kwargs):
        self.store_calls.append(kwargs)
        entry_id = f"e{len(self.redis.entries) + 1}"
        key = f"{self.name}:{entry_id}"
        self.redis.entries[key] = {
            "entry_id": entry_id,
            "prompt": kwargs["prompt"],
            "response": kwargs["response"],
            "vector": kwargs["vector"],
            "metadata": kwargs["metadata"],
            **kwargs["filters"],
        }
        return key


class Harness:
    def __init__(self):
        self.redis = FakeRedis()
        self.caches: dict[str, FakeSemanticCache] = {}
        self.opened: dict[str, FakeIndex] = {}
        self.extra_indexes: list[str] = []

    def factory(self, name, dims):
        cache = FakeSemanticCache(self.redis, name, dims)
        self.caches[name] = cache
        return cache

    def lister(self):
        return ["unrelated_index", *self.caches, *self.extra_indexes]

    def opener(self, name):
        index = FakeIndex(self.redis, name)
        self.opened[name] = index
        return index

    def service(self) -> CacheService:
        return CacheService(
            "redis://placeholder",
            cache_factory=self.factory,
            index_lister=self.lister,
            index_opener=self.opener,
            queries=FakeQueries(),
        )


def test_check_passes_vector_one_result_threshold_and_both_tag_filters():
    harness = Harness()
    service = harness.service()
    response = service.check(_check(max_distance=0.15))
    assert isinstance(response, CacheCheckResponse)
    assert response.hit is False
    cache = harness.caches[f"{INDEX_PREFIX}p1"]
    assert cache.dims == len(VECTOR)
    [call] = cache.check_calls
    assert call["vector"] == VECTOR
    assert call["num_results"] == 1
    assert call["distance_threshold"] == 0.15
    assert call["filter_expression"] == ("and", ("tenant_key", TENANT_A), ("key_hash", KEY_HASH))


def test_store_passes_masked_prompt_answer_json_metadata_filters_and_ttl_then_hits():
    harness = Harness()
    service = harness.service()
    request = _store()
    service.store(request)
    [call] = harness.caches[f"{INDEX_PREFIX}p1"].store_calls
    assert call["prompt"] == "placeholder masked question"
    assert CachedAnswer.model_validate_json(call["response"]) == request.answer
    assert call["vector"] == VECTOR
    assert call["metadata"] == {"source_versions": [{"document_id": "doc-1", "version": 2}]}
    assert call["filters"] == {"tenant_key": TENANT_A, "key_hash": KEY_HASH}
    assert call["ttl"] == 600

    hit = service.check(_check())
    assert hit.hit is True
    assert hit.entry_id == "e1"
    assert hit.distance == 0.0
    assert hit.answer == request.answer


def test_one_index_per_profile_and_p2_never_queries_p1():
    harness = Harness()
    service = harness.service()
    service.store(_store(profile="p1"))
    response = service.check(_check(profile="p2"))
    assert response.hit is False
    assert harness.caches[f"{INDEX_PREFIX}p1"].check_calls == []
    assert len(harness.caches[f"{INDEX_PREFIX}p2"].check_calls) == 1


def test_tenant_b_misses_tenant_a_entry_and_invalidate_a_keeps_b():
    harness = Harness()
    service = harness.service()
    service.store(_store(tenant=TENANT_A))
    assert service.check(_check(tenant=TENANT_B)).hit is False
    service.store(_store(tenant=TENANT_B))
    assert service.check(_check(tenant=TENANT_B)).hit is True

    result = service.invalidate(CacheInvalidateRequest(tenant_key=TENANT_A))
    assert isinstance(result, CacheInvalidateResponse)
    assert result.deleted == 1
    assert service.check(_check(tenant=TENANT_A)).hit is False
    assert service.check(_check(tenant=TENANT_B)).hit is True


def test_a_different_key_hash_is_a_miss():
    harness = Harness()
    service = harness.service()
    service.store(_store(key_hash=KEY_HASH))
    assert service.check(_check(key_hash=OTHER_KEY_HASH)).hit is False


def test_invalidate_pages_every_profile_index_including_ones_from_before_a_restart():
    harness = Harness()
    first = harness.service()
    for _ in range(3):
        first.store(_store(profile="p1", vector=[0.1, 0.2, 0.3 + _]))
    first.store(_store(profile="p2", vector=[0.4, 0.5]))
    first.store(_store(tenant=TENANT_B, profile="p2", vector=[0.4, 0.5]))

    harness.extra_indexes = []
    restarted_names = list(harness.caches)
    harness.caches = {}
    harness.extra_indexes = restarted_names
    second = harness.service()
    second._page_size = 2
    result = second.invalidate(CacheInvalidateRequest(tenant_key=TENANT_A))
    assert result.deleted == 4
    assert set(harness.opened) == {f"{INDEX_PREFIX}p1", f"{INDEX_PREFIX}p2"}
    assert "unrelated_index" not in harness.opened
    p1 = harness.opened[f"{INDEX_PREFIX}p1"]
    assert all(query == ("tenant", TENANT_A, 2) for query in p1.queries)
    assert sum(len(batch) for batch in p1.dropped) == 3
    remaining = [entry["tenant_key"] for entry in harness.redis.entries.values()]
    assert remaining == [TENANT_B]


def test_invalidate_with_document_ids_still_drops_every_entry_of_the_tenant():
    harness = Harness()
    service = harness.service()
    service.store(_store())
    result = service.invalidate(CacheInvalidateRequest(tenant_key=TENANT_A, document_ids=["doc-other"]))
    assert result.deleted == 1


def test_store_of_a_refusal_raises_and_calls_no_cache_method():
    harness = Harness()
    service = harness.service()
    with pytest.raises(RefusalNotCached):
        service.store(_store(is_refusal=True, citations=[]))
    assert harness.caches == {}
    assert harness.redis.entries == {}


def test_a_stored_refusal_or_invalid_payload_is_never_served():
    harness = Harness()
    service = harness.service()
    service.store(_store())
    [entry] = harness.redis.entries.values()
    entry["response"] = json.dumps(_answer(is_refusal=True, citations=[]))
    assert service.check(_check()).hit is False
    entry["response"] = "not json"
    assert service.check(_check()).hit is False


def test_a_hit_from_another_tenant_tag_or_another_profile_prefix_is_rejected():
    harness = Harness()
    service = harness.service()
    service.store(_store(profile="p1"))
    [entry] = harness.redis.entries.values()
    entry["tenant_key"] = TENANT_A
    cache = harness.caches[f"{INDEX_PREFIX}p1"]
    original = cache.check

    def leaky_tenant(**kwargs):
        hits = original(**kwargs)
        return [{**hit, "tenant_key": TENANT_B} for hit in hits]

    cache.check = leaky_tenant
    assert service.check(_check()).hit is False

    def leaky_prefix(**kwargs):
        hits = original(**kwargs)
        return [{**hit, "key": f"{INDEX_PREFIX}p10:{hit['entry_id']}"} for hit in hits]

    cache.check = leaky_prefix
    assert service.check(_check()).hit is False


def test_a_vector_of_another_dimension_for_the_same_profile_is_refused():
    harness = Harness()
    service = harness.service()
    service.check(_check(vector=[0.1, 0.2, 0.3]))
    with pytest.raises(CacheVectorMismatch):
        service.check(_check(vector=[0.1, 0.2]))


@pytest.mark.skipif(not REDISVL, reason="the cache extra is not installed")
def test_import_paths_match_the_installed_redisvl_wheel_and_tags_are_escaped():
    from redisvl.extensions.cache.llm import SemanticCache
    from redisvl.query import FilterQuery
    from redisvl.query.filter import Tag
    from redisvl.utils.vectorize import CustomVectorizer

    from rag_sidecar.cache import RedisvlQueries

    assert SemanticCache and CustomVectorizer and Tag and FilterQuery
    queries = RedisvlQueries()
    rendered = str(queries.check_filter("o:0a1b2c3d-0000-4000-8000-00000000abcd", KEY_HASH))
    assert rendered == (
        r"(@tenant_key:{o\:0a1b2c3d\-0000\-4000\-8000\-00000000abcd} "
        "@key_hash:{" + KEY_HASH + "})"
    )
    query = queries.tenant_query("s:default", 7)
    assert isinstance(query, FilterQuery)
    assert str(query._filter_expression) == r"@tenant_key:{s\:default}"
    assert query._num_results == 7
