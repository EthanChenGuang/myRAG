"""Jobs of kind translate (plan 03.2-50, D-29): the worker claims them and calls the app back; it never parses or reads storage."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from pydantic import SecretStr

from ingest_fakes import AppScript, FakeApp, FakeLedger, FakeStorage
from rag_sidecar.contracts.queue import IngestionJob, TranslateCallbackRequest
from rag_sidecar.ingest.app_client import AppAuthError, AppClient, AppTransientError
from rag_sidecar.ingest.process_job import TRANSLATE_DEADLINE_MS, JobOutcome, WorkerDeps, process_job

_JOB_ID = "00000000-0000-4000-8000-000000000051"
_DOC_ID = "00000000-0000-4000-8000-0000000000d1"
_TENANT = "u:00000000-0000-4000-8000-0000000000a1"
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_WORKER = "worker-test"
_APP_URL = "https://app.example"


def _settings(routing: str = "fixed", **extra: object) -> dict:
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
        "embed_mode": "sync",
        "ocr_languages": ["en"],
        "routing_config_version": "1",
        **extra,
    }


def _job(kind: str = "translate", routing: str = "fixed") -> IngestionJob:
    translate = kind == "translate"
    return IngestionJob.model_validate(
        {
            "id": _JOB_ID,
            "kind": kind,
            "status": "embedding" if translate else "preflight",
            "tenant_key": _TENANT,
            "document_id": _DOC_ID,
            "source": "post_publish" if translate else "config_upload",
            "source_key": f"translate:{_DOC_ID}:en" if translate else "root/notes.pdf",
            "file_sha256": None if translate else "a" * 64,
            "mime_type": None if translate else "application/pdf",
            "original_ref": None if translate else {"bucket": "rag-originals", "path": f"{_TENANT}/lineage/1/original.pdf"},
            "settings": _settings(routing, **({"target_language": "en"} if translate else {})),
            "locked_by": _WORKER,
            "lease_until": (_NOW + timedelta(hours=1)).isoformat(),
            "created_at": _NOW.isoformat(),
            "updated_at": _NOW.isoformat(),
        }
    )


def _claimed(ledger: FakeLedger, kind: str = "translate", routing: str = "fixed") -> IngestionJob:
    job = _job(kind, routing)
    ledger.seed(job)
    ledger.jobs[job.id] = ledger.jobs[job.id].model_copy(
        update={"locked_by": _WORKER, "lease_until": ledger.clock.now() + timedelta(hours=1)}
    )
    return ledger.jobs[job.id]


class Sleeps:
    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _deps(ledger: FakeLedger, app: object, storage: FakeStorage | None = None) -> WorkerDeps:
    return WorkerDeps(ledger=ledger, app=app, worker_id=_WORKER, sleep=Sleeps(), storage=storage)


def _reply(outcome: str, **extra: object) -> dict:
    return {"worker_id": _WORKER, "outcome": outcome, **extra}


def _actions(app: FakeApp) -> list[str]:
    return [call[0] for call in app.calls]


def test_a_translate_job_makes_one_callback_and_takes_its_terminal_status_from_the_answer():
    ledger = FakeLedger()
    storage = FakeStorage()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("translate", [AppScript(response=_reply("done", status="ready", remaining=0))])
    outcome = asyncio.run(process_job(job, _deps(ledger, app, storage)))
    assert outcome == JobOutcome(status="ready")
    assert app.calls == [("translate", _JOB_ID, {"worker_id": _WORKER, "deadline_ms": TRANSLATE_DEADLINE_MS})]
    assert storage.calls == []
    for name in ("record_attempt", "cache_lookup", "cache_put", "fail", "advance"):
        assert ledger.call_counts.get(name) is None, name


def test_the_translate_branch_runs_before_routing_so_a_tiered_snapshot_still_never_parses():
    ledger = FakeLedger()
    job = _claimed(ledger, routing="tiered")
    app = FakeApp()
    app.script("translate", [AppScript(response=_reply("done", status="ready"))])
    outcome = asyncio.run(process_job(job, _deps(ledger, app, FakeStorage())))
    assert outcome == JobOutcome(status="ready")
    assert _actions(app) == ["translate"]


def test_a_callback_out_of_time_is_called_again_until_done():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script(
        "translate",
        [
            AppScript(response=_reply("continue", remaining=7, reason="time_budget")),
            AppScript(response=_reply("continue", remaining=3, reason="time_budget")),
            AppScript(response=_reply("done", status="ready", remaining=0)),
        ],
    )
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="ready")
    assert _actions(app) == ["translate", "translate", "translate"]
    assert ledger.call_counts.get("fail") is None


def test_a_continuation_that_makes_no_progress_fails_the_job_retryably():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script(
        "translate",
        [
            AppScript(response=_reply("continue", remaining=4, reason="time_budget")),
            AppScript(response=_reply("continue", remaining=4, reason="time_budget")),
        ],
    )
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="queued", error_class="translate_no_progress")
    assert ledger.jobs[_JOB_ID].status == "queued"


def test_a_retry_answer_fails_the_job_retryably_and_the_limit_ends_it_failed():
    ledger = FakeLedger()
    app = FakeApp()
    app.script("translate", [AppScript(response=_reply("retry", reason="model_unavailable"))])
    statuses: list[str] = []
    for _ in range(4):
        job = ledger.jobs.get(_JOB_ID)
        if job is None:
            job = _claimed(ledger)
        else:
            job = job.model_copy(update={"status": "embedding", "locked_by": _WORKER, "lease_until": ledger.clock.now() + timedelta(hours=1)})
            ledger.jobs[_JOB_ID] = job
        outcome = asyncio.run(process_job(job, _deps(ledger, app)))
        assert outcome.error_class == "translate_model_unavailable"
        statuses.append(outcome.status)
    assert statuses == ["queued", "queued", "queued", "failed"]
    assert ledger.jobs[_JOB_ID].retries == 4


def test_an_unknown_retry_reason_is_recorded_under_one_fixed_error_class():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("translate", [AppScript(response=_reply("retry", reason="something else entirely"))])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="queued", error_class="translate_failed")


def test_a_done_answer_with_a_failed_status_is_reported_without_failing_the_job_twice():
    ledger = FakeLedger()
    job = _claimed(ledger)
    app = FakeApp()
    app.script("translate", [AppScript(response=_reply("done", status="failed", reason="invalid_job"))])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="failed", error_class="invalid_job")
    assert ledger.call_counts.get("fail") is None


class RaisingApp:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls = 0

    async def translate(self, *_: object) -> None:
        self.calls += 1
        raise self.error


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (AppTransientError("callback timeout"), JobOutcome(status="queued", error_class="callback_transient")),
        (AppAuthError("callback unauthorized"), JobOutcome(status="failed", error_class="callback_unauthorized")),
    ],
)
def test_callback_transport_errors_follow_the_existing_rules(error: Exception, expected: JobOutcome):
    ledger = FakeLedger()
    job = _claimed(ledger)
    outcome = asyncio.run(process_job(job, _deps(ledger, RaisingApp(error))))
    assert outcome == expected


def test_other_kinds_take_the_existing_path_and_never_call_translate():
    ledger = FakeLedger()
    job = _claimed(ledger, kind="ingest")
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "done", "cache_id": "c" * 8})])
    app.script("advance", [AppScript(response={"worker_id": _WORKER, "stage": "ready", "done": True, "status": "ready"})])
    outcome = asyncio.run(process_job(job, _deps(ledger, app)))
    assert outcome == JobOutcome(status="ready")
    assert "translate" not in _actions(app)
    assert _actions(app)[0] == "parse_external"


def test_app_client_posts_the_translate_callback_with_the_secret_and_no_tenant():
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_reply("done", status="ready", remaining=0))

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=_APP_URL)
        app = AppClient(app_base_url=_APP_URL, secret=SecretStr("s" * 32), client=client, rate_per_second=100)
        try:
            return await app.translate(_JOB_ID, TranslateCallbackRequest(worker_id=_WORKER, deadline_ms=1000))
        finally:
            await app.aclose()

    response = asyncio.run(run())
    assert response.outcome == "done"
    assert len(seen) == 1
    assert seen[0].url.path == f"/api/internal/rag/ingest/jobs/{_JOB_ID}/translate"
    assert seen[0].headers["x-sidecar-secret"] == "s" * 32
    assert json.loads(seen[0].content) == {"worker_id": _WORKER, "deadline_ms": 1000}
    assert seen[0].extensions["timeout"]["read"] == 55.0, "a slice may finish its chunk in flight after half the deadline"


@pytest.mark.parametrize(("status", "error"), [(401, AppAuthError), (409, AppTransientError), (404, AppTransientError)])
def test_app_client_maps_translate_refusals(status: int, error: type[Exception]):
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": "refused"})

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=_APP_URL)
        app = AppClient(app_base_url=_APP_URL, secret=SecretStr("s" * 32), client=client, rate_per_second=100)
        try:
            with pytest.raises(error):
                await app.translate(_JOB_ID, TranslateCallbackRequest(worker_id=_WORKER, deadline_ms=1000))
        finally:
            await app.aclose()

    asyncio.run(run())


def test_the_request_body_has_no_tenant_field():
    assert not {"tenant", "tenant_key", "document_id", "target_language"}.intersection(TranslateCallbackRequest.model_fields)
