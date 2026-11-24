"""IngestWorker loop and PriorityPool behavior (plan 03.1-27)."""

from __future__ import annotations

import asyncio
import logging
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from ingest_fakes import FakeApp, FakeClock, FakeLedger
from rag_sidecar.contracts.queue import IngestionJob
from rag_sidecar.ingest.ledger_client import Transient
from rag_sidecar.ingest.pool import PoolCrashed, PriorityPool
from rag_sidecar.ingest.process_job import JobOutcome
from rag_sidecar.ingest.worker import IngestWorker, classify_ingest_error
from rag_sidecar.parse.converter import ConversionError

_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_WORKER = "worker-test"
_BATCH = "00000000-0000-4000-8000-0000000000b1"


class _SettingsStub:
    def __init__(self, concurrency: int = 2) -> None:
        self.ingest_worker_concurrency = concurrency
        self.worker_id = _WORKER


_SLOT_SETTINGS = _SettingsStub(concurrency=2)


def _job(*, job_id: str, batch_id: str | None = None, priority: int = 0) -> IngestionJob:
    return IngestionJob.model_validate(
        {
            "id": job_id,
            "kind": "ingest",
            "status": "queued",
            "tenant_key": "u:00000000-0000-4000-8000-0000000000a1",
            "source": "config_upload",
            "source_key": "root/a.md",
            "file_sha256": "b" * 64,
            "mime_type": "text/markdown",
            "batch_id": batch_id,
            "priority": priority,
            "settings": {
                "routing": "fixed",
                "cloud_allowed": True,
                "escalation": True,
                "progressive": False,
                "premium_max_pages_per_doc": 50,
                "premium_page_budget": 0,
                "vlm_detect": False,
                "profile_id": "general@1",
                "profile_version": 1,
                "doc_type": "general",
                "embed_mode": "sync",
                "ocr_languages": ["en"],
                "routing_config_version": "1",
            },
            "created_at": _NOW.isoformat(),
            "updated_at": _NOW.isoformat(),
        }
    )


class _AdvanceSleep:
    def __init__(self, clock: FakeClock, wake: asyncio.Event) -> None:
        self._clock = clock
        self._wake = wake

    async def __call__(self, seconds: float) -> None:
        deadline = self._clock.now() + timedelta(seconds=seconds)
        while self._clock.now() < deadline:
            if self._wake.is_set():
                self._wake.clear()
                return
            self._clock.advance(0.01)
            await asyncio.sleep(0)


async def _instant_sleep(_seconds: float) -> None:
    await asyncio.sleep(0)


def _clock_sleep(clock: FakeClock) -> Any:
    async def sleep(seconds: float) -> None:
        clock.advance(seconds)
        await asyncio.sleep(0)

    return sleep


def test_two_slots_claim_at_most_one_batch_job_when_only_batch_queued():
    async def run() -> None:
        ledger = FakeLedger()
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000001", batch_id=_BATCH))
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000002", batch_id=_BATCH))
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000003", batch_id=_BATCH))

        async def hang(_job: IngestionJob) -> JobOutcome:
            await asyncio.Event().wait()
            return JobOutcome(status="ready")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            FakeClock(),
            random.Random(0),
            process_fn=hang,
            sleep=_instant_sleep,
        )
        await worker._poll_once()
        active_batch = [
            j
            for j in ledger.jobs.values()
            if j.batch_id == _BATCH and j.status != "queued" and j.locked_by == _WORKER
        ]
        assert len(active_batch) == 1
        await worker.stop()

    asyncio.run(run())


def test_incremental_job_claimed_into_reserved_slot_after_batch():
    async def run() -> None:
        ledger = FakeLedger()
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000001", batch_id=_BATCH))

        async def hang(_job: IngestionJob) -> JobOutcome:
            await asyncio.Event().wait()
            return JobOutcome(status="ready")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            FakeClock(),
            random.Random(0),
            process_fn=hang,
            sleep=_instant_sleep,
        )
        await worker._poll_once()
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000010", batch_id=None, priority=10))
        await worker._poll_once()
        incremental = [
            j for j in ledger.jobs.values() if j.id.endswith("0010") and j.locked_by == _WORKER
        ]
        assert len(incremental) == 1
        await worker.stop()

    asyncio.run(run())


def test_wake_during_poll_sleep_triggers_claim_within_50_ms():
    async def run() -> None:
        clock = FakeClock()
        wake = asyncio.Event()
        ledger = FakeLedger(clock)
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000011"))

        async def finish(_job: IngestionJob) -> JobOutcome:
            return JobOutcome(status="ready")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            clock,
            random.Random(1),
            process_fn=finish,
            sleep=_AdvanceSleep(clock, wake),
            wake_event=wake,
        )
        t0 = time.monotonic()
        task = asyncio.create_task(worker._run_loop_once_for_test(poll_seconds=10.0))
        await asyncio.sleep(0)
        worker.wake()
        await task
        await worker.stop()
        assert time.monotonic() - t0 < 0.05
        assert ledger.call_counts.get("claim", 0) >= 1

    asyncio.run(run())


def test_heartbeat_loss_cancels_job_without_fail_or_advance():
    async def run() -> None:
        clock = FakeClock()
        ledger = FakeLedger(clock)
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000012"))
        beats = {"n": 0}

        async def heartbeat(job_id: str, worker: str) -> bool:
            beats["n"] += 1
            return beats["n"] < 2

        ledger.heartbeat = heartbeat  # type: ignore[method-assign]

        async def slow(_job: IngestionJob) -> JobOutcome:
            for _ in range(5):
                await asyncio.sleep(0)
            return JobOutcome(status="ready")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            clock,
            random.Random(2),
            process_fn=slow,
            sleep=_clock_sleep(clock),
            heartbeat_seconds=40.0,
        )
        await worker._poll_once()
        await worker.stop()
        assert ledger.call_counts.get("fail", 0) == 0
        assert ledger.call_counts.get("advance", 0) == 0

    asyncio.run(run())


def test_retryable_error_calls_fail_with_retryable_true():
    async def run() -> None:
        ledger = FakeLedger()
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000013"))

        async def boom(_job: IngestionJob) -> JobOutcome:
            raise Transient("network")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            FakeClock(),
            random.Random(3),
            process_fn=boom,
            sleep=_instant_sleep,
        )
        await worker._poll_once()
        await worker.stop()
        row = ledger.jobs["00000000-0000-4000-8000-000000000013"]
        assert row.status == "queued"
        assert ledger.call_counts.get("fail", 0) == 1

    asyncio.run(run())


def test_encrypted_pdf_is_permanent_fail():
    async def run() -> None:
        ledger = FakeLedger()
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000014"))

        async def encrypted(_job: IngestionJob) -> JobOutcome:
            raise ConversionError("encrypted_pdf")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            FakeClock(),
            random.Random(4),
            process_fn=encrypted,
            sleep=_instant_sleep,
        )
        await worker._poll_once()
        await worker.stop()
        row = ledger.jobs["00000000-0000-4000-8000-000000000014"]
        assert row.status == "failed"
        error_class, retryable = classify_ingest_error(ConversionError("encrypted_pdf"))
        assert error_class == "encrypted_pdf"
        assert retryable is False

    asyncio.run(run())


def test_ingest_alert_logged_only_on_terminal_failure(caplog):
    caplog.set_level(logging.INFO)

    async def run() -> None:
        ledger = FakeLedger()
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000015"))

        async def permanent(_job: IngestionJob) -> JobOutcome:
            raise ConversionError("encrypted_pdf")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            FakeClock(),
            random.Random(5),
            process_fn=permanent,
            sleep=_instant_sleep,
        )
        await worker._poll_once()
        await worker.stop()

    asyncio.run(run())
    alerts = [r for r in caplog.records if "[Ingest Alert]" in r.getMessage()]
    assert len(alerts) == 1
    assert "encrypted_pdf" in alerts[0].getMessage()
    assert "root/" not in alerts[0].getMessage()


def test_stop_releases_held_leases_after_wait():
    async def run() -> None:
        ledger = FakeLedger()
        ledger.seed(_job(job_id="00000000-0000-4000-8000-000000000016"))

        async def hang(_job: IngestionJob) -> JobOutcome:
            await asyncio.Event().wait()
            return JobOutcome(status="ready")

        worker = IngestWorker(
            _SLOT_SETTINGS,
            ledger,
            None,
            FakeApp(),
            None,
            FakeClock(),
            random.Random(6),
            process_fn=hang,
            sleep=_instant_sleep,
        )
        await worker._poll_once()
        assert any(j.locked_by == _WORKER for j in ledger.jobs.values())
        await worker.stop()
        assert ledger.call_counts.get("release", 0) >= 1

    asyncio.run(run())


def test_upload_priority_runs_before_queued_backfill():
    async def run() -> None:
        order: list[str] = []

        def backfill_slow() -> str:
            time.sleep(0.05)
            order.append("backfill")
            return "backfill"

        def upload_fast() -> str:
            order.append("upload")
            return "upload"

        loop = asyncio.get_running_loop()
        pool = PriorityPool(workers=1, loop=loop)
        pool.start()
        first = pool.submit(backfill_slow, (), priority=0, deadline_s=30.0)
        await asyncio.sleep(0.02)
        upload = pool.submit(upload_fast, (), priority=100, deadline_s=30.0)
        for _ in range(9):
            pool.submit(backfill_slow, (), priority=0, deadline_s=30.0)
        await upload
        await first
        await pool.stop()
        assert order[0] == "backfill"
        assert order[1] == "upload"

    asyncio.run(run())


def test_equal_priority_fifo():
    async def run() -> None:
        order: list[int] = []

        def work(n: int) -> int:
            order.append(n)
            return n

        loop = asyncio.get_running_loop()
        pool = PriorityPool(workers=1, loop=loop)
        pool.start()
        tasks = [pool.submit(work, (i,), priority=50, deadline_s=10.0) for i in range(3)]
        await asyncio.gather(*tasks)
        await pool.stop()
        assert order == [0, 1, 2]

    asyncio.run(run())


def test_pool_crashed_is_retryable_and_pool_recovers():
    async def run() -> None:
        calls = {"n": 0}

        def flaky() -> str:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("worker died")
            return "ok"

        loop = asyncio.get_running_loop()
        pool = PriorityPool(workers=1, loop=loop)
        pool.start()
        with pytest.raises(PoolCrashed):
            await pool.submit(flaky, (), priority=0, deadline_s=5.0)
        assert await pool.submit(flaky, (), priority=0, deadline_s=5.0) == "ok"
        await pool.stop()

    asyncio.run(run())