import logging
import time
from collections.abc import Callable

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from rag_sidecar.contracts import ProviderTestRequest, ProviderTestResult, SidecarError
from rag_sidecar.contracts.sidecar import ProviderTestCode
from rag_sidecar.groundedness.scorer import ScorerUnavailable
from rag_sidecar.groundedness.vectara import VectaraScorer
from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.providers_test")

PROVIDER_TEST_TIMEOUT_S = 10.0
PROBE_TEXT = "ok"
MAX_BODY_BYTES = 1024

# The only text a result carries; the app words each code itself and never shows vendor text.
MESSAGES: dict[str, str] = {
    "ok": "Connected.",
    "not_configured": "Not tested: the running app has no key or URL for this provider.",
    "unauthorized": "The provider refused the key.",
    "timeout": "No answer within 10 seconds.",
    "unreachable": "The provider could not be reached.",
    "rate_limited": "The provider is rate limiting requests.",
    "provider_error": "The provider answered with an error.",
    "bad_response": "The provider answered with an unexpected response.",
}

TransportFactory = Callable[[], httpx.AsyncBaseTransport | None]


def default_transport() -> httpx.AsyncBaseTransport | None:
    """The real network; tests replace it with a mock transport."""
    return None


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status, content=SidecarError(error=message).model_dump(mode="json")
    )


def _code_for(reason: str) -> ProviderTestCode:
    if reason == "vectara_not_configured":
        return "not_configured"
    if reason == "vectara_timeout":
        return "timeout"
    if reason == "vectara_network_error":
        return "unreachable"
    if reason == "vectara_bad_response":
        return "bad_response"
    if reason in ("vectara_http_401", "vectara_http_403"):
        return "unauthorized"
    if reason == "vectara_http_429":
        return "rate_limited"
    return "provider_error"


def _result(code: ProviderTestCode, latency_ms: int) -> ProviderTestResult:
    return ProviderTestResult(
        provider="vectara",
        ok=code == "ok",
        latencyMs=latency_ms,
        code=code,
        message=MESSAGES[code],
    )


async def probe_vectara(settings: SidecarSettings, transport: httpx.AsyncBaseTransport | None = None) -> ProviderTestResult:
    raise NotImplementedError


def build_providers_test_router(settings: SidecarSettings, transport: TransportFactory | None = None) -> APIRouter:
    router = APIRouter()

    @router.post("/providers/test")
    async def provider_test(request: Request) -> JSONResponse:
        return _error(501, "not_implemented")

    return router
