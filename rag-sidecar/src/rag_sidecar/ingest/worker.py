"""Always-on ingestion worker loop (D-09, D-23, D-24)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Protocol

import httpx

from rag_sidecar.contracts.queue import IngestionJob
from rag_sidecar.ingest.ledger_client import LedgerError, LeaseLost, Transient
from rag_sidecar.ingest.pool import PoolCrashed
from rag_sidecar.ingest.process_job import TERMINAL_SUCCESS, JobOutcome, WorkerDeps, process_job
from rag_sidecar.parse.converter import ConversionError

logger = logging.getLogger(__name__)

POLL_BASE_SECONDS = 2.0
HEARTBEAT_SECONDS = 40.0
SHUTDOWN_WAIT_SECONDS = 10.0
CLAIM_STALE_SECONDS = 60.0
POLL_JITTER = 0.25


class RealClock:
    """Production clock for worker readiness timestamps."""

    def now(self) -> datetime:
        return datetime.now(tz=timezone.utc)

_RETRYABLE = frozenset({"network", "server_5xx", "timeout", "pool_crashed", "callback_transient", "ledger_error"})
_PERMANENT = frozenset(
    {"encrypted_pdf", "unsupported_type", "file_missing", "recorded_miss", "no_parser_available", "refused"}
)


class IngestErrorClass(str, Enum):
    NETWORK = "network"
    SERVER_5XX = "server_5xx"
    TIMEOUT = "timeout"
    POOL_CRASHED = "pool_crashed"
    ENCRYPTED_PDF = "encrypted_pdf"
    UNSUPPORTED_TYPE = "unsupported_type"
    FILE_MISSING = "file_missing"
    RECORDED_MISS = "recorded_miss"


def classify_ingest_error(exc: BaseException) -> tuple[str, bool]:
    if isinstance(exc, PoolCrashed):
        return IngestErrorClass.POOL_CRASHED.value, True
    if type(exc).__name__ == "EncryptedPdf":
        return IngestErrorClass.ENCRYPTED_PDF.value, False
    if isinstance(exc, ConversionError):
        name = exc.error_class
        return name, name not in _PERMANENT
    if isinstance(exc, (Transient, LedgerError, httpx.TimeoutException, httpx.HTTPError)):
        if isinstance(exc, httpx.TimeoutException):
            return IngestErrorClass.TIMEOUT.value, True
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500:
            return IngestErrorClass.SERVER_5XX.value, True
        if isinstance(exc, httpx.HTTPError):
            return IngestErrorClass.NETWORK.value, True
        return "ledger_error", True
    return "worker_error", True


class _WorkerSettings(Protocol):
    ingest_worker_concurrency: int
    worker_id: str


ProcessFn = Callable[[IngestionJob], Awaitable[JobOutcome]]
SleepFn = Callable[[float], Awaitable[None]]


@dataclass
class IngestWorker:
    settings: _WorkerSettings
    ledger: Any
    storage: Any
    app: Any
    pool: Any
    clock: Any
    rng: random.Random
    process_fn: ProcessFn | None = None
    sleep: SleepFn = field(default=asyncio.sleep)
    wake_event: asyncio.Event | None = None
    heartbeat_seconds: float = HEARTBEAT_SECONDS

    def __post_init__(self) -> None:
        self._worker_id = getattr(self.settings, "worker_id", "sidecar-worker")
        self._concurrency = max(1, int(self.settings.ingest_worker_concurrency))
        self._wake = self.wake_event or asyncio.Event()
        self._stop_claiming = False
        self._running = False
        self._job_tasks: dict[str, asyncio.Task[None]] = {}
        self._batch_jobs: set[str] = set()
        self._held_leases: set[str] = set()
        self._last_claim_ok: datetime | None = None
        self._claim_failures_since_ok = False
        self._loop_task: asyncio.Task[None] | None = None

    def wake(self) -> None:
        self._wake.set()

    def readiness(self, *, env_ok: bool) -> tuple[bool, str | None]:
        if not env_ok:
            return False, "worker_env_missing"
        if self._claim_failures_since_ok and self._last_claim_ok is not None:
            now = self._now()
            if now - self._last_claim_ok > timedelta(seconds=CLAIM_STALE_SECONDS):
                return False, "claim_stale"
        return True, None

    def _now(self) -> datetime:
        if hasattr(self.clock, "now"):
            return self.clock.now()
        return datetime.now(tz=timezone.utc)

    async def run(self) -> None:
        self._running = True
        self._stop_claiming = False
        while self._running:
            try:
                if not self._stop_claiming:
                    await self._poll_once()
                await self._poll_sleep(self._jittered_poll())
            except asyncio.CancelledError:
                break

    async def _run_loop_once_for_test(self, *, poll_seconds: float) -> None:
        """Test hook: one poll then a long sleep that wake() can interrupt."""
        await self._poll_once()
        await self._poll_sleep(poll_seconds)

    async def stop(self) -> None:
        self._stop_claiming = True
        self._running = False
        if self._loop_task is not None:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
        deadline = asyncio.get_running_loop().time() + SHUTDOWN_WAIT_SECONDS
        while self._job_tasks and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        for job_id in list(self._held_leases):
            try:
                await self.ledger.release(job_id, self._worker_id)
            except Exception:  # noqa: BLE001
                pass
            self._held_leases.discard(job_id)
        for task in list(self._job_tasks.values()):
            task.cancel()
        if self._job_tasks:
            await asyncio.gather(*self._job_tasks.values(), return_exceptions=True)
        self._job_tasks.clear()
        self._batch_jobs.clear()

    def _jittered_poll(self) -> float:
        spread = POLL_BASE_SECONDS * POLL_JITTER
        return POLL_BASE_SECONDS + self.rng.uniform(-spread, spread)

    async def _poll_sleep(self, seconds: float) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _poll_once(self) -> None:
        free_slots = self._concurrency - len(self._job_tasks)
        if free_slots <= 0:
            return
        try:
            jobs = await self._claim_slots(free_slots)
            if jobs:
                self._last_claim_ok = self._now()
                self._claim_failures_since_ok = False
            for job in jobs:
                self._held_leases.add(job.id)
                if job.batch_id is not None:
                    self._batch_jobs.add(job.id)
                self._job_tasks[job.id] = asyncio.create_task(self._job_loop(job))
        except Exception:  # noqa: BLE001
            self._claim_failures_since_ok = True
            logger.warning("[RAG Ingest] claim failed", exc_info=True)

    def _batch_allowed(self, claimed: list[IngestionJob]) -> bool:
        """Batch jobs hold at most concurrency - 1 slots, so one slot always stays for interactive jobs (D-23).

        A single-slot worker takes a batch job only when it runs nothing else. Uploads still win every claim by priority.
        """
        if self._concurrency == 1:
            return not self._job_tasks and not claimed
        running = len(self._batch_jobs) + sum(1 for job in claimed if job.batch_id is not None)
        return running < self._concurrency - 1

    async def _claim_slots(self, free_slots: int) -> list[IngestionJob]:
        claimed: list[IngestionJob] = []
        slots_left = free_slots
        while slots_left > 0:
            allow_batch = self._batch_allowed(claimed)
            batch = await self.ledger.claim(
                worker=self._worker_id, limit=1, allow_batch=allow_batch, runner="worker"
            )
            if not batch:
                break
            claimed.append(batch[0])
            slots_left -= 1
        return claimed

    async def _job_loop(self, job: IngestionJob) -> None:
        beat = asyncio.create_task(self._heartbeat(job.id))
        try:
            outcome = await self._execute(job)
            await self._finish_outcome(job, outcome)
        except Exception as exc:  # noqa: BLE001
            error_class, retryable = classify_ingest_error(exc)
            try:
                row = await self.ledger.fail(job.id, self._worker_id, error_class=error_class, retryable=retryable)
                if row.status == "failed":
                    logger.info("[Ingest Alert] job_id=%s error_class=%s", job.id, error_class)
            except LeaseLost:
                pass
        finally:
            beat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await beat
            self._held_leases.discard(job.id)
            self._batch_jobs.discard(job.id)
            self._job_tasks.pop(job.id, None)

    async def _heartbeat(self, job_id: str) -> None:
        while True:
            await self.sleep(self.heartbeat_seconds)
            try:
                ok = await self.ledger.heartbeat(job_id, self._worker_id)
            except Exception:  # noqa: BLE001
                ok = False
            if not ok:
                task = self._job_tasks.get(job_id)
                if task is not None:
                    task.cancel()
                return

    async def _execute(self, job: IngestionJob) -> JobOutcome:
        if self.process_fn is not None:
            return await self.process_fn(job)
        deps = WorkerDeps(
            ledger=self.ledger,
            app=self.app,
            worker_id=self._worker_id,
            sleep=self.sleep,
            storage=self.storage,
            pool=self.pool,
            converter_factory=getattr(self.settings, "build_range_converter", None),
            page_cap=getattr(self.settings, "page_cap", None),
        )
        return await process_job(job, deps)

    async def _finish_outcome(self, job: IngestionJob, outcome: JobOutcome) -> None:
        if outcome.status in TERMINAL_SUCCESS:
            return
        if outcome.status == "lease_lost":
            return
        if outcome.error_class:
            retryable = outcome.error_class not in _PERMANENT
            try:
                row = await self.ledger.fail(
                    job.id, self._worker_id, error_class=outcome.error_class, retryable=retryable
                )
                if row.status == "failed":
                    logger.info("[Ingest Alert] job_id=%s error_class=%s", job.id, outcome.error_class)
            except LeaseLost:
                pass