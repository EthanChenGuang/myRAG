"""process_job under fixed routing: parse-external in chain mode, one fixed_chain attempt, advance until done."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from ingest_fakes import AppScript, FakeApp, FakeLedger
from rag_sidecar.contracts.queue import (
    AdvanceRequest,
    AdvanceResponse,
    IngestionJob,
    ParseExternalRequest,
    ParseExternalResponse,
)
from rag_sidecar.ingest.app_client import AppAuthError, AppTransientError
from rag_sidecar.ingest.ledger_client import LeaseLost
from rag_sidecar.ingest.process_job import TERMINAL_SUCCESS, JobOutcome, WorkerDeps, process_job

_JOB_ID = "00000000-0000-4000-8000-000000000001"
_TENANT = "u:00000000-0000-4000-8000-0000000000a1"
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_WORKER = "worker-test"
_CACHE_ID = "00000000-0000-4000-8000-0000000000c1"


def _settings(routing: str = "fixed") -> dict:
    return {
        "routing": routing,
        "cloud_allowed": True,
        "escalation": True,
        "progressive": False,
        "premium_max_pages_per_doc": 50,
        "premium_page_budget": 0,
        "vlm_detect": False,
        "profile_id": "general@1",
        "profile_version": 1,
        "doc_type": "general",
        "min_tier": "fast",
        "max_tier": "premium",
        "embed_mode": "sync",
        "ocr_languages": ["en", "zh"],
        "routing_config_version": "1",
    }


def _job(routing: str = "fixed") -> IngestionJob:
    return IngestionJob.model_validate(
        {
            "id": _JOB_ID,
            "kind": "ingest",
            "status": "preflight",
            "tenant_key": _TENANT,
            "source": "config_upload",
            "source_key": "root/handbook.pdf",
            "file_sha256": "a" * 64,
            "mime_type": "application/pdf",
            "original_ref": {"bucket": "rag-originals", "path": f"{_TENANT}/lineage/1/original.pdf"},
            "settings": _settings(routing),
            "locked_by": _WORKER,
            "lease_until": (_NOW + timedelta(hours=1)).isoformat(),
            "created_at": _NOW.isoformat(),
            "updated_at": _NOW.isoformat(),
        }
    )


def _done(cache_id: str = _CACHE_ID) -> dict:
    return {"worker_id": _WORKER, "status": "done", "cache_id": cache_id}


def _advance(stage: str, done: bool, **extra: object) -> dict:
    return {"worker_id": _WORKER, "stage": stage, "done": done, **extra}


class Sleeps:
    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _deps(ledger: FakeLedger, app: object, sleeps: Sleeps | None = None) -> WorkerDeps:
    return WorkerDeps(ledger=ledger, app=app, worker_id=_WORKER, sleep=sleeps or Sleeps())


def _claimed(ledger: FakeLedger, routing: str = "fixed") -> IngestionJob:
    job = _job(routing)
    ledger.seed(job)
    ledger.jobs[job.id] = ledger.jobs[job.id].model_copy(
        update={"locked_by": _WORKER, "lease_until": ledger.clock.now() + timedelta(hours=1)}
    )
    return ledger.jobs[job.id]


def test_fixed_job_parses_in_chain_mode_records_one_fixed_chain_attempt_and_advances_until_done():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script(
        "advance",
        [
            AppScript(response=_advance("content_hash_dedup", False)),
            AppScript(response=_advance("embed", False)),
            AppScript(response=_advance("ready", True, status="ready")),
        ],
    )

    outcome = asyncio.run(process_job(job, _deps(ledger, app)))

    assert outcome == JobOutcome(status="ready")
    parse_calls = [call for call in app.calls if call[0] == "parse_external"]
    assert len(parse_calls) == 1
    body = parse_calls[0][2]
    assert body["mode"] == "chain"
    assert body["worker_id"] == _WORKER
    assert body["attempt_no"] == 1
    assert len(body["options_hash"]) == 64
    assert body["pages"] is None and body["subpdf_ref"] is None

    attempts = ledger.jobs[_JOB_ID].attempts
    assert [attempt.reason for attempt in attempts] == ["fixed_chain"]
    assert attempts[0].refused is False and attempts[0].cache_hit is False

    advance_calls = [call[2] for call in app.calls if call[0] == "advance"]
    assert [call["cursor"] for call in advance_calls] == [None, "content_hash_dedup", "embed"]
    assert {call["phase"] for call in advance_calls} == {"post_parse"}
    assert {call["parse_cache_id"] for call in advance_calls} == {_CACHE_ID}
    assert all(call["deadline_ms"] <= 40_000 for call in advance_calls)
    assert ledger.call_counts.get("fail") is None


def test_options_hash_is_stable_for_the_same_job_settings():
    ledger = FakeLedger()
    job = _claimed(ledger)
    hashes = []
    for _ in range(2):
        app = FakeApp()
        app.script("parse_external", [AppScript(response=_done())])
        app.script("advance", [AppScript(response=_advance("ready", True, status="ready"))])
        asyncio.run(process_job(job, _deps(ledger, app)))
        hashes.append(app.calls[0][2]["options_hash"])
    assert hashes[0] == hashes[1]


def test_a_pending_parse_waits_and_continues_with_the_same_attempt():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script(
        "parse_external",
        [
            AppScript(response={"worker_id": _WORKER, "status": "pending", "continuation": "c-1", "retry_after_ms": 1500}),
            AppScript(response=_done()),
        ],
    )
    app.script("advance", [AppScript(response=_advance("ready", True, status="ready"))])
    sleeps = Sleeps()

    outcome = asyncio.run(process_job(job, _deps(ledger, app, sleeps)))

    assert outcome.status == "ready"
    parse_calls = [call[2] for call in app.calls if call[0] == "parse_external"]
    assert [call["continuation"] for call in parse_calls] == [None, "c-1"]
    assert sleeps.calls == [1.5]
    assert len(ledger.jobs[_JOB_ID].attempts) == 1


def test_advance_wait_ms_is_honoured_between_calls():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script(
        "advance",
        [
            AppScript(response=_advance("embed", False, wait_ms=250)),
            AppScript(response=_advance("ready", True, status="ready")),
        ],
    )
    sleeps = Sleeps()
    asyncio.run(process_job(job, _deps(ledger, app, sleeps)))
    assert sleeps.calls == [0.25]


@pytest.mark.parametrize("reason", ["cloud_not_allowed", "budget_exhausted"])
def test_a_refused_parse_fails_the_job_without_retry(reason):
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "refused", "reason": reason})])

    outcome = asyncio.run(process_job(job, _deps(ledger, app)))

    assert outcome == JobOutcome(status="failed", error_class=reason)
    stored = ledger.jobs[_JOB_ID]
    assert stored.status == "failed" and stored.retries == 1 and stored.error_class == reason
    assert not [call for call in app.calls if call[0] == "advance"]


def test_a_failed_parse_with_a_permanent_class_is_not_retried():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "failed", "error_class": "no_parser_available"})])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="failed", error_class="no_parser_available")
    assert ledger.jobs[_JOB_ID].status == "failed"


def test_a_failed_parse_with_another_class_is_requeued_for_retry():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "failed", "error_class": "parse_timeout"})])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="queued", error_class="parse_timeout")
    assert ledger.jobs[_JOB_ID].status == "queued"


class RaisingApp:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls = 0

    async def parse_external(self, job_id: str, request: ParseExternalRequest) -> ParseExternalResponse:
        self.calls += 1
        raise self.error

    async def advance(self, job_id: str, request: AdvanceRequest) -> AdvanceResponse:
        raise self.error


def test_a_transient_callback_error_requeues_the_job():
    ledger = FakeLedger()
    job = _claimed(ledger)
    outcome = asyncio.run(process_job(job, _deps(ledger, RaisingApp(AppTransientError("callback timeout")))))
    assert outcome == JobOutcome(status="queued", error_class="callback_transient")
    assert ledger.jobs[_JOB_ID].status == "queued"


def test_a_rejected_secret_fails_the_job_without_retry():
    ledger = FakeLedger()
    job = _claimed(ledger)
    outcome = asyncio.run(process_job(job, _deps(ledger, RaisingApp(AppAuthError("callback unauthorized")))))
    assert outcome == JobOutcome(status="failed", error_class="callback_unauthorized")


def test_a_lost_lease_stops_the_job_without_touching_the_ledger():
    ledger = FakeLedger()
    job = _claimed(ledger)
    outcome = asyncio.run(process_job(job, _deps(ledger, RaisingApp(LeaseLost("lease_lost")))))
    assert outcome == JobOutcome(status="lease_lost")
    assert ledger.call_counts.get("fail") is None


def test_a_tiered_pdf_job_on_a_worker_without_storage_fails_at_once_and_calls_nothing():
    ledger = FakeLedger()
    job = _claimed(ledger, routing="tiered")
    app = FakeApp()
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="failed", error_class="worker_not_configured")
    assert app.calls == []


def test_a_terminal_status_from_advance_ends_the_loop_without_failing_the_job_twice():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script("advance", [AppScript(response=_advance("failed", True, status="failed", reason="embed_failed"))])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="failed", error_class="embed_failed")
    assert ledger.call_counts.get("fail") is None


def test_a_skipped_duplicate_is_a_terminal_non_failure():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script("advance", [AppScript(response=_advance("skipped_duplicate", True, status="skipped_duplicate"))])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="skipped_duplicate")


def test_a_pending_review_is_a_terminal_non_failure():
    """A held upload (D-36) ends pending_review: processing is finished, the hold is the document status (research F-15)."""
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script("advance", [AppScript(response=_advance("pending_review", True, status="pending_review", reason="held_for_review"))])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="pending_review")
    assert "pending_review" in TERMINAL_SUCCESS
    assert ledger.call_counts.get("fail") is None


_BATCH_ID = "00000000-0000-4000-8000-0000000000b9"
_DOC_ID = "00000000-0000-4000-8000-0000000000d1"


def _claimed_backfill(ledger: FakeLedger, *, kind: str = "ingest", routing: str = "fixed", document_id: str | None = None) -> IngestionJob:
    job = _job(routing).model_copy(update={"batch_id": _BATCH_ID, "kind": kind, "document_id": document_id, "priority": 10})
    ledger.seed(job)
    ledger.jobs[job.id] = ledger.jobs[job.id].model_copy(
        update={"locked_by": _WORKER, "lease_until": ledger.clock.now() + timedelta(hours=1)}
    )
    return ledger.jobs[job.id]


def test_begin_a_backfill_job_without_a_document_row_calls_begin_before_parsing():
    ledger = FakeLedger()
    job = _claimed_backfill(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script(
        "advance",
        [AppScript(response=_advance("preflight", False)), AppScript(response=_advance("ready", True, status="ready"))],
    )

    outcome = asyncio.run(process_job(job, _deps(ledger, app)))

    assert outcome == JobOutcome(status="ready")
    assert [call[0] for call in app.calls] == ["advance", "parse_external", "advance"]
    begin = app.calls[0][2]
    assert begin["phase"] == "begin"
    assert begin["parse_cache_id"] is None and begin["cursor"] is None
    assert app.calls[2][2]["phase"] == "post_parse"


def test_begin_a_duplicate_at_begin_ends_the_job_without_parsing():
    ledger = FakeLedger()
    job = _claimed_backfill(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script("advance", [AppScript(response=_advance("skipped_duplicate", True, status="skipped_duplicate"))])

    outcome = asyncio.run(process_job(job, _deps(ledger, app)))

    assert outcome == JobOutcome(status="skipped_duplicate")
    assert [call[0] for call in app.calls] == ["advance"]
    assert ledger.jobs[_JOB_ID].attempts == []


def test_begin_a_failed_begin_reports_its_reason_without_parsing():
    ledger = FakeLedger()
    job = _claimed_backfill(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script("advance", [AppScript(response=_advance("failed", True, status="failed", reason="original_unavailable"))])

    outcome = asyncio.run(process_job(job, _deps(ledger, app)))

    assert outcome == JobOutcome(status="failed", error_class="original_unavailable")
    assert [call[0] for call in app.calls] == ["advance"]


def test_begin_is_not_called_for_a_backfill_job_that_already_has_its_document():
    ledger = FakeLedger()
    job = _claimed_backfill(ledger, document_id=_DOC_ID)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script("advance", [AppScript(response=_advance("ready", True, status="ready"))])

    outcome = asyncio.run(process_job(job, _deps(ledger, app)))

    assert outcome == JobOutcome(status="ready")
    assert {call[2]["phase"] for call in app.calls if call[0] == "advance"} == {"post_parse"}


def test_begin_is_not_called_for_an_incremental_job():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("parse_external", [AppScript(response=_done())])
    app.script("advance", [AppScript(response=_advance("ready", True, status="ready"))])

    asyncio.run(process_job(job, _deps(ledger, app)))

    assert {call[2]["phase"] for call in app.calls if call[0] == "advance"} == {"post_parse"}


def test_begin_dry_run_jobs_never_call_begin(monkeypatch):
    import sys
    import types

    async def _stub(job: IngestionJob, deps: WorkerDeps) -> JobOutcome:
        return JobOutcome(status="ready")

    # The tiered module needs the preflight extra; the dry run only has to reach it without a begin call.
    monkeypatch.setitem(sys.modules, "rag_sidecar.ingest.tiered", types.SimpleNamespace(run_tiered=_stub))
    ledger = FakeLedger()
    job = _claimed_backfill(ledger, kind="dry_run", routing="tiered")
    app = FakeApp()

    outcome = asyncio.run(process_job(job, _deps(ledger, app)))

    assert outcome == JobOutcome(status="ready")
    assert app.calls == []
