from typing import Any

from pydantic import BaseModel, ConfigDict

TENANT_KEY_PATTERN = r".*"


class _Contract(BaseModel):
    model_config = ConfigDict(extra="allow", frozen=True)


class CachedAnswer(_Contract):
    groundedness: Any = None


class CacheCheckRequest(_Contract):
    tenant_key: str = ""


class CacheCheckResponse(_Contract):
    hit: bool = False
    answer: Any = None
    distance: Any = None


class CacheStoreRequest(_Contract):
    tenant_key: str = ""
    ttl_seconds: int = 0


class CacheInvalidateRequest(_Contract):
    tenant_key: str = ""
    document_ids: Any = None


class CacheInvalidateResponse(_Contract):
    deleted: int = 0


class SemanticCacheProfileCalibration(_Contract):
    pass


class SemanticCacheCalibration(_Contract):
    profiles: list[Any] = []
