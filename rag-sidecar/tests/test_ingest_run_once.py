"""run_once claims one named job, runs process_job and maps the outcome to an exit code."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from ingest_fakes import AppScript, FakeApp, FakeLedger
from rag_sidecar.contracts.queue import IngestionJob
from rag_sidecar.ingest.run_once import run_once

_JOB_ID = "00000000-0000-4000-8000-000000000001"
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_WORKER = "run-once-test"
_CACHE_ID = "00000000-0000-4000-8000-0000000000c1"


def _queued_job() -> IngestionJob:
    return IngestionJob.model_validate(
        {
            "id": _JOB_ID,
            "kind": "ingest",
            "status": "queued",
            "tenant_key": "u:00000000-0000-4000-8000-0000000000a1",
            "source": "config_upload",
            "source_key": "root/a.md",
            "file_sha256": "b" * 64,
            "mime_type": "text/markdown",
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


def test_a_claimed_job_that_reaches_ready_exits_zero():
    ledger = FakeLedger()
    ledger.seed(_queued_job())
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "done", "cache_id": _CACHE_ID})])
    app.script("advance", [AppScript(response={"worker_id": _WORKER, "stage": "ready", "done": True, "status": "ready"})])

    code = asyncio.run(run_once(_JOB_ID, ledger=ledger, app=app, worker_id=_WORKER))

    assert code == 0
    assert ledger.call_counts["claim_one"] == 1
    assert ledger.jobs[_JOB_ID].locked_by == _WORKER


def test_a_job_that_cannot_be_claimed_exits_two_and_calls_nothing():
    ledger = FakeLedger()
    app = FakeApp()
    code = asyncio.run(run_once(_JOB_ID, ledger=ledger, app=app, worker_id=_WORKER))
    assert code == 2
    assert app.calls == []


def test_a_failed_job_exits_one():
    ledger = FakeLedger()
    ledger.seed(_queued_job())
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "failed", "error_class": "no_parser_available"})])
    code = asyncio.run(run_once(_JOB_ID, ledger=ledger, app=app, worker_id=_WORKER))
    assert code == 1
