from typing import Any

from rag_sidecar.contracts import (
    CacheCheckRequest,
    CacheCheckResponse,
    CacheInvalidateRequest,
    CacheInvalidateResponse,
    CacheStoreRequest,
)

INDEX_PREFIX = "rag_semcache_"


class RefusalNotCached(Exception):
    pass


class CacheBackendUnavailable(Exception):
    pass


class CacheVectorMismatch(Exception):
    pass


class RedisvlQueries:
    def check_filter(self, tenant_key: str, key_hash: str) -> Any:
        return None

    def tenant_query(self, tenant_key: str, page_size: int) -> Any:
        return None


class CacheService:
    def __init__(self, redis_url: str, **_: Any) -> None:
        self._redis_url = redis_url

    def check(self, request: CacheCheckRequest) -> CacheCheckResponse:
        return CacheCheckResponse(hit=False)

    def store(self, request: CacheStoreRequest) -> None:
        return None

    def invalidate(self, request: CacheInvalidateRequest) -> CacheInvalidateResponse:
        return CacheInvalidateResponse(deleted=0)
