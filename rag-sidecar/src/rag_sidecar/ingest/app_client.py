"""Internal app callback client for the ingestion worker (D-07)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Protocol

import httpx
from pydantic import SecretStr

from rag_sidecar.auth import SECRET_HEADER
from rag_sidecar.contracts.queue import (
    AdvanceRequest,
    AdvanceResponse,
    DetectVlmRequest,
    DetectVlmResponse,
    ParseExternalRequest,
    ParseExternalResponse,
    TranslateCallbackRequest,
    TranslateCallbackResponse,
)

logger = logging.getLogger(__name__)

_DEFAULT_CONNECT_TIMEOUT = 10.0
_DEFAULT_READ_TIMEOUT = 40.0
_MAX_CALLBACK_RETRIES = 3


class AppAuthError(Exception):
    """Callback rejected the sidecar secret."""


class AppTransientError(Exception):
    """Exhausted retries for a transient callback failure."""


class Clock(Protocol):
    def __call__(self) -> float: ...


class TokenBucket:
    """Process-local token bucket with an injectable clock (Pitfall 15)."""

    def __init__(self, rate_per_second: float, clock: Clock | None = None) -> None:
        if rate_per_second <= 0:
            raise ValueError("rate_per_second must be positive")
        self._rate = float(rate_per_second)
        self._clock = clock or time.monotonic
        self._tokens = self._rate
        self._last_refill = self._clock()

    def _refill(self) -> None:
        now = self._clock()
        elapsed = max(0.0, now - self._last_refill)
        if elapsed <= 0:
            return
        self._tokens = min(self._rate, self._tokens + elapsed * self._rate)
        self._last_refill = now

    def try_acquire(self) -> bool:
        self._refill()
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False

    async def acquire(self) -> None:
        while not self.try_acquire():
            await asyncio.sleep(0.001)


class AppClient:
    def __init__(
        self,
        *,
        app_base_url: str,
        secret: SecretStr,
        client: httpx.AsyncClient | None = None,
        token_bucket: TokenBucket | None = None,
        rate_per_second: float = 10.0,
        connect_timeout: float = _DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = _DEFAULT_READ_TIMEOUT,
        clock: Clock | None = None,
    ) -> None:
        if not app_base_url.strip():
            raise ValueError("app_base_url must not be empty")
        self._base_url = app_base_url.rstrip("/")
        self._secret = secret.get_secret_value()
        self._owns_client = client is None
        timeout = httpx.Timeout(connect=connect_timeout, read=read_timeout, write=read_timeout, pool=connect_timeout)
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._bucket = token_bucket or TokenBucket(rate_per_second, clock=clock)

    def __repr__(self) -> str:
        return f"AppClient(base_url={self._base_url!r})"

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            SECRET_HEADER.decode("ascii"): self._secret,
        }

    async def _post_json(self, path: str, body: dict[str, Any]) -> httpx.Response:
        url = f"{self._base_url}{path}"
        return await self._client.post(url, json=body, headers=self._headers())

    async def _call_with_retries(self, path: str, body: dict[str, Any]) -> httpx.Response:
        last_error: Exception | None = None
        for attempt in range(_MAX_CALLBACK_RETRIES):
            try:
                response = await self._post_json(path, body)
            except httpx.TimeoutException as exc:
                last_error = exc
                if attempt + 1 >= _MAX_CALLBACK_RETRIES:
                    raise AppTransientError("callback timeout") from exc
                continue
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt + 1 >= _MAX_CALLBACK_RETRIES:
                    raise AppTransientError("callback transport error") from exc
                continue

            if response.status_code == 401:
                raise AppAuthError("callback unauthorized")
            if response.status_code >= 500 or response.status_code == 504:
                if attempt + 1 >= _MAX_CALLBACK_RETRIES:
                    raise AppTransientError(f"callback returned {response.status_code}")
                continue
            return response

        raise AppTransientError("callback failed") from last_error

    async def detect_vlm(self, job_id: str, request: DetectVlmRequest) -> DetectVlmResponse:
        await self._bucket.acquire()
        body = request.model_dump(mode="json")
        response = await self._call_with_retries(
            f"/api/internal/rag/ingest/jobs/{job_id}/detect-vlm",
            body,
        )
        if response.status_code >= 400:
            raise AppTransientError(f"detect-vlm returned {response.status_code}")
        return DetectVlmResponse.model_validate(response.json())

    async def parse_external(self, job_id: str, request: ParseExternalRequest) -> ParseExternalResponse:
        await self._bucket.acquire()
        body = request.model_dump(mode="json")
        response = await self._call_with_retries(
            f"/api/internal/rag/ingest/jobs/{job_id}/parse-external",
            body,
        )
        if response.status_code >= 400 and response.status_code != 401:
            if response.status_code < 500:
                raise AppTransientError(f"parse-external returned {response.status_code}")
        if response.status_code == 401:
            raise AppAuthError("callback unauthorized")
        return ParseExternalResponse.model_validate(response.json())

    async def advance(self, job_id: str, request: AdvanceRequest) -> AdvanceResponse:
        await self._bucket.acquire()
        body = request.model_dump(mode="json")
        response = await self._call_with_retries(
            f"/api/internal/rag/ingest/jobs/{job_id}/advance",
            body,
        )
        if response.status_code == 401:
            raise AppAuthError("callback unauthorized")
        if response.status_code >= 400:
            raise AppTransientError(f"advance returned {response.status_code}")
        return AdvanceResponse.model_validate(response.json())
    async def translate(self, job_id: str, request: TranslateCallbackRequest) -> TranslateCallbackResponse:
        raise AppTransientError("translate callback not implemented")
