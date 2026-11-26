import logging
import threading
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from rag_sidecar.cache.service import CacheBackendUnavailable, CacheService, CacheVectorMismatch, RefusalNotCached
from rag_sidecar.contracts import (
    CacheCheckRequest,
    CacheCheckResponse,
    CacheInvalidateRequest,
    CacheInvalidateResponse,
    CacheStoreRequest,
    SidecarError,
)
from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.cache")

MAX_BODY_BYTES = 2 * 1024 * 1024


class _Unavailable(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=SidecarError(error=message).model_dump(mode="json"))


def build_cache_router(settings: SidecarSettings, service: Any = None) -> APIRouter:
    """POST /cache/check, /cache/store and /cache/invalidate (D-35); the app's SharedSecretMiddleware guards every /v1 path."""
    router = APIRouter()
    lock = threading.Lock()
    state: dict[str, Any] = {"service": service}

    def resolve() -> Any:
        if settings.redis_url is None or not settings.redis_url.get_secret_value().strip():
            raise _Unavailable("semantic_cache_not_configured")
        with lock:
            if state["service"] is None:
                try:
                    state["service"] = CacheService(settings.redis_url.get_secret_value())
                except CacheBackendUnavailable:
                    raise _Unavailable("semantic_cache_unavailable") from None
            return state["service"]

    async def handle(request: Request, model: type[BaseModel], operation: str) -> Response:
        try:
            active = resolve()
        except _Unavailable as unavailable:
            return _error(503, unavailable.reason)
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return _error(413, "cache_request_too_large")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                return _error(413, "cache_request_too_large")
        try:
            payload = model.model_validate_json(bytes(body))
        except (ValidationError, ValueError):
            return _error(422, "invalid_cache_request")
        try:
            result = await run_in_threadpool(getattr(active, operation), payload)
        except RefusalNotCached:
            return _error(422, "refusal_not_cached")
        except CacheVectorMismatch:
            return _error(422, "vector_dimension_mismatch")
        except Exception as failure:
            logger.warning("[Semantic Cache] backend failed", extra={"operation": operation, "error": type(failure).__name__})
            return _error(503, "semantic_cache_backend_error")
        if result is None:
            return Response(status_code=204)
        return JSONResponse(content=result.model_dump(mode="json"))

    @router.post("/cache/check", response_model=CacheCheckResponse)
    async def cache_check(request: Request) -> Response:
        return await handle(request, CacheCheckRequest, "check")

    @router.post("/cache/store", status_code=204)
    async def cache_store(request: Request) -> Response:
        return await handle(request, CacheStoreRequest, "store")

    @router.post("/cache/invalidate", response_model=CacheInvalidateResponse)
    async def cache_invalidate(request: Request) -> Response:
        return await handle(request, CacheInvalidateRequest, "invalidate")

    return router
