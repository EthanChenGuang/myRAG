from fastapi import APIRouter

from rag_sidecar.cache.service import CacheService
from rag_sidecar.settings import SidecarSettings

__all__ = ["CacheService", "build_cache_router"]


def build_cache_router(settings: SidecarSettings, service: object | None = None) -> APIRouter:
    return APIRouter()
