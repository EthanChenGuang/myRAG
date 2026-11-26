"""RedisVL semantic-cache backend (D-35): one SemanticCache per embedding profile, every lookup scoped by tenant and key hash."""

import threading
from collections.abc import Callable, Iterable
from typing import Any, Protocol

from pydantic import ValidationError

from rag_sidecar.contracts import (
    CacheCheckRequest,
    CacheCheckResponse,
    CachedAnswer,
    CacheInvalidateRequest,
    CacheInvalidateResponse,
    CacheStoreRequest,
)
from rag_sidecar.contracts.cache import CACHE_MAX_DISTANCE

INDEX_PREFIX = "rag_semcache_"
TENANT_FIELD = "tenant_key"
KEY_HASH_FIELD = "key_hash"
FILTERABLE_FIELDS = [{"name": TENANT_FIELD, "type": "tag"}, {"name": KEY_HASH_FIELD, "type": "tag"}]
DEFAULT_PAGE_SIZE = 500
MAX_INVALIDATE_ROUNDS = 10_000


class RefusalNotCached(Exception):
    """A refusal cannot be invalidated in the same transaction as an upload, publish or delete, so RedisVL never stores one."""


class CacheBackendUnavailable(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class CacheVectorMismatch(Exception):
    pass


class _Index(Protocol):
    def query(self, query: Any) -> list[dict[str, Any]]: ...

    def drop_keys(self, keys: list[str]) -> int: ...


class _SemanticCache(Protocol):
    index: Any

    def check(self, **kwargs: Any) -> list[dict[str, Any]]: ...

    def store(self, **kwargs: Any) -> str: ...


class RedisvlQueries:
    """Filters built only through redisvl's escaping builders; tenant keys like o:<uuid> are escaped there."""

    def check_filter(self, tenant_key: str, key_hash: str) -> Any:
        from redisvl.query.filter import Tag

        return (Tag(TENANT_FIELD) == tenant_key) & (Tag(KEY_HASH_FIELD) == key_hash)

    def tenant_query(self, tenant_key: str, page_size: int) -> Any:
        from redisvl.query import FilterQuery
        from redisvl.query.filter import Tag

        return FilterQuery(filter_expression=Tag(TENANT_FIELD) == tenant_key, return_fields=["entry_id"], num_results=page_size)


def index_name(profile_id: str) -> str:
    return f"{INDEX_PREFIX}{profile_id}"


class _RedisvlBackend:
    def __init__(self, redis_url: str) -> None:
        try:
            import redis  # noqa: F401
            import redisvl  # noqa: F401
        except ImportError:
            raise CacheBackendUnavailable("semantic_cache_extra_missing") from None
        self._redis_url = redis_url
        self._client: Any = None
        self._lock = threading.Lock()

    def client(self) -> Any:
        with self._lock:
            if self._client is None:
                from redis import Redis

                self._client = Redis.from_url(self._redis_url)
            return self._client

    def cache(self, name: str, dims: int) -> _SemanticCache:
        from redisvl.extensions.cache.llm import SemanticCache
        from redisvl.utils.vectorize import CustomVectorizer

        zeros = [0.0] * dims

        def _stub(_content: Any, **_kwargs: Any) -> list[float]:
            return list(zeros)

        return SemanticCache(
            name=name,
            distance_threshold=CACHE_MAX_DISTANCE,
            ttl=None,
            vectorizer=CustomVectorizer(embed=_stub),
            filterable_fields=FILTERABLE_FIELDS,
            redis_client=self.client(),
            refresh_ttl_on_hit=False,
        )

    def list_indexes(self) -> list[str]:
        raw = self.client().execute_command("FT._LIST") or []
        return [item.decode() if isinstance(item, bytes) else str(item) for item in raw]

    def open_index(self, name: str) -> _Index:
        from redisvl.index import SearchIndex

        return SearchIndex.from_existing(name, redis_client=self.client())


class CacheService:
    def __init__(
        self,
        redis_url: str,
        *,
        cache_factory: Callable[[str, int], _SemanticCache] | None = None,
        index_lister: Callable[[], Iterable[str]] | None = None,
        index_opener: Callable[[str], _Index] | None = None,
        queries: Any = None,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> None:
        backend: _RedisvlBackend | None = None
        if cache_factory is None or index_lister is None or index_opener is None:
            backend = _RedisvlBackend(redis_url)
        self._cache_factory = cache_factory or backend.cache  # type: ignore[union-attr]
        self._index_lister = index_lister or backend.list_indexes  # type: ignore[union-attr]
        self._index_opener = index_opener or backend.open_index  # type: ignore[union-attr]
        self._queries = queries if queries is not None else RedisvlQueries()
        self._page_size = page_size
        self._caches: dict[str, tuple[int, _SemanticCache]] = {}
        self._lock = threading.Lock()

    def _cache_for(self, profile_id: str, dims: int) -> tuple[str, _SemanticCache]:
        name = index_name(profile_id)
        with self._lock:
            known = self._caches.get(name)
            if known is None:
                try:
                    cache = self._cache_factory(name, dims)
                except ValueError:
                    raise CacheVectorMismatch("vector_dimension_mismatch") from None
                self._caches[name] = (dims, cache)
                return name, cache
        known_dims, cache = known
        if known_dims != dims:
            raise CacheVectorMismatch("vector_dimension_mismatch")
        return name, cache

    def check(self, request: CacheCheckRequest) -> CacheCheckResponse:
        name, cache = self._cache_for(request.embedding_profile_id, len(request.vector))
        hits = cache.check(
            vector=list(request.vector),
            num_results=1,
            distance_threshold=request.max_distance,
            filter_expression=self._queries.check_filter(request.tenant_key, request.key_hash),
        )
        for hit in hits:
            response = self._hit(name, request, hit)
            if response is not None:
                return response
        return CacheCheckResponse(hit=False)

    @staticmethod
    def _hit(name: str, request: CacheCheckRequest, hit: dict[str, Any]) -> CacheCheckResponse | None:
        if hit.get(TENANT_FIELD) != request.tenant_key or hit.get(KEY_HASH_FIELD) != request.key_hash:
            return None
        key = hit.get("key")
        if not isinstance(key, str) or not key.startswith(f"{name}:"):
            return None
        try:
            distance = float(hit["vector_distance"])
            entry_id = str(hit["entry_id"])
            answer = CachedAnswer.model_validate_json(hit["response"])
        except (KeyError, TypeError, ValueError, ValidationError):
            return None
        if answer.is_refusal or distance > request.max_distance or not entry_id:
            return None
        return CacheCheckResponse(hit=True, entry_id=entry_id, distance=max(distance, 0.0), answer=answer)

    def store(self, request: CacheStoreRequest) -> None:
        if request.answer.is_refusal:
            raise RefusalNotCached("refusal_not_cached")
        _, cache = self._cache_for(request.embedding_profile_id, len(request.vector))
        cache.store(
            prompt=request.query_text_masked,
            response=request.answer.model_dump_json(),
            vector=list(request.vector),
            metadata={"source_versions": [entry.model_dump(mode="json") for entry in request.answer.source_versions]},
            filters={TENANT_FIELD: request.tenant_key, KEY_HASH_FIELD: request.key_hash},
            ttl=request.ttl_seconds,
        )

    def invalidate(self, request: CacheInvalidateRequest) -> CacheInvalidateResponse:
        """Drops every entry of the tenant in every profile index; document_ids do not narrow it (over-invalidation is safe)."""
        with self._lock:
            local = {name: cache.index for name, (_, cache) in self._caches.items()}
        names = set(local) | {name for name in self._index_lister() if name.startswith(INDEX_PREFIX)}
        dropped: set[str] = set()
        for name in sorted(names):
            index = local.get(name) or self._index_opener(name)
            for _ in range(MAX_INVALIDATE_ROUNDS):
                rows = index.query(self._queries.tenant_query(request.tenant_key, self._page_size))
                keys = [row["id"] for row in rows if isinstance(row.get("id"), str) and row["id"] not in dropped]
                if not keys:
                    break
                index.drop_keys(keys)
                dropped.update(keys)
        return CacheInvalidateResponse(deleted=len(dropped))
