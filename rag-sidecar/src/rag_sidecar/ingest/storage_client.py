"""Supabase Storage REST client for originals and parse-cache objects."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import httpx

from rag_sidecar.contracts.queue import OriginalRef
from rag_sidecar.ingest.supabase_headers import supabase_headers

_DEFAULT_CONNECT_TIMEOUT = 10.0
_DEFAULT_READ_TIMEOUT = 120.0


class StorageError(Exception):
    """Storage operation failed."""


class StoragePathError(StorageError):
    """Object path was outside the allowed prefix."""


class StorageClient:
    def __init__(
        self,
        *,
        base_url: str,
        service_key: str,
        client: httpx.AsyncClient | None = None,
        connect_timeout: float = _DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = _DEFAULT_READ_TIMEOUT,
    ) -> None:
        if not base_url.strip():
            raise ValueError("base_url must not be empty")
        self._base_url = base_url.rstrip("/")
        self._service_key = service_key
        self._allowed_prefixes: set[str] = set()
        self._owns_client = client is None
        timeout = httpx.Timeout(connect=connect_timeout, read=read_timeout, write=read_timeout, pool=connect_timeout)
        self._client = client or httpx.AsyncClient(timeout=timeout)

    def __repr__(self) -> str:
        return f"StorageClient(base_url={self._base_url!r})"

    def register_cache_prefix(self, prefix: str) -> None:
        normalized = prefix if prefix.endswith("/") else f"{prefix}/"
        self._allowed_prefixes.add(normalized)

    def clear_allowed_prefixes(self) -> None:
        self._allowed_prefixes.clear()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _headers(self, *, content_type: str | None = "application/json") -> dict[str, str]:
        if content_type is None:
            return {k: v for k, v in supabase_headers(self._service_key, content_type="").items() if k != "Content-Type"}
        return supabase_headers(self._service_key, content_type=content_type)

    @staticmethod
    def _validate_object_name(name: str) -> None:
        if not name or "/" in name or ".." in name:
            raise StoragePathError("object name must be a single path segment")

    def _assert_cache_prefix(self, prefix: str) -> None:
        normalized = prefix if prefix.endswith("/") else f"{prefix}/"
        if normalized not in self._allowed_prefixes:
            raise StoragePathError("cache prefix is not registered for this job")

    async def download(self, original_ref: OriginalRef, *, dest_dir: Path | None = None) -> Path:
        url = f"{self._base_url}/storage/v1/object/{original_ref.bucket}/{original_ref.path}"
        headers = self._headers(content_type=None)
        try:
            response = await self._client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise StorageError("storage download failed") from exc
        if response.status_code >= 400:
            raise StorageError(f"storage download returned {response.status_code}")
        target_dir = dest_dir or Path(tempfile.mkdtemp(prefix="rag-ingest-"))
        target_dir.mkdir(parents=True, exist_ok=True)
        name = Path(original_ref.path).name or "original.bin"
        out = target_dir / name
        out.write_bytes(response.content)
        return out

    async def get_bytes(self, bucket: str, path: str) -> bytes:
        url = f"{self._base_url}/storage/v1/object/{bucket}/{path}"
        headers = self._headers(content_type=None)
        try:
            response = await self._client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise StorageError("storage read failed") from exc
        if response.status_code >= 400:
            raise StorageError(f"storage read returned {response.status_code}")
        return response.content

    async def put(self, bucket: str, prefix: str, name: str, data: bytes) -> None:
        self._validate_object_name(name)
        self._assert_cache_prefix(prefix)
        object_path = f"{prefix.rstrip('/')}/{name}"
        url = f"{self._base_url}/storage/v1/object/{bucket}/{object_path}"
        headers = self._headers(content_type="application/octet-stream")
        # Cache objects are named by their key, so a resumed job that writes one again writes the same bytes.
        headers["x-upsert"] = "true"
        try:
            response = await self._client.post(url, content=data, headers=headers)
        except httpx.HTTPError as exc:
            raise StorageError("storage upload failed") from exc
        if response.status_code >= 400:
            raise StorageError(f"storage upload returned {response.status_code}")