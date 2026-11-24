"""Periodic ingestion ledger retention through PostgREST RPC."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from rag_sidecar.ingest.ledger_client import LedgerClient, Transient
from rag_sidecar.ingest.worker_env import WorkerEnv

logger = logging.getLogger(__name__)

_INTERVAL_ENV = "RAG_INGEST_MAINTENANCE_INTERVAL_SECONDS"
_RETENTION_ENV = "RAG_INGEST_JOB_RETENTION_DAYS"
_DEFAULT_INTERVAL = 3600
_DEFAULT_RETENTION = 90
_BATCH = 500


def maintenance_settings(environ: dict[str, str] | None = None) -> tuple[int, int]:
    source = os.environ if environ is None else environ
    raw_interval = (source.get(_INTERVAL_ENV) or "").strip()
    raw_retention = (source.get(_RETENTION_ENV) or "").strip()
    interval = _DEFAULT_INTERVAL
    retention = _DEFAULT_RETENTION
    try:
        if raw_interval:
            parsed = int(raw_interval)
            if parsed >= 60:
                interval = parsed
    except ValueError:
        interval = _DEFAULT_INTERVAL
    try:
        if raw_retention:
            parsed = int(raw_retention)
            if parsed >= 1:
                retention = parsed
    except ValueError:
        retention = _DEFAULT_RETENTION
    return interval, retention


class IngestionMaintenanceLoop:
    def __init__(self, ledger: LedgerClient, *, interval_seconds: int, retention_days: int) -> None:
        self._ledger = ledger
        self._interval = interval_seconds
        self._retention_days = retention_days
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    async def _rpc_purge(self) -> dict[str, Any]:
        return await self._ledger.purge_stale(retention_days=self._retention_days, batch_size=_BATCH)

    async def _run_once(self) -> None:
        try:
            dead = await self._ledger.count_dead_letters()
            if dead > 0:
                logger.warning("[RAG Ingest] ingestion dead letters present count=%s signal=ingestion_dead_letters", dead)
            result = await self._rpc_purge()
            purged = int(result.get("purged", 0))
            if purged > 0:
                logger.info(
                    "[RAG Ingest] maintenance purge purged=%s archived=%s retention_days=%s",
                    purged,
                    result.get("archived", 0),
                    result.get("retention_days", self._retention_days),
                )
        except Transient:
            logger.warning("[RAG Ingest] maintenance purge transient failure")
        except Exception:
            logger.warning("[RAG Ingest] maintenance purge failed", exc_info=False)

    async def _loop(self) -> None:
        while not self._stop.is_set():
            await self._run_once()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._interval)
            except asyncio.TimeoutError:
                continue

    def start(self) -> None:
        if self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="ingest-maintenance")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
            self._task = None


def start_maintenance_from_env(environ: dict[str, str] | None = None) -> IngestionMaintenanceLoop | None:
    source = os.environ if environ is None else environ
    enabled = (source.get("RAG_INGEST_MAINTENANCE") or "on").strip().lower()
    if enabled in ("off", "false", "0", "no"):
        return None
    try:
        worker_env = WorkerEnv.from_env(source)
    except ValueError:
        return None
    interval, retention = maintenance_settings(source)
    ledger = LedgerClient(base_url=worker_env.supabase_url, service_key=worker_env.service_role_key.get_secret_value())
    loop = IngestionMaintenanceLoop(ledger, interval_seconds=interval, retention_days=retention)
    loop.start()
    return loop