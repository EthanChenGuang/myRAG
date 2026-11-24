"""PostgREST RPC client for the ingestion ledger (D-04)."""

from __future__ import annotations

import logging
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.queue import IngestionJob
from rag_sidecar.ingest.supabase_headers import supabase_headers
from rag_sidecar.ingest.supabase_url import assert_supabase_api_url

logger = logging.getLogger(__name__)

_DEFAULT_CONNECT_TIMEOUT = 10.0
_DEFAULT_READ_TIMEOUT = 30.0


class LedgerError(Exception):
    """Unexpected ledger RPC failure."""


class LeaseLost(LedgerError):
    """Another worker holds the lease, or it expired (SQLSTATE 55000)."""


class Refused(LedgerError):
    """The server refused the request (SQLSTATE 22023)."""


class Transient(LedgerError):
    """A retryable transport or server error."""


class ParseCacheEntry(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    id: str
    tenant_key: str
    file_sha256: str
    parser: str
    parser_version: str
    options_hash: str
    object_prefix: str
    result: dict[str, Any] = Field(default_factory=dict)
    byte_size: int | None = None


_STRIPPED_JOB_COLUMNS = ("error",)


def _job_from_row(row: Any) -> IngestionJob:
    """Validates a table row: the contract leaves out the error column and models an absent detect_counts as null, not {}."""
    if isinstance(row, dict):
        row = {key: value for key, value in row.items() if key not in _STRIPPED_JOB_COLUMNS}
        if row.get("detect_counts") == {}:
            row["detect_counts"] = None
    return IngestionJob.model_validate(row)


def _error_code(payload: Any) -> str | None:
    if isinstance(payload, dict):
        code = payload.get("code")
        if isinstance(code, str):
            return code
    return None


def _map_error(status: int, payload: Any) -> LedgerError:
    code = _error_code(payload)
    message = payload.get("message", "ledger rpc error") if isinstance(payload, dict) else "ledger rpc error"
    if code == "55000":
        return LeaseLost(message)
    if code == "22023":
        return Refused(message)
    if status >= 500:
        return Transient(message)
    return LedgerError(message)


class LedgerClient:
    """Typed wrapper over ingestion ledger and parse-cache RPCs."""

    def __init__(
        self,
        *,
        base_url: str,
        service_key: str,
        client: httpx.AsyncClient | None = None,
        connect_timeout: float = _DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = _DEFAULT_READ_TIMEOUT,
    ) -> None:
        api = assert_supabase_api_url(base_url, label="NEXT_PUBLIC_SUPABASE_URL")
        self._base_url = api.rstrip("/")
        self._service_key = service_key
        self._owns_client = client is None
        timeout = httpx.Timeout(connect=connect_timeout, read=read_timeout, write=read_timeout, pool=connect_timeout)
        self._client = client or httpx.AsyncClient(timeout=timeout)

    def __repr__(self) -> str:
        return f"LedgerClient(base_url={self._base_url!r})"

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> LedgerClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _rpc(self, fn: str, body: dict[str, Any]) -> Any:
        if "tenant" in body or "tenant_key" in body:
            raise ValueError("ledger rpc bodies must not carry tenant fields")
        url = f"{self._base_url}/rest/v1/rpc/{fn}"
        headers = supabase_headers(self._service_key)
        try:
            response = await self._client.post(url, json=body, headers=headers)
        except httpx.TimeoutException as exc:
            raise Transient("ledger rpc timeout") from exc
        except httpx.HTTPError as exc:
            raise Transient("ledger rpc transport error") from exc

        if response.status_code < 400:
            if response.status_code == 204 or not response.content:
                return None
            return response.json()

        try:
            payload: Any = response.json()
        except ValueError:
            payload = {"message": response.reason_phrase or "error"}
        raise _map_error(response.status_code, payload)

    @staticmethod
    def _rows(payload: Any) -> list[Any]:
        if payload is None:
            return []
        if isinstance(payload, list):
            return payload
        return [payload]

    async def claim(
        self,
        *,
        worker: str,
        limit: int,
        allow_batch: bool,
        runner: str = "worker",
    ) -> list[IngestionJob]:
        payload = await self._rpc(
            "rag_claim_ingestion_jobs",
            {
                "p_worker": worker,
                "p_limit": limit,
                "p_allow_batch": allow_batch,
                "p_runner": runner,
            },
        )
        return [_job_from_row(row) for row in self._rows(payload)]

    async def claim_one(self, job_id: str, *, worker: str, runner: str = "worker") -> IngestionJob | None:
        payload = await self._rpc(
            "rag_claim_ingestion_job",
            {"p_job_id": job_id, "p_worker": worker, "p_runner": runner},
        )
        rows = self._rows(payload)
        if not rows:
            return None
        return _job_from_row(rows[0])

    async def heartbeat(self, job_id: str, worker: str) -> bool:
        payload = await self._rpc(
            "rag_heartbeat_ingestion_job",
            {"p_job_id": job_id, "p_worker": worker},
        )
        return bool(payload)

    async def release(self, job_id: str, worker: str) -> bool:
        payload = await self._rpc(
            "rag_release_ingestion_job",
            {"p_job_id": job_id, "p_worker": worker},
        )
        return bool(payload)

    async def advance(
        self,
        job_id: str,
        worker: str,
        *,
        stage: str,
        status: str,
        stage_state: dict[str, Any] | None = None,
        timing_ms: int | None = None,
        fields: dict[str, Any] | None = None,
    ) -> IngestionJob:
        body: dict[str, Any] = {
            "p_job_id": job_id,
            "p_worker": worker,
            "p_stage": stage,
            "p_status": status,
        }
        if stage_state is not None:
            body["p_stage_state"] = stage_state
        if timing_ms is not None:
            body["p_timing_ms"] = timing_ms
        if fields is not None:
            body["p_fields"] = fields
        payload = await self._rpc("rag_advance_ingestion_job", body)
        rows = self._rows(payload)
        if not rows:
            raise LedgerError("advance returned no row")
        return _job_from_row(rows[0])

    async def record_attempt(self, job_id: str, worker: str, attempt: dict[str, Any]) -> int:
        payload = await self._rpc(
            "rag_record_parse_attempt",
            {"p_job_id": job_id, "p_worker": worker, "p_attempt": attempt},
        )
        if isinstance(payload, bool):
            return int(payload)
        if isinstance(payload, (int, float)):
            return int(payload)
        rows = self._rows(payload)
        first = rows[0] if rows else None
        if isinstance(first, dict) and len(first) == 1:
            first = next(iter(first.values()))
        if isinstance(first, (int, float)) and not isinstance(first, bool):
            return int(first)
        raise LedgerError("record_attempt returned unexpected payload")

    async def count_dead_letters(self, tenant_key: str | None = None) -> int:
        payload = await self._rpc("rag_count_ingestion_dead_letters", {"p_tenant_key": tenant_key})
        if isinstance(payload, (int, float)):
            return int(payload)
        if isinstance(payload, str) and payload.isdigit():
            return int(payload)
        return 0

    async def purge_stale(self, *, retention_days: int, batch_size: int = 500) -> dict[str, Any]:
        payload = await self._rpc(
            "rag_purge_stale_ingestion_jobs",
            {"p_retention_days": retention_days, "p_batch_size": batch_size},
        )
        return payload if isinstance(payload, dict) else {"archived": 0, "purged": 0}

    async def fail(
        self,
        job_id: str,
        worker: str,
        *,
        error_class: str,
        retryable: bool,
        last_error: str | None = None,
    ) -> IngestionJob:
        body = {
            "p_job_id": job_id,
            "p_worker": worker,
            "p_error_class": error_class,
            "p_retryable": retryable,
        }
        if last_error is not None:
            body["p_last_error"] = last_error
        payload = await self._rpc("rag_fail_ingestion_job", body)
        rows = self._rows(payload)
        if not rows:
            raise LedgerError("fail returned no row")
        return _job_from_row(rows[0])

    async def cache_prefix(
        self,
        job_id: str,
        parser: str,
        parser_version: str,
        options_hash: str,
    ) -> str | None:
        payload = await self._rpc(
            "rag_parse_cache_prefix",
            {
                "p_job_id": job_id,
                "p_parser": parser,
                "p_parser_version": parser_version,
                "p_options_hash": options_hash,
            },
        )
        if payload is None:
            return None
        if isinstance(payload, str):
            return payload
        rows = self._rows(payload)
        if not rows:
            return None
        value = rows[0]
        return str(value) if value is not None else None

    async def cache_lookup(
        self,
        job_id: str,
        parser: str,
        parser_version: str,
        options_hash: str,
    ) -> list[ParseCacheEntry]:
        payload = await self._rpc(
            "rag_parse_cache_lookup",
            {
                "p_job_id": job_id,
                "p_parser": parser,
                "p_parser_version": parser_version,
                "p_options_hash": options_hash,
            },
        )
        return [ParseCacheEntry.model_validate(row) for row in self._rows(payload)]

    async def cache_put(
        self,
        job_id: str,
        parser: str,
        parser_version: str,
        options_hash: str,
        object_prefix: str,
        *,
        result: dict[str, Any] | None = None,
        byte_size: int | None = None,
    ) -> ParseCacheEntry:
        body: dict[str, Any] = {
            "p_job_id": job_id,
            "p_parser": parser,
            "p_parser_version": parser_version,
            "p_options_hash": options_hash,
            "p_object_prefix": object_prefix,
        }
        if result is not None:
            body["p_result"] = result
        if byte_size is not None:
            body["p_byte_size"] = byte_size
        payload = await self._rpc("rag_parse_cache_put", body)
        rows = self._rows(payload)
        if not rows:
            raise LedgerError("cache_put returned no row")
        return ParseCacheEntry.model_validate(rows[0])